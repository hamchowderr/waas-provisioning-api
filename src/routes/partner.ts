import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { withTransaction } from '../db.ts';
import { badRequest, HttpError } from '../errors.ts';
import { compact, readJson, requiredUuidQuery, uuidQuery } from '../http.ts';
import { validateBody } from '../openapi.ts';
import { enqueue } from '../queue.ts';
import { Status, statusName } from '../status.ts';
import { versionService } from './versions.ts';

/**
 * Calls only a partner key can make (docs/resellers.md): its reseller account, which the contract
 * calls a subscription, the account's storefronts (products), making and removing them, and usage.
 * Other callers get 403. These need no productId; on every other /v1 route a partner key names the
 * storefront with it (src/app.ts).
 */

/** Paths a partner key calls without a productId. */
export const PARTNER_ONLY = /^\/v1\/(subscriptions|products)(\/|$)/;
/** Template paths, where a partner key without a productId works on the reseller's shared templates. */
export const SHARED_TEMPLATES = /^\/v1\/basesnapshots(\/|$)/;

interface CreateProductParams {
  name: string;
  version?: Record<string, unknown>;
}

/** A required ISO 8601 date-time query. */
function dateQuery(c: Context, name: string): Date {
  const value = c.req.query(name);
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw badRequest(`${name} must be an ISO 8601 date-time`);
  return date;
}

/** Hours a thing that existed from `start` to `end` (null: still exists) overlaps $2 to $3. */
const overlapSeconds = (start: string, end: string) =>
  `greatest(0, extract(epoch FROM least(coalesce(${end}, now()), $3) - greatest(${start}, $2)))`;
const hours = (seconds: number | null) => Math.round(((seconds ?? 0) / 3600) * 100) / 100;

export function partnerRoutes(deps: Deps) {
  const { pool } = deps;
  const versions = versionService(deps);
  const app = new Hono<AppEnv>();

  function reseller(c: Context<AppEnv>): string {
    const id = c.get('resellerId');
    if (!id) throw new HttpError(403, 'Only a partner key can call this');
    return id;
  }

  // The partner's own account, as a list of one (or none when the filters leave it out).
  app.get('/subscriptions', async (c) => {
    const { rows } = await pool.query(
      `SELECT id, name FROM resellers
        WHERE id = $1 AND ($2::uuid IS NULL OR id = $2) AND ($3::text IS NULL OR name = $3)`,
      [reseller(c), uuidQuery(c, 'subscriptionId') ?? null, c.req.query('name') ?? null],
    );
    return c.json(rows.map((r) => ({ id: r.id, name: r.name })));
  });

  // The account's storefronts. A storefront is ready as soon as it exists, so its status is Done.
  app.get('/products', async (c) => {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, r.id AS reseller_id, r.name AS reseller_name FROM products p JOIN resellers r ON r.id = p.reseller_id
        WHERE r.id = $1 AND ($2::uuid IS NULL OR r.id = $2) AND ($3::uuid IS NULL OR p.id = $3) AND ($4::text IS NULL OR p.name = $4)
        ORDER BY p.name, p.id`,
      [reseller(c), uuidQuery(c, 'subscriptionId') ?? null, uuidQuery(c, 'productId') ?? null, c.req.query('productName') ?? null],
    );
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        subscriptionId: r.reseller_id,
        subscriptionName: r.reseller_name,
        statusCode: Status.Done,
        statusName: statusName(Status.Done),
      })),
    );
  });

  // A new storefront in the account, within its maxProducts, with an optional first version that
  // becomes its production version. The partner key works on it at once; it needs no key of its own.
  app.post('/products', async (c) => {
    const resellerId = reseller(c);
    if (requiredUuidQuery(c, 'subscriptionId') !== resellerId) throw new HttpError(403, 'subscriptionId is not this partner\'s account');
    const body = validateBody<CreateProductParams>('CreateProductParams', await readJson(c));
    const name = body.name.trim();
    if (!name || name.length > 100) throw badRequest('name is required, at most 100 characters');
    const productId = await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ max_products: number | null }>('SELECT max_products FROM resellers WHERE id = $1 FOR UPDATE', [resellerId]);
      const max = rows[0]?.max_products ?? null;
      if (max !== null) {
        const { rows: count } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM products WHERE reseller_id = $1', [resellerId]);
        if (count[0]!.n >= max) throw badRequest(`This account has reached its limit of ${max} storefront${max === 1 ? '' : 's'}`);
      }
      const { rows: made } = await client.query<{ id: string }>('INSERT INTO products (name, reseller_id) VALUES ($1, $2) RETURNING id', [name, resellerId]);
      return made[0]!.id;
    });
    if (!body.version) return c.json({ id: productId, name });
    try {
      const { id, domainName, wordPressVersion, phpVersion, uploadUrl } = await versions.create(productId, body.version);
      await pool.query('UPDATE versions SET is_production = true WHERE id = $1', [id]);
      return c.json({ id: productId, name, version: compact({ id, domainName, wordPressVersion, phpVersion, uploadUrl }) });
    } catch (err) {
      // A bad version leaves no storefront behind.
      await pool.query('DELETE FROM products WHERE id = $1', [productId]);
      throw err;
    }
  });

  // Removes a storefront with no stores left, so a mistake can't take live sites down. Its versions and
  // own templates are removed in the background. Its usage history stays.
  app.delete('/products', async (c) => {
    const resellerId = reseller(c);
    const productId = requiredUuidQuery(c, 'productId');
    await withTransaction(pool, async (client) => {
      const { rows } = await client.query('SELECT 1 FROM products WHERE id = $1 AND reseller_id = $2 FOR UPDATE', [productId, resellerId]);
      if (!rows[0]) throw new HttpError(403, `Product ${productId} is not one of this partner's storefronts`);
      const { rows: stores } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM tenants WHERE product_id = $1', [productId]);
      const n = stores[0]!.n;
      if (n) throw badRequest(`This storefront still has ${n} store${n === 1 ? '' : 's'}; remove ${n === 1 ? 'it' : 'them'} first`);
      const { rows: building } = await client.query('SELECT 1 FROM versions WHERE product_id = $1 AND status = $2', [productId, Status.Pending]);
      if (building.length) throw badRequest('A version of this storefront is still building; try again once it is done');
      const { rows: owned } = await client.query<{ id: string }>('SELECT id FROM versions WHERE product_id = $1', [productId]);
      for (const v of owned) await enqueue(deps.boss, client, { type: 'version.delete', versionId: v.id });
      const { rows: templates } = await client.query<{ id: string }>('SELECT id FROM base_snapshots WHERE product_id = $1', [productId]);
      for (const t of templates) await enqueue(deps.boss, client, { type: 'basesnapshot.delete', baseSnapshotId: t.id });
      await client.query('DELETE FROM products WHERE id = $1', [productId]);
    });
    return c.json({ productId });
  });

  /**
   * Hours between startDate and endDate: storefronts and versions that exist now, from when they were
   * made, and stores from the usage ledger (removed ones too).
   */
  async function usage(scope: { resellerId: string } | { productId: string }, from: Date, to: Date) {
    if (to <= from) throw badRequest('endDate must be after startDate');
    const byReseller = 'resellerId' in scope;
    const id = byReseller ? scope.resellerId : scope.productId;
    const products = byReseller ? 'p.reseller_id = $1' : 'p.id = $1';
    const { rows } = await pool.query<{ product_s: number | null; version_s: number | null; tenant_s: number | null }>(
      `SELECT
         (SELECT sum(${overlapSeconds('p.created_at', 'NULL')}) FROM products p WHERE ${products})::float AS product_s,
         (SELECT sum(${overlapSeconds('v.date_created', 'NULL')}) FROM versions v JOIN products p ON p.id = v.product_id WHERE ${products})::float AS version_s,
         (SELECT sum(${overlapSeconds('tp.started_at', 'tp.ended_at')}) FROM tenant_periods tp
           WHERE ${byReseller ? 'tp.reseller_id' : 'tp.product_id'} = $1)::float AS tenant_s`,
      [id, from, to],
    );
    const r = rows[0]!;
    return { productHours: hours(r.product_s), versionHours: hours(r.version_s), tenantHours: hours(r.tenant_s) };
  }

  app.get('/subscriptions/usage', async (c) => {
    const resellerId = reseller(c);
    if (requiredUuidQuery(c, 'subscriptionId') !== resellerId) throw new HttpError(403, 'subscriptionId is not this partner\'s account');
    return c.json({ subscriptionId: resellerId, ...(await usage({ resellerId }, dateQuery(c, 'startDate'), dateQuery(c, 'endDate'))) });
  });

  app.get('/products/usage', async (c) => {
    const resellerId = reseller(c);
    const productId = requiredUuidQuery(c, 'productId');
    const { rowCount } = await pool.query('SELECT 1 FROM products WHERE id = $1 AND reseller_id = $2', [productId, resellerId]);
    if (!rowCount) throw new HttpError(403, `Product ${productId} is not one of this partner's storefronts`);
    return c.json({ productId, ...(await usage({ productId }, dateQuery(c, 'startDate'), dateQuery(c, 'endDate'))) });
  });

  return app;
}

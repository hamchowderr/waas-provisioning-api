import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { withTransaction } from '../db.ts';
import { badRequest } from '../errors.ts';
import { booleanQuery, compact, readJson, requiredUuidQuery, uuidQuery } from '../http.ts';
import { validateBody } from '../openapi.ts';
import { enqueue } from '../queue.ts';

interface CreateBaseSnapshotParams {
  name: string;
  comment: string;
  isTenantSnapshot?: boolean;
  groupName?: string;
  showInConsole?: boolean;
}

const NAME = /^[A-Za-z0-9 -]{5,50}$/;

/**
 * Base snapshots (templates). Phase 2 operations that product keys may use (contract draft.5):
 * a product's templates belong to it alone, and createVersion copies them into versions. A template
 * made with a partner key belongs to the reseller and is offered on all its storefronts
 * (docs/resellers.md); only a partner key removes it.
 */

/** Whose templates: a product's (its id) or a reseller's shared ones. */
export type TemplateOwner = string | { resellerId: string };

/** SQL matching the templates a product may use: its own and its reseller's shared ones. */
export const PRODUCT_TEMPLATES = (param: string) =>
  `(product_id = ${param} OR reseller_id = (SELECT reseller_id FROM products WHERE id = ${param}))`;

/** The base-snapshot operations; shared by these routes and the admin routes. */
export function baseSnapshotService({ pool, boss, provisioner }: Deps) {
  /**
   * A product's own and shared templates, or with `onlyShared` the shared ones alone; a reseller's
   * shared templates.
   */
  async function list(
    owner: TemplateOwner,
    filter: { baseSnapshotId?: string; name?: string; groupName?: string } = {},
    onlyShared = false,
  ) {
    const where =
      typeof owner !== 'string'
        ? 'reseller_id = $1'
        : onlyShared
          ? 'reseller_id = (SELECT reseller_id FROM products WHERE id = $1)'
          : PRODUCT_TEMPLATES('$1');
    const { rows } = await pool.query(
      `SELECT * FROM base_snapshots
        WHERE ${where} AND ($2::uuid IS NULL OR id = $2) AND ($3::text IS NULL OR name = $3) AND ($4::text IS NULL OR group_name = $4)
        ORDER BY date_created`,
      [typeof owner === 'string' ? owner : owner.resellerId, filter.baseSnapshotId ?? null, filter.name ?? null, filter.groupName ?? null],
    );
    return rows.map((b) =>
        compact({
          id: b.id,
          name: b.name,
          comment: b.comment,
          uri: b.uri,
          isDefault: false,
          isTenantSnapshot: b.is_tenant_snapshot,
          groupName: b.group_name,
          showAsBaseSnapshot: b.show_in_console,
        }),
    );
  }

  /** CreateBaseSnapshotParams in, CreateBaseSnapshotCommandResult out. */
  async function create(owner: TemplateOwner, input: unknown) {
    const body = validateBody<CreateBaseSnapshotParams>('CreateBaseSnapshotParams', input);
    if (!NAME.test(body.name)) throw badRequest('name must be 5 to 50 characters: letters, digits, spaces and dashes');
    if (!body.comment.trim()) throw badRequest('comment is required');
    const groupName = body.groupName?.trim() || null;
    if (groupName && !body.isTenantSnapshot) throw badRequest('groupName can only be set on a tenant snapshot');

    const id = randomUUID();
    const { uploadUrl, uri } = await provisioner.createBaseSnapshotUpload({ baseSnapshotId: id });
    await pool.query(
      `INSERT INTO base_snapshots (id, product_id, reseller_id, name, comment, is_tenant_snapshot, group_name, show_in_console, uri)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        typeof owner === 'string' ? owner : null,
        typeof owner === 'string' ? null : owner.resellerId,
        body.name,
        body.comment,
        body.isTenantSnapshot === true,
        groupName,
        body.showInConsole === true,
        uri,
      ],
    );
    return { id, name: body.name, comment: body.comment, showInConsole: body.showInConsole === true, uploadUrl };
  }

  // Versions keep their own copies, so deleting a template leaves them alone.
  async function remove(owner: TemplateOwner, id: string) {
    await withTransaction(pool, async (client) => {
      const column = typeof owner === 'string' ? 'product_id' : 'reseller_id';
      const { rowCount } = await client.query(`DELETE FROM base_snapshots WHERE id = $1 AND ${column} = $2`, [
        id,
        typeof owner === 'string' ? owner : owner.resellerId,
      ]);
      if (!rowCount) throw badRequest(`Base snapshot ${id} not found`);
      await enqueue(boss, client, { type: 'basesnapshot.delete', baseSnapshotId: id });
    });
    return { baseSnapshotId: id };
  }

  return { list, create, remove };
}

export function baseSnapshotRoutes(deps: Deps) {
  const templates = baseSnapshotService(deps);
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    // onlyPartnerSpecific: the shared templates alone. No effect for product keys; it is still validated.
    const onlyShared = booleanQuery(c, 'onlyPartnerSpecific') === true;
    const filter = { baseSnapshotId: uuidQuery(c, 'baseSnapshotId'), name: c.req.query('name') || undefined, groupName: c.req.query('groupName') || undefined };
    const resellerId = c.get('resellerId');
    const productId = c.get('productId') as string | undefined;
    if (resellerId && !productId) return c.json(await templates.list({ resellerId }, filter));
    return c.json(await templates.list(productId!, filter, onlyShared && !!resellerId));
  });

  // A partner key's templates are shared across its storefronts, with or without a productId.
  app.post('/', async (c) => {
    const resellerId = c.get('resellerId');
    return c.json(await templates.create(resellerId ? { resellerId } : c.get('productId'), await readJson(c)));
  });

  // A partner key removes a shared template, or with a productId that storefront's own.
  app.delete('/', async (c) => {
    const id = requiredUuidQuery(c, 'id');
    const resellerId = c.get('resellerId');
    const productId = c.get('productId') as string | undefined;
    if (!resellerId) return c.json(await templates.remove(productId!, id));
    const shared = await deps.pool.query('SELECT 1 FROM base_snapshots WHERE id = $1 AND reseller_id = $2', [id, resellerId]);
    return c.json(await templates.remove(shared.rowCount || !productId ? { resellerId } : productId, id));
  });

  return app;
}

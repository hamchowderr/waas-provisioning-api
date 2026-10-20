import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import { withTransaction, type Client } from './db.ts';
import { badRequest, conflict, HttpError } from './errors.ts';
import { isUuid, readJson } from './http.ts';
import { addApiKey, listApiKeys, parseGraceHours, parseLabel, revokeApiKey, rotateApiKey } from './keys.ts';
import { SIZES, type Size } from './plans.ts';
import { enqueue } from './queue.ts';

/**
 * Reseller accounts (docs/resellers.md): a partner that sells stores from one or more storefronts
 * (products) and pays the platform a wholesale price for every live store across them. The platform
 * admin makes them and moves storefronts in and out; a storefront with no reseller works as before.
 * Usage comes from tenant_periods, which database triggers keep (migrations/…_resellers.sql).
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const notFound = (what: string) => new HttpError(404, what);

interface Settings {
  name?: string;
  maxProducts?: number | null;
  maxTenants?: number | null;
  wholesalePercent?: number;
  billingEmail?: string | null;
  brandName?: string | null;
  brandUrl?: string | null;
  priceSmall?: number;
  priceMedium?: number;
  priceLarge?: number;
}

/** listPriceCents in requests and answers, and its columns. */
const PRICE_KEYS = { small: 'priceSmall', medium: 'priceMedium', large: 'priceLarge' } as const satisfies Record<Size, keyof Settings>;

/** The most a store's monthly list price may be: $10,000. */
const MAX_PRICE_CENTS = 1_000_000;

function limit(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100000) return value;
  throw badRequest(`${name} must be a whole number, 0 or more, or null for no limit`);
}

/** The settings present in a request body; `creating` requires the name. */
function parseSettings(body: unknown, creating: boolean): Settings {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Settings = {};
  if (b.name !== undefined || creating) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 100) throw badRequest('name is required, at most 100 characters');
    out.name = name;
  }
  if (b.maxProducts !== undefined) out.maxProducts = limit(b.maxProducts, 'maxProducts');
  if (b.maxTenants !== undefined) out.maxTenants = limit(b.maxTenants, 'maxTenants');
  if (b.wholesalePercent !== undefined) {
    const p = b.wholesalePercent;
    if (!(typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 100)) throw badRequest('wholesalePercent must be a whole number from 0 to 100');
    out.wholesalePercent = p;
  }
  if (b.billingEmail !== undefined) {
    const email = typeof b.billingEmail === 'string' ? b.billingEmail.trim().toLowerCase() : b.billingEmail;
    if (email === null || email === '') out.billingEmail = null;
    else if (typeof email === 'string' && email.length <= 254 && EMAIL.test(email)) out.billingEmail = email;
    else throw badRequest('billingEmail must be an email address, or null');
  }
  if (b.brandName !== undefined) {
    const brand = typeof b.brandName === 'string' ? b.brandName.trim() : b.brandName;
    if (brand === null || brand === '') out.brandName = null;
    else if (typeof brand === 'string' && brand.length <= 60) out.brandName = brand;
    else throw badRequest('brandName must be at most 60 characters, or null');
  }
  if (b.brandUrl !== undefined) {
    const url = typeof b.brandUrl === 'string' ? b.brandUrl.trim() : b.brandUrl;
    if (url === null || url === '') out.brandUrl = null;
    else if (typeof url === 'string' && url.length <= 500 && /^https?:\/\/[^\s]+$/.test(url)) out.brandUrl = url;
    else throw badRequest('brandUrl must be an http or https link, or null');
  }
  if (b.listPriceCents !== undefined) {
    const prices = b.listPriceCents as Record<string, unknown> | null;
    if (!prices || typeof prices !== 'object' || Array.isArray(prices) || Object.keys(prices).some((k) => !Object.hasOwn(PRICE_KEYS, k))) {
      throw badRequest('listPriceCents must be an object with small, medium and/or large');
    }
    for (const [size, key] of Object.entries(PRICE_KEYS)) {
      const cents = prices[size];
      if (cents === undefined) continue;
      if (!(typeof cents === 'number' && Number.isInteger(cents) && cents >= 0 && cents <= MAX_PRICE_CENTS)) {
        throw badRequest(`listPriceCents.${size} must be a whole number of cents from 0 to ${MAX_PRICE_CENTS}`);
      }
      out[key] = cents;
    }
  }
  return out;
}

const COLUMNS = {
  name: 'name',
  maxProducts: 'max_products',
  maxTenants: 'max_tenants',
  wholesalePercent: 'wholesale_percent',
  billingEmail: 'billing_email',
  brandName: 'brand_name',
  brandUrl: 'brand_url',
  priceSmall: 'price_small_cents',
  priceMedium: 'price_medium_cents',
  priceLarge: 'price_large_cents',
} as const;

/** A calendar month (UTC) from ?month=YYYY-MM; the default is last month, the one a bill is sent for. */
function monthQuery(c: Context, now = new Date()): { month: string; from: Date; to: Date } {
  const value = c.req.query('month');
  const match = value === undefined ? null : /^(\d{4})-(\d{2})$/.exec(value);
  if (value !== undefined && (!match || Number(match[2]) < 1 || Number(match[2]) > 12)) throw badRequest('month must be YYYY-MM');
  const from = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)) : monthStart(now, -1);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  return { month: from.toISOString().slice(0, 7), from, to };
}

/** A month's start (UTC) for usage: `from` and `to` default to the current calendar month. */
function monthStart(date: Date, offset = 0): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
}

function dateQuery(c: Context, name: string, fallback: Date): Date {
  const value = c.req.query(name);
  if (!value) return fallback;
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(date.getTime())) throw badRequest(`${name} must be an ISO 8601 date or date-time`);
  return date;
}

const days = (seconds: number) => Math.round((seconds / 86400) * 100) / 100;
const emptySizes = () => Object.fromEntries(Object.keys(SIZES).map((s) => [s, 0])) as Record<Size, number>;

export function adminResellerRoutes(deps: Deps) {
  const { pool } = deps;
  const app = new Hono<AppEnv>();

  async function resellers(id: string | null) {
    const { rows } = await pool.query(
      `SELECT r.*,
         COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name,
                     'tenantCount', (SELECT count(*)::int FROM tenants t WHERE t.product_id = p.id)) ORDER BY p.name, p.id)
                     FROM products p WHERE p.reseller_id = r.id), '[]') AS products,
         (SELECT count(*)::int FROM tenants t JOIN products p ON p.id = t.product_id WHERE p.reseller_id = r.id) AS tenant_count,
         (SELECT count(*)::int FROM tenant_periods tp WHERE tp.reseller_id = r.id AND tp.ended_at IS NULL) AS live_tenant_count
       FROM resellers r WHERE ($1::uuid IS NULL OR r.id = $1) ORDER BY r.name, r.id`,
      [id],
    );
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      maxProducts: r.max_products as number | null,
      maxTenants: r.max_tenants as number | null,
      wholesalePercent: r.wholesale_percent as number,
      billingEmail: (r.billing_email as string | null) ?? null,
      brandName: (r.brand_name as string | null) ?? null,
      brandUrl: (r.brand_url as string | null) ?? null,
      listPriceCents: { small: r.price_small_cents as number, medium: r.price_medium_cents as number, large: r.price_large_cents as number } as Record<Size, number>,
      products: r.products as { id: string; name: string; tenantCount: number }[],
      tenantCount: r.tenant_count as number,
      liveTenantCount: r.live_tenant_count as number,
      dateCreated: (r.created_at as Date).toISOString(),
    }));
  }

  async function find(c: Context) {
    const id = c.req.param('id')!;
    const found = isUuid(id) ? (await resellers(id))[0] : undefined;
    if (!found) throw notFound(`Reseller ${id} not found`);
    return found;
  }

  /** Moves a storefront into the reseller, within its max_products. The reseller row is locked first. */
  async function addProduct(client: Client, resellerId: string, productId: string) {
    const { rows } = await client.query<{ max_products: number | null }>('SELECT max_products FROM resellers WHERE id = $1 FOR UPDATE', [resellerId]);
    if (!rows[0]) throw notFound(`Reseller ${resellerId} not found`);
    const product = isUuid(productId)
      ? (await client.query<{ reseller_id: string | null }>('SELECT reseller_id FROM products WHERE id = $1 FOR UPDATE', [productId])).rows[0]
      : undefined;
    if (!product) throw notFound(`Product ${productId} not found`);
    if (product.reseller_id === resellerId) return;
    if (product.reseller_id) throw conflict('This storefront belongs to another reseller; remove it from that one first');
    const max = rows[0].max_products;
    if (max !== null) {
      const { rows: count } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM products WHERE reseller_id = $1', [resellerId]);
      if (count[0]!.n >= max) throw badRequest(`This reseller has reached its limit of ${max} storefront${max === 1 ? '' : 's'}`);
    }
    await client.query('UPDATE products SET reseller_id = $2 WHERE id = $1', [productId, resellerId]);
  }

  /** Seconds each storefront's stores were live, by size, between `from` and `to`. */
  async function liveSeconds(resellerId: string, from: Date, to: Date) {
    const { rows } = await pool.query<{ product_id: string; name: string | null; size: Size; seconds: number }>(
      `SELECT tp.product_id, p.name, tp.size,
         sum(extract(epoch FROM least(coalesce(tp.ended_at, now()), $3) - greatest(tp.started_at, $2)))::float AS seconds
       FROM tenant_periods tp LEFT JOIN products p ON p.id = tp.product_id
       WHERE tp.reseller_id = $1 AND tp.started_at < $3 AND coalesce(tp.ended_at, now()) > $2
       GROUP BY tp.product_id, p.name, tp.size
       ORDER BY p.name, tp.product_id, array_position(ARRAY['small', 'medium', 'large'], tp.size)`,
      [resellerId, from, to],
    );
    return rows.filter((r) => r.seconds > 0);
  }

  app.get('/', async (c) => c.json(await resellers(null)));

  // A new reseller; `productIds` moves storefronts into it at once ("Make reseller" on a storefront).
  app.post('/', async (c) => {
    const body = (await readJson(c)) as { productIds?: unknown };
    const settings = parseSettings(body, true);
    const productIds = body?.productIds ?? [];
    if (!Array.isArray(productIds) || productIds.length > 100 || !productIds.every((p) => typeof p === 'string')) {
      throw badRequest('productIds must be a list of product ids');
    }
    const id = await withTransaction(pool, async (client) => {
      const keys = Object.keys(settings) as (keyof Settings)[];
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO resellers (${keys.map((k) => COLUMNS[k]).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        keys.map((k) => settings[k]),
      );
      for (const productId of productIds as string[]) await addProduct(client, rows[0]!.id, productId);
      return rows[0]!.id;
    });
    return c.json((await resellers(id))[0], 201);
  });

  app.get('/:id', async (c) => c.json(await find(c)));

  // Changes only the settings sent. Lowering a limit below the current count removes nothing.
  app.put('/:id', async (c) => {
    const { id } = await find(c);
    const settings = parseSettings(await readJson(c), false);
    const keys = Object.keys(settings) as (keyof Settings)[];
    if (keys.length) {
      await pool.query(`UPDATE resellers SET ${keys.map((k, i) => `${COLUMNS[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [
        id,
        ...keys.map((k) => settings[k]),
      ]);
    }
    return c.json((await resellers(id))[0]);
  });

  // Only an empty reseller can be deleted, so a mistake can't touch storefronts. Usage stays.
  app.delete('/:id', async (c) => {
    const reseller = await find(c);
    if (reseller.products.length) throw conflict('Move its storefronts out first');
    // Its shared templates go with it; their files are removed in the background.
    await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>('DELETE FROM base_snapshots WHERE reseller_id = $1 RETURNING id', [reseller.id]);
      for (const t of rows) await enqueue(deps.boss, client, { type: 'basesnapshot.delete', baseSnapshotId: t.id });
      await client.query('DELETE FROM resellers WHERE id = $1', [reseller.id]);
    });
    return c.json(reseller);
  });

  app.put('/:id/products/:productId', async (c) => {
    const { id } = await find(c);
    await withTransaction(pool, (client) => addProduct(client, id, c.req.param('productId')!));
    return c.json((await resellers(id))[0]);
  });

  // The storefront goes back to being its own; its stores stop counting for the reseller from now.
  app.delete('/:id/products/:productId', async (c) => {
    const { id } = await find(c);
    const productId = c.req.param('productId')!;
    const moved = isUuid(productId) && (await pool.query('UPDATE products SET reseller_id = NULL WHERE id = $1 AND reseller_id = $2', [productId, id])).rowCount;
    if (!moved) throw notFound(`Product ${productId} is not one of this reseller's storefronts`);
    return c.json((await resellers(id))[0]);
  });

  // Partner keys: the reseller's own API keys, which work on all its storefronts (each /v1 call names
  // one with the productId query). Same operations as a product's keys; deleting the reseller deletes them.
  app.get('/:id/keys', async (c) => c.json(await listApiKeys(pool, { resellerId: (await find(c)).id })));
  app.post('/:id/keys', async (c) => {
    const { id } = await find(c);
    const body = (await readJson(c)) as { label?: unknown };
    const key = await addApiKey(pool, { resellerId: id }, parseLabel(body?.label));
    c.header('Cache-Control', 'no-store');
    return c.json(key, 201);
  });
  app.post('/:id/keys/:keyId/rotate', async (c) => {
    const { id } = await find(c);
    const body = (await readJson(c)) as { graceHours?: unknown };
    const result = await rotateApiKey(pool, { resellerId: id }, c.req.param('keyId')!, parseGraceHours(body?.graceHours));
    c.header('Cache-Control', 'no-store');
    return c.json(result, 201);
  });
  app.delete('/:id/keys/:keyId', async (c) => c.json(await revokeApiKey(pool, { resellerId: (await find(c)).id }, c.req.param('keyId')!)));

  // Store-days per size between `from` and `to` (default: this calendar month, UTC), per storefront
  // and in total: what the wholesale bill is counted from. A store live all of a 30-day month is 30.
  app.get('/:id/usage', async (c) => {
    const reseller = await find(c);
    const now = new Date();
    const from = dateQuery(c, 'from', monthStart(now));
    const to = dateQuery(c, 'to', monthStart(now, 1));
    if (to <= from) throw badRequest('to must be after from');
    const rows = await liveSeconds(reseller.id, from, to);
    const totalSeconds = emptySizes();
    const products = new Map<string, { productId: string; name: string | null; storeDays: Record<Size, number> }>();
    for (const r of rows) {
      const entry = products.get(r.product_id) ?? { productId: r.product_id, name: r.name, storeDays: emptySizes() };
      entry.storeDays[r.size] = days(r.seconds);
      totalSeconds[r.size] += r.seconds;
      products.set(r.product_id, entry);
    }
    return c.json({
      resellerId: reseller.id,
      from: from.toISOString(),
      to: to.toISOString(),
      wholesalePercent: reseller.wholesalePercent,
      storeDays: Object.fromEntries(Object.entries(totalSeconds).map(([size, seconds]) => [size, days(seconds)])),
      products: [...products.values()],
    });
  });

  // The bill for one calendar month (?month=YYYY-MM, default last month): each store is charged its
  // size's monthly list price less the wholesale discount, for the share of the month it was live.
  // A store live all month pays the full monthly price; one live 10 days of a 30-day month, a third.
  // Amounts are US cents, rounded per line. A month not yet over is marked complete: false.
  app.get('/:id/bill', async (c) => {
    const reseller = await find(c);
    const now = new Date();
    const { month, from, to } = monthQuery(c, now);
    if (from > now) throw badRequest('That month has not started yet');
    const monthSeconds = (to.getTime() - from.getTime()) / 1000;
    const lines = (await liveSeconds(reseller.id, from, to)).map((r) => {
      const listPriceCents = reseller.listPriceCents[r.size];
      const wholesalePriceCents = Math.round((listPriceCents * (100 - reseller.wholesalePercent)) / 100);
      return {
        productId: r.product_id,
        name: r.name,
        size: r.size,
        storeDays: days(r.seconds),
        stores: Math.round((r.seconds / monthSeconds) * 100) / 100,
        listPriceCents,
        wholesalePriceCents,
        amountCents: Math.round((r.seconds / monthSeconds) * wholesalePriceCents),
      };
    });
    return c.json({
      resellerId: reseller.id,
      resellerName: reseller.name,
      billingEmail: reseller.billingEmail,
      month,
      from: from.toISOString(),
      to: to.toISOString(),
      complete: to <= now,
      currency: 'usd',
      wholesalePercent: reseller.wholesalePercent,
      lines,
      totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    });
  });

  return app;
}

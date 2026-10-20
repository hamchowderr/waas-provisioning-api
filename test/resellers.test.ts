// Reseller accounts (src/resellers.ts): the admin endpoints, the store limit across a reseller's
// storefronts, and the usage record (tenant_periods) the database triggers keep. Responses are
// validated against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApiKey } from '../src/keys.ts';
import { createAjv } from '../src/openapi.ts';
import { Status } from '../src/status.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;

/** Calls the admin API; a 2xx JSON answer must match the admin spec. */
async function admin(method: string, path: string, expected = 200, body?: unknown): Promise<any> {
  const res = await t.call(method, path, { auth: ADMIN, body });
  expect(res.status, `${method} ${path}`).toBe(expected);
  const parsed = await res.json();
  if (expected >= 300) return parsed;
  const opPath = Object.keys(adminSpec.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path.split('?')[0]!))!;
  const schema = JSON.parse(
    JSON.stringify(adminSpec.paths[opPath][method.toLowerCase()].responses[String(expected)].content['application/json'].schema).replaceAll(
      '"#/components',
      '"admin#/components',
    ),
  );
  const validate = ajv.compile(schema);
  expect(validate(parsed), `${method} ${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  return parsed;
}

async function newProduct(name: string) {
  const id = (await t.pool.query<{ id: string }>('INSERT INTO products (name) VALUES ($1) RETURNING id', [name])).rows[0]!.id;
  const { key, secret } = await createApiKey(t.pool, id);
  const auth = basic(key, secret);
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true }, auth });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`, { auth })).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId }, auth });
  return { id, auth };
}

const tenant = async (externalId: string, auth: string) =>
  ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`, { auth })).json()) as any[])[0];

async function newTenant(auth: string, body: object = {}) {
  const res = await t.call('POST', '/v1/tenants', { body: { name: 'Shop', ...body }, auth });
  expect(res.status).toBe(200);
  const created = (await res.json()) as { id: string; externalId: string };
  await waitFor(async () => (await tenant(created.externalId, auth))?.statusCode === Status.Done);
  return created;
}

const periods = async (tenantId: string) =>
  (
    await t.pool.query<{ product_id: string; reseller_id: string | null; size: string; ended_at: Date | null }>(
      'SELECT product_id, reseller_id, size, ended_at FROM tenant_periods WHERE tenant_id = $1 ORDER BY started_at, ended_at NULLS LAST',
      [tenantId],
    )
  ).rows;

let partner: { id: string; auth: string };
let second: { id: string; auth: string };

beforeAll(async () => {
  t = await setup();
  partner = await newProduct('Partner storefront');
  second = await newProduct('Partner second brand');
});
afterAll(async () => {
  await t.close();
});

describe('reseller accounts', () => {
  let resellerId: string;

  it('makes a reseller with a storefront moved into it, and shows it on the product', async () => {
    const reseller = await admin('POST', '/admin/resellers', 201, { name: 'Partner', productIds: [partner.id], billingEmail: 'Billing@Example.com' });
    resellerId = reseller.id;
    expect(reseller).toMatchObject({
      name: 'Partner',
      maxProducts: null,
      maxTenants: null,
      wholesalePercent: 40,
      billingEmail: 'billing@example.com',
      products: [{ id: partner.id, name: 'Partner storefront', tenantCount: 0 }],
      tenantCount: 0,
      liveTenantCount: 0,
    });
    const products = await admin('GET', '/admin/products');
    expect(products.find((p: any) => p.id === partner.id)).toMatchObject({ resellerId, resellerName: 'Partner' });
    expect(products.find((p: any) => p.id === t.productId)).toMatchObject({ resellerId: null, resellerName: null });
    expect(await admin('GET', '/admin/resellers')).toHaveLength(1);
  });

  it('validates settings and changes only what is sent', async () => {
    await admin('POST', '/admin/resellers', 400, { name: '' });
    await admin('PUT', `/admin/resellers/${resellerId}`, 400, { wholesalePercent: 101 });
    await admin('PUT', `/admin/resellers/${resellerId}`, 400, { billingEmail: 'nope' });
    await admin('PUT', `/admin/resellers/${resellerId}`, 400, { listPriceCents: { small: 12.5 } });
    await admin('PUT', `/admin/resellers/${resellerId}`, 400, { listPriceCents: { tiny: 100 } });
    expect((await admin('GET', `/admin/resellers/${resellerId}`)).listPriceCents).toEqual({ small: 1200, medium: 2400, large: 4800 });
    const priced = await admin('PUT', `/admin/resellers/${resellerId}`, 200, { listPriceCents: { large: 5000 } });
    expect(priced.listPriceCents).toEqual({ small: 1200, medium: 2400, large: 5000 });
    const updated = await admin('PUT', `/admin/resellers/${resellerId}`, 200, { wholesalePercent: 35, maxProducts: 1 });
    expect(updated).toMatchObject({ name: 'Partner', wholesalePercent: 35, maxProducts: 1, billingEmail: 'billing@example.com' });
    await admin('GET', '/admin/resellers/not-a-uuid', 404);
  });

  it('keeps to maxProducts, and a storefront belongs to one reseller only', async () => {
    await admin('PUT', `/admin/resellers/${resellerId}/products/${second.id}`, 400);
    await admin('PUT', `/admin/resellers/${resellerId}`, 200, { maxProducts: null });
    expect((await admin('PUT', `/admin/resellers/${resellerId}/products/${second.id}`)).products).toHaveLength(2);
    // Again is no change.
    expect((await admin('PUT', `/admin/resellers/${resellerId}/products/${second.id}`)).products).toHaveLength(2);
    await admin('POST', '/admin/resellers', 409, { name: 'Other', productIds: [second.id] });
    expect(await admin('GET', '/admin/resellers')).toHaveLength(1);
  });

  it('is for the platform admin only', async () => {
    expect((await t.call('GET', '/admin/resellers')).status).toBe(403);
    expect((await t.call('GET', '/admin/resellers', { auth: partner.auth })).status).toBe(403);
  });

  it('stops new stores at the reseller limit, across its storefronts', async () => {
    await admin('PUT', `/admin/resellers/${resellerId}`, 200, { maxTenants: 2 });
    await newTenant(partner.auth);
    await newTenant(second.auth);
    const res = await t.call('POST', '/v1/tenants', { body: { name: 'Third' }, auth: partner.auth });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/limit of 2 stores/);
    await admin('PUT', `/admin/resellers/${resellerId}`, 200, { maxTenants: null });
    expect((await admin('GET', `/admin/resellers/${resellerId}`)).tenantCount).toBe(2);
  });

  it("puts its own brand on its suspended stores' unavailable page", async () => {
    await admin('PUT', `/admin/resellers/${resellerId}`, 400, { brandUrl: 'javascript:alert(1)' });
    await admin('PUT', `/admin/resellers/${resellerId}`, 400, { brandName: 'x'.repeat(61) });
    const branded = await admin('PUT', `/admin/resellers/${resellerId}`, 200, { brandName: ' Partner Sites ', brandUrl: 'https://partner.example' });
    expect(branded).toMatchObject({ brandName: 'Partner Sites', brandUrl: 'https://partner.example' });

    const suspend = async (auth: string) => {
      const { id, externalId } = await newTenant(auth);
      await t.call('POST', `/v1/tenants/suspend?externalId=${externalId}`, { body: { takeBackup: false }, auth });
      await waitFor(async () => t.provisioner.stores.get(id)?.suspended);
      return t.provisioner.stores.get(id)!.suspendedBrand;
    };
    expect(await suspend(partner.auth)).toEqual({ name: 'Partner Sites', url: 'https://partner.example' });
    // A storefront with no reseller gets the platform's brand.
    expect(await suspend((await newProduct('Own storefront')).auth)).toBeUndefined();

    expect(await admin('PUT', `/admin/resellers/${resellerId}`, 200, { brandName: null, brandUrl: '' })).toMatchObject({ brandName: null, brandUrl: null });
    expect(await suspend(partner.auth)).toBeUndefined();
  });

  it('refuses to delete a reseller with storefronts', async () => {
    await admin('DELETE', `/admin/resellers/${resellerId}`, 409);
  });
});

describe('usage record', () => {
  let resellerId: string;
  let product: { id: string; auth: string };

  beforeAll(async () => {
    product = await newProduct('Usage storefront');
    resellerId = (await admin('POST', '/admin/resellers', 201, { name: 'Usage reseller', productIds: [product.id] })).id;
  });

  it('opens a period when a store finishes building, under its reseller', async () => {
    const res = await t.call('POST', '/v1/tenants', { body: { name: 'Shop' }, auth: product.auth });
    const created = (await res.json()) as { id: string; externalId: string };
    // Not live while it is still being built.
    expect(await periods(created.id)).toEqual([]);
    await waitFor(async () => (await tenant(created.externalId, product.auth))?.statusCode === Status.Done);
    expect(await periods(created.id)).toEqual([{ product_id: product.id, reseller_id: resellerId, size: 'small', ended_at: null }]);
    expect((await admin('GET', `/admin/resellers/${resellerId}`)).liveTenantCount).toBe(1);
  });

  it('stops while suspended, restarts on resume and on a size change, and ends on delete', async () => {
    const { id, externalId } = await newTenant(product.auth);
    await t.call('POST', `/v1/tenants/suspend?externalId=${externalId}`, { body: { takeBackup: false }, auth: product.auth });
    await waitFor(async () => (await tenant(externalId, product.auth))?.statusCode === Status.Done);
    let rows = await periods(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ended_at).toBeInstanceOf(Date);

    await t.call('POST', `/v1/tenants/resume?externalId=${externalId}`, { body: {}, auth: product.auth });
    await waitFor(async () => (await tenant(externalId, product.auth))?.statusCode === Status.Done);
    rows = await periods(id);
    expect(rows.map((r) => r.ended_at === null)).toEqual([false, true]);

    // An update sets the store Pending for a moment; only the size change starts a new period.
    expect((await t.call('PUT', `/v1/tenants?externalId=${externalId}`, { body: { wpOptions: { blogname: 'New' } }, auth: product.auth })).status).toBe(200);
    await waitFor(async () => (await tenant(externalId, product.auth))?.statusCode === Status.Done);
    expect(await periods(id)).toHaveLength(2);
    expect((await t.call('PUT', `/v1/tenants?externalId=${externalId}`, { body: { size: 'medium' }, auth: product.auth })).status).toBe(200);
    await waitFor(async () => (await tenant(externalId, product.auth))?.statusCode === Status.Done);
    rows = await periods(id);
    expect(rows.map((r) => [r.size, r.ended_at === null])).toEqual([
      ['small', false],
      ['small', false],
      ['medium', true],
    ]);

    await t.call('DELETE', `/v1/tenants?externalId=${externalId}`, { auth: product.auth });
    await waitFor(async () => !(await tenant(externalId, product.auth)));
    rows = await periods(id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ended_at)).toBe(true);
  });

  it('restarts live periods under the new reseller when a storefront moves', async () => {
    const { id } = await newTenant(product.auth);
    await admin('DELETE', `/admin/resellers/${resellerId}/products/${product.id}`);
    await admin('DELETE', `/admin/resellers/${resellerId}/products/${product.id}`, 404);
    expect((await periods(id)).map((r) => [r.reseller_id, r.ended_at === null])).toEqual([
      [resellerId, false],
      [null, true],
    ]);
    await admin('PUT', `/admin/resellers/${resellerId}/products/${product.id}`);
    expect((await periods(id)).map((r) => r.reseller_id)).toEqual([resellerId, null, resellerId]);
  });

  it('counts store-days per size within the period asked for', async () => {
    const other = await admin('POST', '/admin/resellers', 201, { name: 'Counted' });
    const storefront = await newProduct('Counted storefront');
    await admin('PUT', `/admin/resellers/${other.id}/products/${storefront.id}`);
    // Recorded history: one small store for all of September, one large store for its last 10 days.
    await t.pool.query(
      `INSERT INTO tenant_periods (tenant_id, product_id, reseller_id, size, started_at, ended_at) VALUES
         (gen_random_uuid(), $1, $2, 'small', '2026-08-20T00:00:00Z', '2026-10-05T00:00:00Z'),
         (gen_random_uuid(), $1, $2, 'large', '2026-09-21T00:00:00Z', NULL)`,
      [storefront.id, other.id],
    );
    const usage = await admin('GET', `/admin/resellers/${other.id}/usage?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z`);
    expect(usage).toMatchObject({
      resellerId: other.id,
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      wholesalePercent: 40,
      storeDays: { small: 30, medium: 0, large: 10 },
      products: [{ productId: storefront.id, name: 'Counted storefront', storeDays: { small: 30, medium: 0, large: 10 } }],
    });
    // The default is this month; a period not overlapping it is left out.
    const current = await admin('GET', `/admin/resellers/${other.id}/usage`);
    expect(current.storeDays.small).toBeGreaterThan(0);
    await admin('GET', `/admin/resellers/${other.id}/usage?from=2026-10-01&to=2026-09-01`, 400);
    await admin('GET', `/admin/resellers/${other.id}/usage?from=yesterday`, 400);

    await admin('DELETE', `/admin/resellers/${other.id}/products/${storefront.id}`);
    expect((await admin('DELETE', `/admin/resellers/${other.id}`)).name).toBe('Counted');
    await admin('GET', `/admin/resellers/${other.id}`, 404);
  });

  it("works out a month's wholesale bill from the store-days", async () => {
    const billed = await admin('POST', '/admin/resellers', 201, {
      name: 'Billed',
      billingEmail: 'accounts@example.com',
      wholesalePercent: 40,
      listPriceCents: { small: 1200, medium: 2400, large: 5000 },
    });
    const storefront = await newProduct('Billed storefront');
    await admin('PUT', `/admin/resellers/${billed.id}/products/${storefront.id}`);
    // September: two small stores live all month, one large store for its last 10 days (a third).
    await t.pool.query(
      `INSERT INTO tenant_periods (tenant_id, product_id, reseller_id, size, started_at, ended_at) VALUES
         (gen_random_uuid(), $1, $2, 'small', '2026-08-20T00:00:00Z', '2026-10-05T00:00:00Z'),
         (gen_random_uuid(), $1, $2, 'small', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
         (gen_random_uuid(), $1, $2, 'large', '2026-09-21T00:00:00Z', NULL)`,
      [storefront.id, billed.id],
    );
    const bill = await admin('GET', `/admin/resellers/${billed.id}/bill?month=2026-09`);
    expect(bill).toMatchObject({
      resellerName: 'Billed',
      billingEmail: 'accounts@example.com',
      month: '2026-09',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      complete: true,
      currency: 'usd',
      wholesalePercent: 40,
    });
    // Small: $12 less 40% = $7.20 a store, two stores = $14.40. Large: $50 less 40% = $30, a third = $10.
    expect(bill.lines).toEqual([
      expect.objectContaining({ size: 'small', storeDays: 60, stores: 2, listPriceCents: 1200, wholesalePriceCents: 720, amountCents: 1440 }),
      expect.objectContaining({ size: 'large', storeDays: 10, stores: 0.33, listPriceCents: 5000, wholesalePriceCents: 3000, amountCents: 1000 }),
    ]);
    expect(bill.totalCents).toBe(2440);

    // The default is last month; a bad or future month is refused.
    const now = new Date();
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    expect((await admin('GET', `/admin/resellers/${billed.id}/bill`)).month).toBe(last);
    const current = await admin('GET', `/admin/resellers/${billed.id}/bill?month=${now.toISOString().slice(0, 7)}`);
    expect(current.complete).toBe(false);
    await admin('GET', `/admin/resellers/${billed.id}/bill?month=2026-13`, 400);
    await admin('GET', `/admin/resellers/${billed.id}/bill?month=september`, 400);
    await admin('GET', `/admin/resellers/${billed.id}/bill?month=${now.getUTCFullYear() + 1}-01`, 400);
  });
});

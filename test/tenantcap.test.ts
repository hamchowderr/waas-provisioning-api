// The per-product tenant cap (products.max_tenants): createTenant and restoreTenant stop at it,
// the admin API sets it, and the migration caps the test storefronts' product.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApiKey } from '../src/keys.ts';
import { createAjv } from '../src/openapi.ts';
import { Status } from '../src/status.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');
const validProduct = ajv.compile({ $ref: 'admin#/components/schemas/Product' });

type Tenant = { id: string; externalId: string };
const getTenant = async (externalId: string, auth?: string) =>
  ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`, { auth })).json()) as any[])[0];
const settled = (externalId: string, auth?: string) => waitFor(async () => (await getTenant(externalId, auth))?.statusCode === Status.Done);
const create = (name: string, auth?: string) => t.call('POST', '/v1/tenants', { body: { name }, auth });

async function newTenant(name: string, auth?: string): Promise<Tenant> {
  const res = await create(name, auth);
  expect(res.status, name).toBe(200);
  const tenant = (await res.json()) as Tenant;
  await settled(tenant.externalId, auth);
  return tenant;
}

const setCap = (productId: string, maxTenants: unknown, auth = ADMIN) => t.call('PUT', `/admin/products/${productId}`, { body: { maxTenants }, auth });

async function productionVersion(auth?: string) {
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true }, auth });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`, { auth })).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId }, auth });
}

beforeAll(async () => {
  t = await setup();
  await productionVersion();
});
afterAll(async () => {
  await t.close();
});

describe('tenant cap', () => {
  it('has no limit by default', async () => {
    const [product] = (await (await t.call('GET', '/admin/products', { auth: ADMIN })).json()) as any[];
    expect(product.maxTenants).toBeNull();
    expect(validProduct(product), ajv.errorsText(validProduct.errors)).toBe(true);
  });

  it('stops createTenant at the limit, for this product only', async () => {
    const res = await setCap(t.productId, 2);
    expect(res.status).toBe(200);
    const product = await res.json();
    expect(validProduct(product), ajv.errorsText(validProduct.errors)).toBe(true);
    expect(product).toMatchObject({ id: t.productId, maxTenants: 2, tenantCount: 0 });

    await newTenant('First');
    await newTenant('Second');
    const third = await create('Third');
    expect(third.status).toBe(400);
    expect(((await third.json()) as any).message).toBe('This storefront has reached its limit of 2 stores; delete one or ask for a higher limit');
    expect((await t.pool.query('SELECT count(*)::int AS n FROM tenants WHERE product_id = $1', [t.productId])).rows[0].n).toBe(2);

    // Another product is not affected.
    const other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Other storefront') RETURNING id")).rows[0]!.id;
    const { key, secret } = await createApiKey(t.pool, other);
    const otherAuth = basic(key, secret);
    await productionVersion(otherAuth);
    await newTenant('Elsewhere', otherAuth);
  });

  it('lets two racing requests take only the last place', async () => {
    await setCap(t.productId, 3);
    const results = await Promise.all([create('Race A'), create('Race B'), create('Race C')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    await setCap(t.productId, 2);
    const created = await t.pool.query("SELECT external_id FROM tenants WHERE product_id = $1 AND name LIKE 'Race %'", [t.productId]);
    for (const row of created.rows) {
      await settled(row.external_id);
      await t.call('DELETE', `/v1/tenants?externalId=${row.external_id}`);
      await waitFor(async () => !(await getTenant(row.external_id)));
    }
  });

  it('stops restoreTenant at the limit too, and a higher limit lets it through', async () => {
    await setCap(t.productId, null);
    const tenant = await newTenant('Restorable');
    const { backupId } = (await (await t.call('POST', `/v1/tenants/backups?externalId=${tenant.externalId}`)).json()) as any;
    await waitFor(async () =>
      ((await (await t.call('GET', `/v1/tenants/backups?externalId=${tenant.externalId}`)).json()) as any[]).find((b) => b.id === backupId)?.statusCode === Status.Done,
    );
    await t.call('DELETE', `/v1/tenants?externalId=${tenant.externalId}`);
    await waitFor(async () => !(await getTenant(tenant.externalId)));
    await newTenant('Took its place');

    await setCap(t.productId, 3);
    const refused = await t.call('POST', `/v1/tenants/restore?externalId=${tenant.externalId}`, { body: {} });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as any).message).toMatch(/limit of 3 stores/);

    await setCap(t.productId, 4);
    expect((await t.call('POST', `/v1/tenants/restore?externalId=${tenant.externalId}`, { body: {} })).status).toBe(200);
    await settled(tenant.externalId);
  });

  it('lowering the limit below the count deletes nothing', async () => {
    const before = (await t.pool.query('SELECT count(*)::int AS n FROM tenants WHERE product_id = $1', [t.productId])).rows[0].n;
    const product = await (await setCap(t.productId, 0)).json();
    expect(product).toMatchObject({ maxTenants: 0, tenantCount: before });
    expect((await create('None allowed')).status).toBe(400);
    await setCap(t.productId, null);
    expect((await create('Unlimited again')).status).toBe(200);
  });

  it('validates the admin request', async () => {
    for (const bad of [-1, 1.5, '3', true, undefined]) expect((await setCap(t.productId, bad)).status, String(bad)).toBe(400);
    expect((await setCap(crypto.randomUUID(), 3)).status).toBe(404);
    expect((await setCap('not-a-uuid', 3)).status).toBe(404);
    expect((await setCap(t.productId, 3, t.auth)).status).toBe(403);
  });
});

describe('the migration that caps the test storefronts', () => {
  const sql = readFileSync(new URL('../migrations/1760600000000_product-tenant-cap.sql', import.meta.url), 'utf8');
  const update = /UPDATE products[\s\S]*?;/.exec(sql)![0];
  const product = async (name: string) => (await t.pool.query<{ id: string }>('INSERT INTO products (name) VALUES ($1) RETURNING id', [name])).rows[0]!.id;
  const cap = async (id: string) => (await t.pool.query('SELECT max_tenants FROM products WHERE id = $1', [id])).rows[0].max_tenants;
  const key = (id: string, productId: string) => t.pool.query("INSERT INTO api_keys (id, product_id, secret_hash) VALUES ($1, $2, 'x')", [id, productId]);

  it('caps the product of the key starting eacd7333 at 5, and nothing else', async () => {
    const test = await product('Test storefronts');
    const unrelated = await product('Unrelated');
    await key('eacd7333-0000-4000-8000-000000000001', test);
    await t.pool.query(update);
    expect(await cap(test)).toBe(5);
    expect(await cap(unrelated)).toBeNull();
    expect(await cap(t.productId)).toBeNull();

    // A limit set by hand is kept.
    await t.pool.query('UPDATE products SET max_tenants = 9 WHERE id = $1', [test]);
    await t.pool.query(update);
    expect(await cap(test)).toBe(9);
  });

  it('changes nothing when the prefix matches more than one key', async () => {
    const a = await product('A');
    await key('eacd7333-0000-4000-8000-000000000002', a);
    await t.pool.query('UPDATE products SET max_tenants = NULL');
    await t.pool.query(update);
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM products WHERE max_tenants IS NOT NULL');
    expect(rows[0].n).toBe(0);
  });
});

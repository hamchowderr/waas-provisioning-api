// Ready-made storefronts (src/storefronts.ts): POST /admin/products/{id}/storefront builds a store of the
// storefront product, connected to the API with a new key of the product it sells for.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../src/keys.ts';
import { Status } from '../src/status.ts';
import { STOREFRONT_KEY_LABEL, storefrontDns } from '../src/storefronts.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
let storefrontProductId: string;
let storefrontAuth: string;
let sellerId: string;

const build = (productId: string, body: unknown) => t.call('POST', `/admin/products/${productId}/storefront`, { body, auth: ADMIN });
const get = async (productId: string) => (await t.call('GET', `/admin/products/${productId}/storefront`, { auth: ADMIN })).json() as Promise<any>;

async function newProduct(name: string) {
  const res = await t.call('POST', '/admin/products', { body: { name }, auth: ADMIN });
  const body = (await res.json()) as { product: { id: string }; key: { id: string; secret: string } };
  return { id: body.product.id, auth: basic(body.key.id, body.key.secret) };
}

beforeAll(async () => {
  t = await setup();
  const product = await newProduct('Storefronts');
  storefrontProductId = product.id;
  storefrontAuth = product.auth;
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true }, auth: storefrontAuth });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`, { auth: storefrontAuth })).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId }, auth: storefrontAuth });
  sellerId = (await newProduct('Example agency')).id;
});
afterAll(async () => {
  await t.close();
});

describe('ready-made storefronts', () => {
  it('are off until STOREFRONT_PRODUCT_ID is set', async () => {
    const res = await build(sellerId, { name: 'Example Agency', email: 'owner@agency.example' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).message).toMatch(/STOREFRONT_PRODUCT_ID/);
    expect(await get(sellerId)).toBeNull();
  });

  it('builds one, connected with a new key of the product', async () => {
    t.deps.config.storefrontProductId = storefrontProductId;
    const lookups: string[] = [];
    storefrontDns.resolve4 = async (name: string) => (lookups.push(name), ['203.0.113.10']);
    const res = await build(sellerId, { name: 'Example Agency', email: 'Owner@Agency.example', subdomain: 'example-agency' });
    expect(res.status).toBe(201);
    const storefront = (await res.json()) as any;
    expect(storefront).toMatchObject({ externalId: `storefront-${sellerId}`, name: 'Example Agency', domainName: 'example-agency.waas.example' });
    await waitFor(async () => (await get(sellerId))?.statusCode === Status.Done);

    const store = t.provisioner.stores.get(storefront.id)!;
    expect(store.user).toMatchObject({ email: 'owner@agency.example', role: 'administrator' });
    // Its customers' own domains point where the stores' names do.
    const storesHost = `www.${t.deps.config.storesDomain}`;
    expect(lookups).toEqual([storesHost]);
    expect(store.wpOptions).toEqual({
      blogname: 'Example Agency',
      admin_email: 'owner@agency.example',
      waas_root_domain: 'waas.example',
      wpcs_host_settings_root_domain: 'waas.example',
      waas_dns_a_records: '203.0.113.10',
      waas_dns_cname_target: storesHost,
    });
    const constants = store.phpConstants;
    expect(constants.WAAS_API_BASE_URL).toEqual({ value: 'http://localhost', isPrivate: false });
    expect(constants.WAAS_API_KEY!.isPrivate).toBe(true);
    expect(constants.WAAS_API_SECRET!.isPrivate).toBe(true);
    expect(constants.WAAS_HOST_KEY_ENCRYPTION_KEY!.value.length).toBeGreaterThanOrEqual(48);

    // The key in its wp-config works for the seller's product, and is labelled so the seller can tell it apart.
    const keys = (await (await t.call('GET', `/admin/products/${sellerId}/keys`, { auth: ADMIN })).json()) as any[];
    expect(keys.find((k) => k.id === constants.WAAS_API_KEY!.value)).toMatchObject({ label: STOREFRONT_KEY_LABEL, state: 'active' });
    const own = await t.call('GET', '/v1/tenants', { auth: basic(constants.WAAS_API_KEY!.value, constants.WAAS_API_SECRET!.value) });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual([]);
  });

  it('builds only one per product', async () => {
    const res = await build(sellerId, { name: 'Again', email: 'owner@agency.example' });
    expect(res.status).toBe(409);
  });

  it('checks the request, and makes no key when it is refused', async () => {
    const other = await newProduct('Other agency');
    for (const body of [{ email: 'a@b.example' }, { name: 'X', email: 'nope' }, { name: 'X', email: 'a@b.example', subdomain: 'Not valid!' }]) {
      expect((await build(other.id, body)).status).toBe(400);
    }
    // Taken address: the store isn't created, and the key made for it is revoked again.
    expect((await build(other.id, { name: 'X', email: 'a@b.example', subdomain: 'example-agency' })).status).toBe(400);
    const keys = (await (await t.call('GET', `/admin/products/${other.id}/keys`, { auth: ADMIN })).json()) as any[];
    expect(keys.filter((k) => k.label === STOREFRONT_KEY_LABEL).every((k) => k.state === 'revoked')).toBe(true);
    expect(await get(other.id)).toBeNull();
    expect((await build(storefrontProductId, { name: 'X', email: 'a@b.example' })).status).toBe(400);
  });

  it('are built by the platform admin only', async () => {
    const { key, secret } = await createApiKey(t.pool, sellerId);
    expect((await t.call('POST', `/admin/products/${sellerId}/storefront`, { body: { name: 'X', email: 'a@b.example' }, auth: basic(key, secret) })).status).toBe(403);
    expect((await t.call('GET', `/admin/products/${sellerId}/storefront`, { auth: null })).status).toBe(403);
  });
});

describe('deleting a storefront', () => {
  const remove = (productId: string, auth = ADMIN) => t.call('DELETE', `/admin/products/${productId}`, { auth });

  it('refuses while it has a ready-made storefront or stores, and never the storefront host', async () => {
    expect((await remove(sellerId)).status).toBe(409);
    expect((await remove(storefrontProductId)).status).toBe(409);
  });

  it('removes an empty one with its keys, for the platform admin only', async () => {
    const empty = await newProduct('Empty test storefront');
    expect((await remove(empty.id, empty.auth)).status).toBe(403);
    expect((await remove(empty.id)).status).toBe(204);
    expect((await t.pool.query('SELECT 1 FROM products WHERE id = $1', [empty.id])).rowCount).toBe(0);
    expect((await t.pool.query('SELECT 1 FROM api_keys WHERE product_id = $1', [empty.id])).rowCount).toBe(0);
    expect((await remove(empty.id)).status).toBe(404);
  });
});

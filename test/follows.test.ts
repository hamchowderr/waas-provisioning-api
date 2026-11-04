import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Status } from '../src/status.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext, OWNER } from './helpers.ts';

// A storefront started from another one follows it (waas-api-t2p.1): each new production version there is copied
// to it, takes over once built, and moves its stores.

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;

async function json(method: string, path: string, body?: unknown, auth: string = ADMIN): Promise<any> {
  const res = await t.call(method, path, { auth, body });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  return res.status === 204 ? null : res.json();
}

async function newVersion(name: string, auth = t.auth): Promise<string> {
  const { id } = await json('POST', '/v1/versions', { name, phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true }, auth);
  await waitFor(async () => (await json('GET', `/v1/versions?versionId=${id}`, undefined, auth))[0]?.statusCode === Status.Done);
  return id;
}

const production = async (productId: string) =>
  (await t.pool.query<{ id: string }>('SELECT id FROM versions WHERE product_id = $1 AND is_production AND status = $2', [productId, Status.Done])).rows[0]?.id;
const follows = async (productId: string) =>
  (await t.pool.query<{ f: string | null }>('SELECT follows_product_id AS f FROM products WHERE id = $1', [productId])).rows[0]!.f;
const sourceOf = async (versionId: string) =>
  (await t.pool.query<{ p: string }>('SELECT src.product_id AS p FROM snapshots s JOIN snapshots src ON src.id = s.source_snapshot_id WHERE s.version_id = $1', [versionId])).rows[0]?.p;

let follower: { id: string; auth: string };

beforeAll(async () => {
  t = await setup();
  await json('PUT', '/v1/versions/production', { versionId: await newVersion('v1') }, t.auth);
  const { product, key } = await json('POST', '/admin/products', { name: 'Reseller storefront', startFrom: t.productId });
  follower = { id: product.id, auth: basic(key.id, key.secret) };
  await waitFor(async () => production(follower.id));
});
afterAll(async () => {
  await t.close();
});

describe('a storefront started from another', () => {
  it('follows it, and so does one started from that one', async () => {
    expect(await follows(follower.id)).toBe(t.productId);
    const { product } = await json('POST', '/admin/products', { name: 'Second brand', startFrom: follower.id });
    // It follows the storefront at the top, not the one in between.
    expect(await follows(product.id)).toBe(t.productId);
    expect((await json('GET', `/admin/products?productId=${product.id}`)).find((p: any) => p.id === product.id)).toMatchObject({ followsProductId: t.productId });
    expect(await follows(t.productId)).toBeNull();
  });

  it('gets each new production version there, which takes over once built and moves its stores', async () => {
    const before = (await production(follower.id))!;
    const { id: store } = await json('POST', '/v1/tenants', { ...OWNER, name: 'Customer store' }, follower.auth);
    await waitFor(async () => (await t.pool.query('SELECT status FROM tenants WHERE id = $1', [store])).rows[0]?.status === Status.Done);

    const v2 = await newVersion('v2');
    await json('PUT', '/v1/versions/production', { versionId: v2 }, t.auth);
    const after = await waitFor(async () => {
      const id = await production(follower.id);
      return id !== before && id;
    });
    expect(await sourceOf(after)).toBe(t.productId);
    await waitFor(async () => {
      const { rows } = await t.pool.query('SELECT status, version_id FROM tenants WHERE id = $1', [store]);
      return rows[0].status === Status.Done && rows[0].version_id === after;
    });

    // Setting the same version again copies nothing new.
    const count = async () => (await t.pool.query('SELECT count(*)::int AS n FROM versions WHERE product_id = $1', [follower.id])).rows[0].n;
    const n = await count();
    await json('PUT', '/v1/versions/production', { versionId: v2 }, t.auth);
    expect(await count()).toBe(n);
  }, 60000);

  it('stops following when it publishes a version of its own, or when the admin says so', async () => {
    const own = await newVersion('own', follower.auth);
    await json('PUT', '/v1/versions/production', { versionId: own }, follower.auth);
    expect(await follows(follower.id)).toBeNull();

    await json('POST', `/admin/products/${follower.id}/versions/from-production`, { startFrom: t.productId });
    expect(await follows(follower.id)).toBe(t.productId);
    expect((await json('PUT', `/admin/products/${follower.id}`, { followsProductId: null })).followsProductId).toBeNull();
    expect((await t.call('PUT', `/admin/products/${follower.id}`, { auth: ADMIN, body: { followsProductId: t.productId } })).status).toBe(400);
  }, 60000);
});

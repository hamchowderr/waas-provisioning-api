import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Status } from '../src/status.ts';
import { setup, waitFor, type TestContext, OWNER } from './helpers.ts';

// A new production version takes the product's stores with it (waas-api-gyu), so none is left on an old version.

let t: TestContext;

async function newVersion(name: string): Promise<string> {
  const res = await t.call('POST', '/v1/versions', { body: { name, phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const id = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${id}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  return id;
}

async function newStore(name: string): Promise<string> {
  const res = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name } });
  const id = ((await res.json()) as { id: string }).id;
  await waitFor(async () => (await store(id)).status === Status.Done);
  return id;
}

async function store(id: string): Promise<{ status: number; version_id: string }> {
  return (await t.pool.query('SELECT status, version_id FROM tenants WHERE id = $1', [id])).rows[0];
}

async function setProduction(versionId: string, extra: object = {}) {
  const res = await t.call('PUT', '/v1/versions/production', { body: { versionId, ...extra } });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; movingStores: number };
}

beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.close();
});

describe('a new production version', () => {
  it('moves every ready store on another version to it', async () => {
    const v1 = await newVersion('v1');
    await setProduction(v1);
    const a = await newStore('Store A');
    const b = await newStore('Store B');

    const v2 = await newVersion('v2');
    expect(await setProduction(v2)).toEqual({ id: v2, movingStores: 2 });
    for (const id of [a, b]) {
      await waitFor(async () => (await store(id)).status === Status.Done && (await store(id)).version_id === v2);
      expect(t.provisioner.stores.get(id)?.versionId).toBe(v2);
    }

    // Setting it again moves nothing: every store is on it already.
    expect(await setProduction(v2)).toEqual({ id: v2, movingStores: 0 });
  });

  it('leaves the stores alone with moveStores false', async () => {
    const [{ id: current }] = (await t.pool.query('SELECT id FROM versions WHERE product_id = $1 AND is_production', [t.productId])).rows;
    const c = await newStore('Store C');
    const v3 = await newVersion('v3');
    expect(await setProduction(v3, { moveStores: false })).toEqual({ id: v3, movingStores: 0 });
    expect(await store(c)).toEqual({ status: Status.Done, version_id: current });
  });

  it('moves a busy store too, once its job is done (waas-api-lca1)', async () => {
    const e = await newStore('Store E');
    // E is busy: a job of its own (a site type change, say) still runs when the new version goes live.
    await t.pool.query('UPDATE tenants SET status = $2 WHERE id = $1', [e, Status.Pending]);
    const v5 = await newVersion('v5');
    const { movingStores } = await setProduction(v5);
    expect(movingStores).toBeGreaterThanOrEqual(1);
    await waitFor(async () => (await store(e)).version_id === v5 && (await store(e)).status === Status.Done);
    expect(t.provisioner.stores.get(e)?.versionId).toBe(v5);
  });

  it('gives a moved store the current store setup, which it missed while moving (waas-api-xkj.3)', async () => {
    const f = await newStore('Store F');
    // F missed the setup rollout: the fake keeps an older size until ensureStoreSetup runs.
    t.provisioner.stores.get(f)!.size = 'large';
    const v6 = await newVersion('v6');
    await setProduction(v6);
    await waitFor(async () => (await store(f)).version_id === v6 && (await store(f)).status === Status.Done);
    expect(t.provisioner.stores.get(f)?.size).toBe('small');
  });

  it('finishes the move when the store setup after it fails', async () => {
    const g = await newStore('Store G');
    t.provisioner.failNext('ensureStoreSetup');
    const v7 = await newVersion('v7');
    await setProduction(v7);
    await waitFor(async () => (await store(g)).version_id === v7 && (await store(g)).status === Status.Done);
  });

  it('puts a store back on its version when its move fails', async () => {
    const [{ id: current }] = (await t.pool.query('SELECT id FROM versions WHERE product_id = $1 AND is_production', [t.productId])).rows;
    const d = await newStore('Store D');
    // Only D moves this time: the others are left out as a failed store would be.
    await t.pool.query('UPDATE tenants SET status = $3 WHERE product_id = $1 AND id <> $2', [t.productId, d, Status.Failed]);

    const v4 = await newVersion('v4');
    // Every try of the move fails (the first and its three retries); the move back works.
    t.provisioner.failNext('moveStore', 4);
    expect(await setProduction(v4)).toEqual({ id: v4, movingStores: 1 });
    await waitFor(async () => (await store(d)).status !== Status.Pending, 60000);

    expect(await store(d)).toEqual({ status: Status.Done, version_id: current });
    expect(t.provisioner.stores.get(d)?.versionId).toBe(current);
    const { rows: failures } = await t.pool.query("SELECT tenant_id FROM job_failures WHERE job_type = 'tenant.move'");
    expect(failures.map((f) => f.tenant_id)).toEqual([d]);
  }, 90000);
});

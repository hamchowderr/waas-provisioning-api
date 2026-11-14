import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pruneOldBaseSnapshots, pruneOldVersions } from '../src/prune.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.close();
});

const versionStatus = async (id: string) => ((await (await t.call('GET', `/v1/versions?versionId=${id}`)).json()) as any[])[0]?.statusCode;

async function newVersion(name: string): Promise<string> {
  const { id } = (await (await t.call('POST', '/v1/versions', { body: { name, phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } })).json()) as { id: string };
  await waitFor(async () => (await versionStatus(id)) === Status.Done);
  return id;
}

const age = (table: string, id: string, days: number) => t.pool.query(`UPDATE ${table} SET date_created = now() - make_interval(days => $2) WHERE id = $1`, [id, days]);

describe('pruning old platform versions', () => {
  it('keeps production, the way back, versions stores use and anything new, and removes the rest', async () => {
    const used = await newVersion('used');
    await t.call('PUT', '/v1/versions/production', { body: { versionId: used } });
    const tenant = (await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'On An Old Version' } })).json()) as { externalId: string };
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    const oldest = await newVersion('oldest');
    const older = await newVersion('older');
    const wayBack = await newVersion('way-back');
    const production = await newVersion('production');
    await t.call('PUT', '/v1/versions/production', { body: { versionId: production } });
    await age('versions', used, 9);
    await age('versions', oldest, 8);
    await age('versions', older, 7);
    await age('versions', wayBack, 6);
    await age('versions', production, 5);
    const brandNew = await newVersion('brand-new');

    // A seller's own product is never pruned.
    expect(await pruneOldVersions(t.pool, t.boss, [])).toEqual([]);

    // brand-new was built after production and is under a day old; way-back is the newest built version before production.
    const removed = await pruneOldVersions(t.pool, t.boss, [t.productId]);
    expect(removed.sort()).toEqual([oldest, older].sort());
    await waitFor(async () => (await versionStatus(oldest)) === undefined && (await versionStatus(older)) === undefined);
    expect(t.provisioner.versions.has(oldest)).toBe(false);
    for (const kept of [used, wayBack, production, brandNew]) expect(await versionStatus(kept)).toBe(Status.Done);

    // A day on, an unpromoted build after production goes; the way back still stays.
    await age('versions', brandNew, 2);
    expect(await pruneOldVersions(t.pool, t.boss, [t.productId])).toEqual([brandNew]);
    expect(await versionStatus(wayBack)).toBe(Status.Done);
  });

  it('keeps the newest base snapshots of each platform product and any one a version is being built from', async () => {
    const insert = async (name: string, days: number) =>
      (await t.pool.query(`INSERT INTO base_snapshots (product_id, name, comment, date_created) VALUES ($1, $2, 'x', now() - make_interval(days => $3)) RETURNING id`, [t.productId, name, days])).rows[0].id as string;
    const a = await insert('a', 9);
    const b = await insert('b', 8);
    const c = await insert('c', 7);
    const d = await insert('d', 6);
    const e = await insert('e', 5);
    // b is being copied into a version right now.
    const v = (await t.pool.query("SELECT id FROM versions WHERE product_id = $1 LIMIT 1", [t.productId])).rows[0].id;
    await t.pool.query(`INSERT INTO snapshots (product_id, version_id, name, status, source_base_snapshot_id) VALUES ($1, $2, 'copy', $3, $4)`, [t.productId, v, Status.Pending, b]);

    expect(await pruneOldBaseSnapshots(t.pool, t.boss, [])).toEqual([]);
    const removed = await pruneOldBaseSnapshots(t.pool, t.boss, [t.productId]);
    expect(removed.sort()).toEqual([a, c].sort());
    const { rows } = await t.pool.query('SELECT id FROM base_snapshots WHERE product_id = $1', [t.productId]);
    expect(rows.map((r) => r.id).sort()).toEqual([b, d, e].sort());
  });
});

describe('backups of deleted stores', () => {
  const backups = async (tenantId: string) => (await t.pool.query('SELECT id FROM tenant_backups WHERE tenant_id = $1', [tenantId])).rows;

  async function storeWithBackup(name: string) {
    const tenant = (await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name } })).json()) as { id: string; externalId: string };
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    await t.call('POST', `/v1/tenants/backups?externalId=${tenant.externalId}`);
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants/backups?externalId=${tenant.externalId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    return tenant;
  }
  const admin = (method: string, path: string) => t.call(method, `/admin${path}`, { auth: `Bearer ${t.deps.config.adminToken}` });

  it('keeps them by default, and deletes them with the store when asked', async () => {
    const kept = await storeWithBackup('Keeps Its Backups');
    const dropped = await storeWithBackup('Drops Its Backups');
    expect((await admin('DELETE', `/tenants/${kept.id}?backups=nope`)).status).toBe(400);
    expect((await admin('DELETE', `/tenants/${kept.id}`)).status).toBe(200);
    expect((await admin('DELETE', `/tenants/${dropped.id}?backups=delete`)).status).toBe(200);
    await waitFor(async () => (await t.pool.query('SELECT 1 FROM tenants WHERE id = ANY($1)', [[kept.id, dropped.id]])).rowCount === 0);
    expect(await backups(kept.id)).toHaveLength(1);
    expect(await backups(dropped.id)).toEqual([]);

    // The kept ones can be cleared later, once the store is gone.
    const live = await storeWithBackup('Still Live');
    expect((await admin('POST', `/tenants/${live.id}/backups/purge`)).status).toBe(400);
    expect((await admin('POST', '/tenants/not-a-uuid/backups/purge')).status).toBe(404);
    const res = await admin('POST', `/tenants/${kept.id}/backups/purge`);
    expect(await res.json()).toEqual({ tenantId: kept.id, deleted: 1 });
    expect(await backups(kept.id)).toEqual([]);
    expect(await backups(live.id)).toHaveLength(1);
  });
});

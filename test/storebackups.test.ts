import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJobHandlers } from '../src/jobs.ts';
import { Status } from '../src/status.ts';
import {
  loadStoreBackupConfig,
  pruneScheduledBackups,
  queueScheduledBackups,
  scheduledBackupsDue,
  startStoreBackups,
  STORE_BACKUPS_QUEUE,
} from '../src/storebackups.ts';
import { setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;

type Tenant = { id: string; externalId: string };
const getTenant = async (externalId: string) => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[])[0];
const backups = async (externalId: string) => (await (await t.call('GET', `/v1/tenants/backups?externalId=${externalId}`)).json()) as any[];
const scheduled = async (tenantId: string) =>
  (await t.pool.query("SELECT id, status FROM tenant_backups WHERE tenant_id = $1 AND reason = 'scheduled' ORDER BY date_created", [tenantId])).rows;

async function newTenant(name: string): Promise<Tenant> {
  const tenant = (await (await t.call('POST', '/v1/tenants', { body: { name } })).json()) as Tenant;
  await waitFor(async () => (await getTenant(tenant.externalId))?.statusCode === Status.Done);
  return tenant;
}

const config = { schedule: '0 9 * * *', keepDaily: 2, keepWeekly: 1 };
const quiet = { log: () => {}, error: () => {} };

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});
afterAll(async () => {
  await t.close();
});

describe('scheduled store backups', () => {
  it('is on by default and off with STORE_BACKUP=off', () => {
    expect(loadStoreBackupConfig({})).toEqual({ schedule: '0 9 * * *', keepDaily: 7, keepWeekly: 4 });
    expect(loadStoreBackupConfig({ STORE_BACKUP: 'off' })).toBeUndefined();
    expect(loadStoreBackupConfig({ STORE_BACKUP_SCHEDULE: '0 5 * * *', STORE_BACKUP_KEEP_DAILY: '3' })).toMatchObject({ schedule: '0 5 * * *', keepDaily: 3 });
  });

  it('backs up every live store nightly, skips suspended ones, and never doubles up on a re-run', async () => {
    const handlers = createJobHandlers(t.pool, t.provisioner, t.deps.secrets, 90);
    const live = await newTenant('Nightly One');
    const held = await newTenant('Nightly Held');
    await t.call('POST', `/v1/tenants/suspend?externalId=${held.externalId}`, { body: { takeBackup: false } });
    await waitFor(async () => (await getTenant(held.externalId)).statusCode === Status.Done);

    expect(await scheduledBackupsDue(t.pool)).toBe(true);
    // Starting with nothing taken yet queues a catch-up run right away.
    await startStoreBackups(t.boss, t.pool, t.provisioner, handlers, config, { pollingIntervalSeconds: 0.5, retryDelaySeconds: 1, log: quiet });
    expect((await t.boss.getSchedules()).map((s) => s.name)).toContain(STORE_BACKUPS_QUEUE);

    await waitFor(async () => (await scheduled(live.id))[0]?.status === Status.Done, 20000);
    const [taken] = await backups(live.externalId);
    expect(taken).toMatchObject({ reason: 'scheduled', statusName: 'Done' });
    expect(t.provisioner.backups.get(taken.id)?.storeId).toBe(live.id);
    expect(await scheduled(held.id)).toEqual([]);
    expect(await scheduledBackupsDue(t.pool)).toBe(false);

    // A second run the same night queues nothing.
    expect(await queueScheduledBackups(t.pool, t.boss)).toBe(0);
  }, 30000);

  it('keeps the newest backup per day and per week, and drops unfinished ones past the daily window', async () => {
    const tenant = await newTenant('Retention');
    const insert = (daysAgo: number, status: number) =>
      t.pool
        .query(
          `INSERT INTO tenant_backups (product_id, tenant_id, external_id, reason, status, date_created)
           VALUES ($1, $2, $3, 'scheduled', $4, now() - make_interval(days => $5)) RETURNING id`,
          [t.productId, tenant.id, tenant.externalId, status, daysAgo],
        )
        .then((r) => r.rows[0].id as string);
    const d0 = await insert(0, Status.Done);
    const d1 = await insert(1, Status.Done);
    const d2 = await insert(2, Status.Done);
    const d30 = await insert(30, Status.Done);
    const failedOld = await insert(5, Status.Failed);
    const failedNew = await insert(1, Status.Failed);
    // Manual and suspend backups are never pruned here.
    await t.pool.query("INSERT INTO tenant_backups (product_id, tenant_id, external_id, reason, status, date_created) VALUES ($1, $2, $3, 'manual', 1, now() - interval '60 days')", [
      t.productId,
      tenant.id,
      tenant.externalId,
    ]);

    await pruneScheduledBackups(t.pool, t.provisioner, { keepDaily: 2, keepWeekly: 1 });
    const left = (await t.pool.query('SELECT id, reason FROM tenant_backups WHERE tenant_id = $1', [tenant.id])).rows;
    const ids = left.map((r) => r.id);
    expect(ids).toContain(d0);
    expect(ids).toContain(d1);
    expect(ids).toContain(failedNew);
    expect(ids).not.toContain(d2);
    expect(ids).not.toContain(d30);
    expect(ids).not.toContain(failedOld);
    expect(left.filter((r) => r.reason === 'manual')).toHaveLength(1);
  });

  it("leaves a deleted store's scheduled backups to the deleted-tenant retention", async () => {
    const tenant = await newTenant('Gone Store');
    await t.pool.query(
      `INSERT INTO tenant_backups (product_id, tenant_id, external_id, reason, status, date_created, tenant_deleted_at)
       VALUES ($1, $2, $3, 'scheduled', 1, now() - interval '40 days', now())`,
      [t.productId, tenant.id, tenant.externalId],
    );
    await pruneScheduledBackups(t.pool, t.provisioner, { keepDaily: 1, keepWeekly: 1 });
    expect((await t.pool.query('SELECT 1 FROM tenant_backups WHERE tenant_id = $1 AND tenant_deleted_at IS NOT NULL', [tenant.id])).rowCount).toBe(1);
  });

  it('records a backup that keeps failing (after its one retry) as Failed, and the job failure', async () => {
    await t.pool.query("DELETE FROM tenant_backups WHERE reason = 'scheduled'");
    const a = await newTenant('Fails Tonight');
    t.provisioner.failNext('backupStore', 100);
    expect(await queueScheduledBackups(t.pool, t.boss)).toBeGreaterThan(1);
    const failed = await waitFor(async () => (await scheduled(a.id)).find((b) => b.status === Status.Failed), 30000);
    t.provisioner.failNext('backupStore', 0);
    const { rows } = await t.pool.query("SELECT job_type FROM job_failures WHERE job_data->>'backupId' = $1", [failed.id]);
    expect(rows).toEqual([{ job_type: 'tenant.backup' }]);
    // The store itself is untouched.
    expect((await getTenant(a.externalId)).statusCode).toBe(Status.Done);
  }, 40000);
});

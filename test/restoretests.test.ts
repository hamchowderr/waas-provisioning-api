import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHealth } from '../src/health.ts';
import { cleanUpInterruptedTests, loadRestoreTestConfig, RESTORE_TEST_QUEUE, restoreTestStatus, runRestoreTest, startRestoreTests } from '../src/restoretests.ts';
import { Status } from '../src/status.ts';
import { setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;

type Tenant = { id: string; externalId: string };
const getTenant = async (externalId: string) => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[])[0];

async function newTenant(name: string): Promise<Tenant> {
  const tenant = (await (await t.call('POST', '/v1/tenants', { body: { name } })).json()) as Tenant;
  await waitFor(async () => (await getTenant(tenant.externalId))?.statusCode === Status.Done);
  return tenant;
}

/** A finished nightly backup of the store, `hoursAgo` old, that the fake provisioner holds. */
async function nightlyBackup(tenant: Tenant, hoursAgo = 2): Promise<string> {
  const { rows } = await t.pool.query(
    `INSERT INTO tenant_backups (product_id, tenant_id, external_id, reason, status, date_created)
     VALUES ($1, $2, $3, 'scheduled', $4, now() - make_interval(hours => $5)) RETURNING id`,
    [t.productId, tenant.id, tenant.externalId, Status.Done, hoursAgo],
  );
  t.provisioner.backups.set(rows[0].id, { storeId: tenant.id, sizeBytes: 1024 });
  return rows[0].id;
}

const tests = async () => (await t.pool.query('SELECT tenant_id, backup_id, status, error, details FROM restore_tests ORDER BY started_at')).rows;
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

describe('nightly restore test', () => {
  it('is on by default and off with RESTORE_TEST=off', () => {
    expect(loadRestoreTestConfig({})).toEqual({ schedule: '0 11 * * *' });
    expect(loadRestoreTestConfig({ RESTORE_TEST_SCHEDULE: '0 5 * * *' })).toEqual({ schedule: '0 5 * * *' });
    expect(loadRestoreTestConfig({ RESTORE_TEST: 'off' })).toBeUndefined();
  });

  it('does nothing while no store has a recent nightly backup', async () => {
    const old = await newTenant('Old Backup Only');
    await nightlyBackup(old, 72);
    expect(await runRestoreTest(t.pool, t.provisioner)).toBeUndefined();
    expect(await restoreTestStatus(t.pool, true)).toEqual({ ok: true, status: 'never', lastPassedAt: null });
  });

  it("restores a live store's newest nightly backup, never a suspended store's, and tests the store tested longest ago next", async () => {
    const a = await newTenant('Restore A');
    const b = await newTenant('Restore B');
    const held = await newTenant('Restore Held');
    await nightlyBackup(a, 30);
    const aNewest = await nightlyBackup(a, 2);
    const bBackup = await nightlyBackup(b, 2);
    await nightlyBackup(held, 2);
    await t.call('POST', `/v1/tenants/suspend?externalId=${held.externalId}`, { body: { takeBackup: false } });
    await waitFor(async () => (await getTenant(held.externalId)).statusCode === Status.Done);

    const first = await runRestoreTest(t.pool, t.provisioner);
    expect(first).toMatchObject({ tenantId: a.id, backupId: aNewest, status: 'passed' });
    expect(t.provisioner.restoreTests.at(-1)).toEqual({ testId: first!.id, backupId: aNewest });
    const second = await runRestoreTest(t.pool, t.provisioner);
    expect(second).toMatchObject({ tenantId: b.id, backupId: bBackup, status: 'passed' });
    // Both tested once: A again, the longest ago.
    expect((await runRestoreTest(t.pool, t.provisioner))?.tenantId).toBe(a.id);

    const rows = await tests();
    expect(rows.map((r) => r.tenant_id)).not.toContain(held.id);
    expect(rows[0]).toMatchObject({ status: 'passed', error: null, details: { tables: 12, posts: 3 } });
    // The real store is untouched.
    expect((await getTenant(a.externalId)).statusCode).toBe(Status.Done);
    expect(t.provisioner.stores.has(a.id)).toBe(true);

    const status = await restoreTestStatus(t.pool, true);
    expect(status).toMatchObject({ ok: true, status: 'passed' });
    expect(status.lastPassedAt).not.toBeNull();
    expect((await checkHealth(t.pool, t.boss, false, true)).restoreTest.ok).toBe(true);
  });

  it('records a failed restore, emails the admins, and reports it on /health until a test passes', async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push({ to: body.to?.[0]?.email ?? body.to, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: 'msg' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const mail = { key: 'key', from: 'no-reply@waas.example', brand: 'WaaS', apiUrl: 'https://tosend.example' };

    t.provisioner.failNext('testRestore');
    const failed = await runRestoreTest(t.pool, t.provisioner, { mail, to: ['ops@waas.example'] }, fetchFn);
    expect(failed).toMatchObject({ status: 'failed', error: 'FakeProvisioner: testRestore failed (injected)' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/^Failed: restore test of Restore /);
    expect(sent[0]!.text).toContain('FakeProvisioner: testRestore failed (injected)');

    expect(await restoreTestStatus(t.pool, true)).toMatchObject({ ok: false, status: 'failed' });
    const res = await t.call('GET', '/health', { auth: null });
    // Informational: the API itself is still healthy. Off in the test config, so reported as off.
    expect(res.status).toBe(200);
    expect((await checkHealth(t.pool, t.boss, false, true)).restoreTest.ok).toBe(false);
    expect((await checkHealth(t.pool, t.boss, false, false)).restoreTest).toMatchObject({ ok: true, status: 'off' });

    expect((await runRestoreTest(t.pool, t.provisioner))?.status).toBe('passed');
    expect((await restoreTestStatus(t.pool, true)).ok).toBe(true);
  });

  it('is stale when nothing passed in about two days', async () => {
    await t.pool.query("UPDATE restore_tests SET started_at = started_at - interval '3 days', finished_at = finished_at - interval '3 days'");
    expect(await restoreTestStatus(t.pool, true)).toMatchObject({ ok: false, status: 'passed' });
  });

  it('marks a test cut off by a restart as failed and deletes its test store', async () => {
    const tenant = await newTenant('Cut Off');
    const backupId = await nightlyBackup(tenant);
    const { rows } = await t.pool.query("INSERT INTO restore_tests (tenant_id, backup_id, started_at) VALUES ($1, $2, now() - interval '4 hours') RETURNING id", [tenant.id, backupId]);
    let deleted: string | undefined;
    const provisioner = Object.create(t.provisioner, { deleteRestoreTest: { value: async ({ testId }: { testId: string }) => void (deleted = testId) } });
    expect(await cleanUpInterruptedTests(t.pool, provisioner)).toBe(1);
    expect(deleted).toBe(rows[0].id);
    expect((await t.pool.query('SELECT status, error FROM restore_tests WHERE id = $1', [rows[0].id])).rows[0]).toMatchObject({ status: 'failed' });
  });

  it('schedules the nightly run, runs a catch-up when one is due, and unschedules when off', async () => {
    await t.pool.query('DELETE FROM restore_tests');
    await startRestoreTests(t.boss, t.pool, t.provisioner, { schedule: '0 11 * * *' }, {}, { pollingIntervalSeconds: 0.5, log: quiet });
    expect((await t.boss.getSchedules()).map((s) => s.name)).toContain(RESTORE_TEST_QUEUE);
    await waitFor(async () => (await tests()).some((r) => r.status === 'passed'), 20000);

    await startRestoreTests(t.boss, t.pool, t.provisioner, undefined);
    expect((await t.boss.getSchedules()).map((s) => s.name)).not.toContain(RESTORE_TEST_QUEUE);
  }, 30000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeExpiredBackups, stopBuiltVersions } from '../src/jobs.ts';
import type { Provisioner } from '../src/provisioner/provisioner.ts';
import { Status } from '../src/status.ts';
import { setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;

type Tenant = { id: string; externalId: string };
const getTenant = async (externalId: string) => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[])[0];
const backups = async (externalId: string) => (await (await t.call('GET', `/v1/tenants/backups?externalId=${externalId}`)).json()) as any[];
const settled = (externalId: string) => waitFor(async () => (await getTenant(externalId))?.statusCode === Status.Done);

async function newTenant(name: string): Promise<Tenant> {
  const tenant = (await (await t.call('POST', '/v1/tenants', { body: { name } })).json()) as Tenant;
  await settled(tenant.externalId);
  return tenant;
}

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

describe('suspend, resume and backups', () => {
  it('backs up by default (empty body or []) and not with takeBackup: false', async () => {
    const a = await newTenant('Default Backup');
    const res = (await (await t.call('POST', `/v1/tenants/suspend?externalId=${a.externalId}`, { body: [] })).json()) as any;
    expect(res.backupId).toEqual(expect.any(String));
    const b = await newTenant('No Backup');
    const res2 = (await (await t.call('POST', `/v1/tenants/suspend?externalId=${b.externalId}`, { body: { takeBackup: false } })).json()) as any;
    expect(res2.backupId).toBeNull();
    await settled(b.externalId);
    expect(await backups(b.externalId)).toEqual([]);
    expect(t.provisioner.stores.get(b.id)!.suspended).toBe(true);
  });

  it('runs a delete sent right after a suspend once the backup is done, and keeps the backup', async () => {
    const tenant = await newTenant('Cancelled Subscription');
    const { backupId } = (await (await t.call('POST', `/v1/tenants/suspend?externalId=${tenant.externalId}`, { body: { takeBackup: true } })).json()) as any;
    await t.call('DELETE', `/v1/tenants?externalId=${tenant.externalId}`);
    await waitFor(async () => !(await getTenant(tenant.externalId)));
    const [backup] = await backups(tenant.externalId);
    expect(backup).toMatchObject({ id: backupId, statusCode: Status.Done, tenantId: tenant.id });
    const { rows } = await t.pool.query('SELECT tenant_deleted_at FROM tenant_backups WHERE id = $1', [backupId]);
    expect(rows[0].tenant_deleted_at).toBeInstanceOf(Date);
    // By tenantId too, after deletion.
    expect(await (await t.call('GET', `/v1/tenants/backups?tenantId=${tenant.id}`)).json()).toHaveLength(1);
  });

  it('purges backups only once the deleted tenant passes the retention period', async () => {
    const live = await newTenant('Still Here');
    await t.call('POST', `/v1/tenants/backups?externalId=${live.externalId}`);
    await waitFor(async () => (await backups(live.externalId))[0]?.statusCode === Status.Done);
    await t.pool.query(
      `INSERT INTO tenant_backups (product_id, tenant_id, external_id, reason, status, tenant_deleted_at) VALUES
         ($1, gen_random_uuid(), 'gone-91-days', 'suspend', 1, now() - interval '91 days'),
         ($1, gen_random_uuid(), 'gone-89-days', 'suspend', 1, now() - interval '89 days')`,
      [t.productId],
    );
    expect(await purgeExpiredBackups(t.pool, t.provisioner, 90)).toBe(1);
    const left = (await t.pool.query('SELECT external_id FROM tenant_backups')).rows.map((r) => r.external_id);
    expect(left).not.toContain('gone-91-days');
    expect(left).toContain('gone-89-days');
    expect(left).toContain(live.externalId);
  });

  it('stops the site of every built version, and leaves one still being built', async () => {
    const versions = await t.pool.query<{ id: string; status: number }>(
      `INSERT INTO versions (id, product_id, name, domain, wordpress_version, php_version, status) VALUES
         (gen_random_uuid(), $1, 'Built', 'built.versions.waas.example', '6.8', '8.3', $2),
         (gen_random_uuid(), $1, 'Building', 'building.versions.waas.example', '6.8', '8.3', $3)
       RETURNING id, status`,
      [t.productId, Status.Done, Status.Pending],
    );
    const stopped: string[] = [];
    const provisioner = {
      async stopVersion({ versionId }: { versionId: string }) {
        if (versionId === built) throw new Error('Coolify down');
        stopped.push(versionId);
      },
    } as unknown as Provisioner;
    const built = versions.rows.find((v) => v.status === Status.Done)!.id;
    const building = versions.rows.find((v) => v.status === Status.Pending)!.id;
    // One version failing to stop doesn't stop the rest, or the maintenance after it.
    await stopBuiltVersions(t.pool, provisioner);
    expect(stopped).not.toContain(building);
    const done = (await t.pool.query<{ id: string }>('SELECT id FROM versions WHERE status = $1', [Status.Done])).rows.map((r) => r.id);
    expect(stopped.sort()).toEqual(done.filter((id) => id !== built).sort());
  });

  it('schedules the purge daily on the maintenance queue', async () => {
    const schedules = await t.boss.getSchedules();
    expect(schedules.map((s) => s.name)).toContain('maintenance');
  });

  it('marks the backup and the tenant Failed when the suspend backup keeps failing', async () => {
    const tenant = await newTenant('Backup Fails');
    t.provisioner.failNext('backupStore', 10);
    const { backupId } = (await (await t.call('POST', `/v1/tenants/suspend?externalId=${tenant.externalId}`, { body: {} })).json()) as any;
    await waitFor(async () => (await getTenant(tenant.externalId)).statusCode === Status.Failed, 30000);
    t.provisioner.failNext('backupStore', 0);
    expect((await backups(tenant.externalId)).find((b) => b.id === backupId).statusCode).toBe(Status.Failed);
    // The store was not taken offline without its backup.
    expect(t.provisioner.stores.get(tenant.id)!.suspended).toBe(false);
  }, 40000);

  it('backs up a suspended tenant', async () => {
    const tenant = await newTenant('On Hold');
    await t.call('POST', `/v1/tenants/suspend?externalId=${tenant.externalId}`, { body: { takeBackup: false } });
    await settled(tenant.externalId);
    const res = await t.call('POST', `/v1/tenants/backups?externalId=${tenant.externalId}`);
    expect(res.status).toBe(200);
    await waitFor(async () => (await backups(tenant.externalId))[0]?.statusCode === Status.Done);
  });

  const deleteTenant = async (externalId: string) => {
    await t.call('DELETE', `/v1/tenants?externalId=${externalId}`);
    await waitFor(async () => !(await getTenant(externalId)));
  };
  const backUp = async (externalId: string) => {
    const { backupId } = (await (await t.call('POST', `/v1/tenants/backups?externalId=${externalId}`)).json()) as any;
    await waitFor(async () => (await backups(externalId)).find((b) => b.id === backupId)?.statusCode === Status.Done);
    return backupId as string;
  };
  const restore = (externalId: string, body: object = {}) => t.call('POST', `/v1/tenants/restore?externalId=${externalId}`, { body });

  it('restores from a chosen backup, with the options it had then', async () => {
    const tenant = await newTenant('Time Travel');
    await t.call('PUT', `/v1/tenants?externalId=${tenant.externalId}`, { body: { wpOptions: { era: 'first' } } });
    await settled(tenant.externalId);
    const first = await backUp(tenant.externalId);
    await t.call('PUT', `/v1/tenants?externalId=${tenant.externalId}`, { body: { wpOptions: { era: 'second' } } });
    await settled(tenant.externalId);
    await backUp(tenant.externalId);
    await deleteTenant(tenant.externalId);

    const res = await restore(tenant.externalId, { backupId: first });
    expect(res.status).toBe(200);
    await settled(tenant.externalId);
    expect(t.provisioner.stores.get(tenant.id)!.wpOptions.era).toBe('first');
    // Its backups no longer count down to deletion.
    const { rows } = await t.pool.query('SELECT tenant_deleted_at FROM tenant_backups WHERE tenant_id = $1', [tenant.id]);
    expect(rows.every((r) => r.tenant_deleted_at === null)).toBe(true);
  });

  it('refuses: no kept backup, a backup that is not this tenant\'s, or a domain now taken', async () => {
    const bare = await newTenant('No Backups Kept');
    await deleteTenant(bare.externalId);
    expect(((await (await restore(bare.externalId)).json()) as any).message).toMatch(/no backup to restore/);

    const a = await newTenant('Owner A');
    const b = await newTenant('Owner B');
    const backupOfB = await backUp(b.externalId);
    await backUp(a.externalId);
    await deleteTenant(a.externalId);
    expect((await restore(a.externalId, { backupId: backupOfB })).status).toBe(400);

    const c = (await (await t.call('POST', '/v1/tenants', { body: { name: 'Domain Owner', customDomainName: 'owned.example.com' } })).json()) as Tenant;
    await settled(c.externalId);
    await backUp(c.externalId);
    await deleteTenant(c.externalId);
    const squatter = (await (await t.call('POST', '/v1/tenants', { body: { name: 'Squatter', customDomainName: 'owned.example.com' } })).json()) as Tenant;
    await settled(squatter.externalId);
    expect(((await (await restore(c.externalId)).json()) as any).message).toMatch(/owned.example.com/);
  });

  it('restores by tenantId too', async () => {
    const tenant = await newTenant('By Id');
    await backUp(tenant.externalId);
    await deleteTenant(tenant.externalId);
    const res = await t.call('POST', `/v1/tenants/restore?tenantId=${tenant.id}`, { body: [] });
    expect(((await res.json()) as any).externalId).toBe(tenant.externalId);
    await settled(tenant.externalId);
  });

  it('answers 400 for an unknown tenant and [] for a tenant without backups', async () => {
    expect((await t.call('GET', '/v1/tenants/backups?externalId=nobody')).status).toBe(400);
    const tenant = await newTenant('No Backups Yet');
    expect(await backups(tenant.externalId)).toEqual([]);
  });
});

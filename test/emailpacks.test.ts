import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Status } from '../src/status.ts';
import { setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;

type Tenant = { id: string; externalId: string };
const getTenant = async (externalId: string) => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[])[0];
const settled = (externalId: string) => waitFor(async () => (await getTenant(externalId))?.statusCode === Status.Done);
const addPack = (query: string, body: unknown) => t.call('POST', `/v1/tenants/email-packs?${query}`, { body });

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

describe('email packs', () => {
  it('records a pack, answers with the total, and tells the store the total', async () => {
    const tenant = await newTenant('Pack Shop');
    const res = await addPack(`externalId=${tenant.externalId}`, { emails: 10000, reference: 'fluentcart-order-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: tenant.id, externalId: tenant.externalId, emailPacks: 10000 });
    expect((await getTenant(tenant.externalId)).statusCode).toBe(Status.Pending);
    await settled(tenant.externalId);
    expect(t.provisioner.stores.get(tenant.id)!.emailPacks).toBe(10000);

    // By tenantId too; the store gets the sum of every pack.
    expect(await (await addPack(`tenantId=${tenant.id}`, { emails: 5000, reference: 'fluentcart-order-2' })).json()).toMatchObject({ emailPacks: 15000 });
    await settled(tenant.externalId);
    expect(t.provisioner.stores.get(tenant.id)!.emailPacks).toBe(15000);
  });

  it('adds nothing for a reference the tenant already used, and answers the same', async () => {
    const tenant = await newTenant('Retry Shop');
    const first = await (await addPack(`externalId=${tenant.externalId}`, { emails: 2000, reference: 'order-7' })).json();
    await settled(tenant.externalId);
    const calls: number[] = [];
    const set = t.provisioner.setEmailPacks.bind(t.provisioner);
    t.provisioner.setEmailPacks = async (input) => {
      calls.push(input.purchased);
      return set(input);
    };
    try {
      const again = await addPack(`externalId=${tenant.externalId}`, { emails: 2000, reference: 'order-7' });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(first);
      // No job and no status change.
      expect((await getTenant(tenant.externalId)).statusCode).toBe(Status.Done);
      // Racing repeats add it once.
      const raced = await Promise.all([1, 2, 3].map(() => addPack(`externalId=${tenant.externalId}`, { emails: 300, reference: 'order-8' }).then((r) => r.json())));
      expect(raced.map((r: any) => r.emailPacks)).toEqual([2300, 2300, 2300]);
      await settled(tenant.externalId);
      const { rows } = await t.pool.query('SELECT reference, emails FROM tenant_email_packs WHERE tenant_id = $1 ORDER BY reference', [tenant.id]);
      expect(rows).toEqual([
        { reference: 'order-7', emails: 2000 },
        { reference: 'order-8', emails: 300 },
      ]);
      expect(calls).toEqual([2300]);
    } finally {
      t.provisioner.setEmailPacks = set;
    }

    // The same reference on another tenant is its own purchase.
    const other = await newTenant('Other Shop');
    expect(await (await addPack(`externalId=${other.externalId}`, { emails: 100, reference: 'order-7' })).json()).toMatchObject({ emailPacks: 100 });
  });

  it('validates the body', async () => {
    const tenant = await newTenant('Strict Shop');
    const bad = [
      {},
      { emails: 100 },
      { reference: 'x' },
      { emails: 0, reference: 'x' },
      { emails: 1000001, reference: 'x' },
      { emails: 1.5, reference: 'x' },
      { emails: '100', reference: 'x' },
      { emails: 100, reference: '' },
      { emails: 100, reference: 'r'.repeat(101) },
    ];
    for (const body of bad) {
      const res = await addPack(`externalId=${tenant.externalId}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await addPack(`externalId=${tenant.externalId}`, { emails: 1000000, reference: 'r'.repeat(100) })).status).toBe(200);
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM tenant_email_packs WHERE tenant_id = $1', [tenant.id]);
    expect(rows[0].n).toBe(1);
  });

  it('refuses an unknown tenant, a missing ref, and a tenant being removed or failed', async () => {
    const unknown = await addPack('externalId=store-9999', { emails: 100, reference: 'x' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as any).message).toBe('Tenant store-9999 not found');
    expect((await addPack('', { emails: 100, reference: 'x' })).status).toBe(400);

    const failed = await newTenant('Failed Shop');
    await t.pool.query('UPDATE tenants SET status = $2 WHERE id = $1', [failed.id, Status.Failed]);
    expect((await addPack(`externalId=${failed.externalId}`, { emails: 100, reference: 'x' })).status).toBe(400);
    await t.pool.query('UPDATE tenants SET status = $2 WHERE id = $1', [failed.id, Status.Removing]);
    expect((await addPack(`externalId=${failed.externalId}`, { emails: 100, reference: 'x' })).status).toBe(400);
  });

  it('marks the tenant Failed when the store cannot be told, and records the failure', async () => {
    const tenant = await newTenant('Broken Shop');
    t.provisioner.failNext('setEmailPacks', 10);
    try {
      await addPack(`externalId=${tenant.externalId}`, { emails: 100, reference: 'order-1' });
      await waitFor(async () => (await getTenant(tenant.externalId))?.statusCode === Status.Failed, 30_000);
    } finally {
      t.provisioner.failNext('setEmailPacks', 0);
    }
    const { rows } = await t.pool.query('SELECT job_type FROM job_failures WHERE tenant_id = $1', [tenant.id]);
    expect(rows).toEqual([{ job_type: 'tenant.email-packs' }]);
  }, 40_000);

  it('tells a store rolled back to a backup the total on record again', async () => {
    const tenant = await newTenant('Rolled Shop');
    await t.call('POST', `/v1/tenants/backups?externalId=${tenant.externalId}`);
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants/backups?externalId=${tenant.externalId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    await addPack(`externalId=${tenant.externalId}`, { emails: 700, reference: 'order-1' });
    await settled(tenant.externalId);
    t.provisioner.stores.get(tenant.id)!.emailPacks = 0; // what the backup's database held
    const [backup] = (await (await t.call('GET', `/v1/tenants/backups?externalId=${tenant.externalId}`)).json()) as any[];
    const res = await t.call('POST', `/admin/tenants/${tenant.id}/restore`, { body: { backupId: backup.id, takeBackup: false }, auth: `Bearer ${TEST_ADMIN_TOKEN}` });
    expect(res.status).toBe(200);
    await settled(tenant.externalId);
    expect(t.provisioner.stores.get(tenant.id)!.emailPacks).toBe(700);
  });
});

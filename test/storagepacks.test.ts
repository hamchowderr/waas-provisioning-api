// Storage packs (PUT /v1/tenants/storage-packs): 25 GB each on top of the plan's storage, set as a monthly count.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORAGE_PACK_GB } from '../src/plans.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;

const getTenant = async (externalId: string) => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[])[0];
const setPacks = (query: string, body: unknown) => t.call('PUT', `/v1/tenants/storage-packs?${query}`, { body });

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});
afterAll(async () => t?.close());

describe('storage packs', () => {
  it('sets the count, tells the store the storage it adds, shows it on the tenant, and 0 ends them', async () => {
    const tenant = (await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Big Media' } })).json()) as { id: string; externalId: string };
    await waitFor(async () => (await getTenant(tenant.externalId))?.statusCode === Status.Done);
    expect((await getTenant(tenant.externalId)).storagePacks).toBeUndefined();

    const res = await setPacks(`externalId=${tenant.externalId}`, { packs: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: tenant.id, externalId: tenant.externalId, storagePacks: 2, storagePacksGb: 2 * STORAGE_PACK_GB });
    await waitFor(async () => t.provisioner.stores.get(tenant.id)!.storagePacksGb === 2 * STORAGE_PACK_GB);
    expect(await getTenant(tenant.externalId)).toMatchObject({ storagePacks: 2, statusCode: Status.Done });

    // The same count again is fine (a retry), and 0 ends them.
    expect((await setPacks(`tenantId=${tenant.id}`, { packs: 2 })).status).toBe(200);
    expect((await setPacks(`tenantId=${tenant.id}`, { packs: 0 })).status).toBe(200);
    await waitFor(async () => t.provisioner.stores.get(tenant.id)!.storagePacksGb === 0);
    expect((await getTenant(tenant.externalId)).storagePacks).toBeUndefined();
  });

  it('refuses counts that aren’t whole numbers from 0 to 20, and unknown tenants', async () => {
    for (const bad of [{}, { packs: -1 }, { packs: 21 }, { packs: 1.5 }, { packs: '1' }]) expect((await setPacks('externalId=whatever', bad)).status).toBe(400);
    expect((await setPacks('externalId=store-9999', { packs: 1 })).status).toBe(400);
  });
});

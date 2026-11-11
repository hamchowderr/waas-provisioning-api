// Care (PUT /v1/tenants/care): the care package bought for a store on the shop and this month's time, for the dashboard.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { careOf } from '../src/care.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;

const getTenant = async (externalId: string) => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[])[0];
const setCare = (query: string, body: unknown) => t.call('PUT', `/v1/tenants/care?${query}`, { body });
const thisMonth = () => new Date().toISOString().slice(0, 7);

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});
afterAll(async () => t?.close());

describe('care', () => {
  it('records the package and time, shows it on the tenant, and null ends it', async () => {
    const tenant = (await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Cared For' } })).json()) as { id: string; externalId: string };
    await waitFor(async () => (await getTenant(tenant.externalId))?.statusCode === Status.Done);
    expect((await getTenant(tenant.externalId)).care).toBeUndefined();

    const body = { package: 'Care Plus', minutes: 120, used: 40, extra: 60, answer: '1 business day', month: thisMonth() };
    const res = await setCare(`externalId=${tenant.externalId}`, body);
    expect(res.status).toBe(200);
    const care = { package: 'Care Plus', minutes: 120, used: 40, left: 80, extra: 60, answer: '1 business day', month: thisMonth() };
    expect(await res.json()).toEqual({ tenantId: tenant.id, externalId: tenant.externalId, care });
    expect((await getTenant(tenant.externalId)).care).toEqual(care);
    const detail = await t.call('GET', `/admin/tenants/${tenant.id}`, { auth: `Bearer ${TEST_ADMIN_TOKEN}` });
    expect(((await detail.json()) as any).care).toEqual(care);

    // A retry changes nothing, and null ends it.
    expect((await setCare(`tenantId=${tenant.id}`, body)).status).toBe(200);
    const ended = await setCare(`tenantId=${tenant.id}`, { package: null });
    expect(await ended.json()).toMatchObject({ care: null });
    expect((await getTenant(tenant.externalId)).care).toBeUndefined();
  });

  it('refuses bad values and unknown tenants', async () => {
    for (const bad of [{}, { package: '' }, { package: 'Care', minutes: -1 }, { package: 'Care', month: '2026-13' }, { package: 'Care', other: 1 }]) {
      expect((await setCare('externalId=whatever', bad)).status).toBe(400);
    }
    expect((await setCare('externalId=store-9999', { package: 'Care' })).status).toBe(400);
  });

  it('starts a new month with all its time', () => {
    const stored = { package: 'Care', minutes: 30, used: 30, extra: 0, answer: '', month: '2026-10' };
    expect(careOf(stored, new Date('2026-10-20T12:00:00Z'))).toMatchObject({ used: 30, left: 0, month: '2026-10' });
    // The shop's time zone may still be on the last day of October.
    expect(careOf(stored, new Date('2026-11-01T05:00:00Z'))).toMatchObject({ used: 30, month: '2026-10' });
    expect(careOf(stored, new Date('2026-11-03T12:00:00Z'))).toMatchObject({ used: 0, left: 30, month: '2026-11' });
  });
});

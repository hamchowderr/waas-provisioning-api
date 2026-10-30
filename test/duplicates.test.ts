import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Status } from '../src/status.ts';
import { setup, waitFor, type TestContext, OWNER } from './helpers.ts';

let t: TestContext;
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

describe('duplicate externalId and domain on POST /v1/tenants', () => {
  it('answers a repeat of the same create with the store it already made', async () => {
    const body = { name: 'Repeat', externalId: 'store-repeat-1', customDomainName: 'repeat-1.example.com', wordPressUserName: 'a', wordPressUserEmail: 'a@example.com' };
    const first = await t.call('POST', '/v1/tenants', { body });
    expect(first.status).toBe(200);
    const created = await first.json();
    const again = await t.call('POST', '/v1/tenants', { body });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(created);
    expect(((await (await t.call('GET', '/v1/tenants?externalId=store-repeat-1')).json()) as any[]).length).toBe(1);
  });

  it('answers 409 to an externalId already used by a different store, and leaves that store alone', async () => {
    const first = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'First', externalId: 'store-dup-1' } });
    expect(first.status).toBe(200);
    const second = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Second', externalId: 'store-dup-1' } });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ statusCode: 409, message: 'externalId store-dup-1 is already in use by another store' });
    const otherDomain = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'First', externalId: 'store-dup-1', customDomainName: 'elsewhere.example.com' } });
    expect(otherDomain.status).toBe(409);
    const tenants = (await (await t.call('GET', '/v1/tenants?externalId=store-dup-1')).json()) as any[];
    expect(tenants.map((x) => x.name)).toEqual(['First']);
  });

  it('gives every racer of the same create the one store, never 500', async () => {
    for (let round = 0; round < 5; round++) {
      const externalId = `store-race-${round}`;
      const results = await Promise.all([1, 2, 3].map(() => t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Racer', externalId } })));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      const ids = new Set(await Promise.all(results.map(async (r) => ((await r.json()) as any).id)));
      expect(ids.size).toBe(1);
      expect(((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[]).length).toBe(1);
    }
  });

  it('answers 409, never 500, when different creates race for the same externalId', async () => {
    for (let round = 0; round < 5; round++) {
      const externalId = `store-clash-${round}`;
      const results = await Promise.all([1, 2, 3].map((n) => t.call('POST', '/v1/tenants', { body: { ...OWNER, name: `Racer ${n}`, externalId } })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[]).length).toBe(1);
    }
  });

  it('answers 400, never 500, when two creates race for the same custom domain', async () => {
    for (let round = 0; round < 5; round++) {
      const domain = `race-${round}.example.com`;
      const results = await Promise.all([1, 2].map((n) => t.call('POST', '/v1/tenants', { body: { ...OWNER, name: `Domain Racer ${n}`, customDomainName: domain } })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Status } from '../src/status.ts';
import { setup, waitFor, type TestContext } from './helpers.ts';

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
  it('answers 400 to an externalId already in use, and leaves the existing tenant alone', async () => {
    const first = await t.call('POST', '/v1/tenants', { body: { name: 'First', externalId: 'store-dup-1' } });
    expect(first.status).toBe(200);
    const second = await t.call('POST', '/v1/tenants', { body: { name: 'Second', externalId: 'store-dup-1' } });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ statusCode: 400, message: 'externalId store-dup-1 is already in use' });
    const tenants = (await (await t.call('GET', '/v1/tenants?externalId=store-dup-1')).json()) as any[];
    expect(tenants.map((x) => x.name)).toEqual(['First']);
  });

  it('answers 400, never 500, when two creates race for the same externalId', async () => {
    for (let round = 0; round < 5; round++) {
      const externalId = `store-race-${round}`;
      const results = await Promise.all(
        [1, 2, 3].map((n) => t.call('POST', '/v1/tenants', { body: { name: `Racer ${n}`, externalId } })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
      for (const r of results.filter((r) => r.status === 400)) {
        expect(((await r.json()) as any).message).toBe(`externalId ${externalId} is already in use`);
      }
      expect(((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[]).length).toBe(1);
    }
  });

  it('answers 400, never 500, when two creates race for the same custom domain', async () => {
    for (let round = 0; round < 5; round++) {
      const domain = `race-${round}.example.com`;
      const results = await Promise.all([1, 2].map((n) => t.call('POST', '/v1/tenants', { body: { name: `Domain Racer ${n}`, customDomainName: domain } })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    }
  });
});

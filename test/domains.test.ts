import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Status } from '../src/status.ts';
import { setup, waitFor, type TestContext, OWNER } from './helpers.ts';

let t: TestContext;

async function newTenant(name: string, customDomainName?: string) {
  const body = (await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name, customDomainName } })).json()) as { id: string; externalId: string; baseDomain: string };
  await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${body.externalId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  return body;
}

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});
afterAll(async () => {
  await t.close();
});

describe('tenant domains', () => {
  it('refuses to remove the main or the base domain', async () => {
    const a = await newTenant('Guarded', 'guarded.example.com');
    expect((await t.call('DELETE', `/v1/tenants/domains?externalId=${a.externalId}&domainName=guarded.example.com`)).status).toBe(400);
    expect((await t.call('DELETE', `/v1/tenants/domains?externalId=${a.externalId}&domainName=${a.baseDomain}`)).status).toBe(400);
  });

  it('keeps a domain on one store only, platform version domains included', async () => {
    await newTenant('First', 'taken.example.com');
    const b = await newTenant('Second');
    const add = (domainName: string) => t.call('POST', `/v1/tenants/domains?externalId=${b.externalId}`, { body: { domainName } });
    expect((await add('Taken.Example.com')).status).toBe(400);
    expect((await add('v1.versions.waas.example')).status).toBe(400);
    expect(await (await t.call('GET', '/v1/tenants/domains/available?domain=v1.versions.waas.example')).json()).toEqual({ available: false });
  });

  it('keeps the platform domain and its reserved names for the platform', async () => {
    const available = async (domain: string) =>
      ((await (await t.call('GET', `/v1/tenants/domains/available?domain=${domain}`)).json()) as { available: boolean }).available;
    for (const domain of ['waas.example', 'www.waas.example', 'API.waas.example', 'stores.waas.example']) expect(await available(domain), domain).toBe(false);
    for (const domain of ['my-shop.waas.example', 'www.example.com', 'shop.www.waas.example']) expect(await available(domain), domain).toBe(true);
    // The brand domain is kept whole: stores live on the platform domain, never under the brand.
    for (const domain of ['brand.example', 'shop.brand.example', 'a.b.brand.example']) expect(await available(domain), domain).toBe(false);
    expect(await available('notbrand.example')).toBe(true);

    const create = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Www', customDomainName: 'www.waas.example' } });
    expect(create.status).toBe(400);
    expect(await create.text()).toContain('already in use');
    const b = await newTenant('Named', 'named.waas.example');
    expect((await t.call('POST', `/v1/tenants/domains?externalId=${b.externalId}`, { body: { domainName: 'app.waas.example' } })).status).toBe(400);
  });

  it('treats re-adding its own domain as a no-op, or as set-main', async () => {
    const c = await newTenant('Repeat', 'repeat.example.com');
    const res = await t.call('POST', `/v1/tenants/domains?externalId=${c.externalId}`, { body: { domainName: c.baseDomain, setAsMainDomain: true } });
    expect(res.status).toBe(200);
    await waitFor(async () => {
      const [x] = (await (await t.call('GET', `/v1/tenants?externalId=${c.externalId}`)).json()) as { domainName: string; statusCode: number }[];
      return x!.statusCode === Status.Done && x!.domainName === c.baseDomain;
    });
    const domains = (await (await t.call('GET', `/v1/tenants/domains?externalId=${c.externalId}`)).json()) as unknown[];
    expect(domains).toHaveLength(2);
  });

  it('marks the tenant Failed when the domains cannot be applied', async () => {
    const d = await newTenant('Unlucky');
    t.provisioner.failNext('setDomains', 10);
    await t.call('POST', `/v1/tenants/domains?externalId=${d.externalId}`, { body: { domainName: 'unlucky.example.com' } });
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${d.externalId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Failed, 30000);
    t.provisioner.failNext('setDomains', 0);
  }, 40000);

  it('refuses domain changes on a tenant being removed', async () => {
    const e = await newTenant('Leaving');
    await t.call('DELETE', `/v1/tenants?externalId=${e.externalId}`);
    const res = await t.call('POST', `/v1/tenants/domains?externalId=${e.externalId}`, { body: { domainName: 'leaving.example.com' } });
    expect(res.status).toBe(400);
  });

  it('answers 400 to an invalid domain on the availability check', async () => {
    for (const domain of ['', 'https://x.example.com', 'no spaces.example.com']) {
      expect((await t.call('GET', `/v1/tenants/domains/available?domain=${encodeURIComponent(domain)}`)).status, domain).toBe(400);
    }
  });
});

// Domain Connect links (src/domainconnect.ts): discovery at the DNS host, the template check, the
// signed apply URL, and the storefront and admin routes (validated against their OpenAPI specs).
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { domainConnectLink, type DomainConnectNet } from '../src/domainconnect.ts';
import { createAjv } from '../src/openapi.ts';
import { Status } from '../src/status.ts';
import type { SendingDomain, SendingDomains } from '../src/tosend.ts';
import { setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeSpec: any = parse(readFileSync(new URL('../openapi/store-mail.yaml', import.meta.url), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: storeSpec.components }, 'store');
const validateLink = ajv.compile({ $ref: 'store#/components/schemas/DomainConnectLink' });

/** example.com and its subdomains are at a Domain Connect DNS host that has `templates`. */
function fakeNet(templates: string[]): DomainConnectNet & { fetched: string[]; txt: Record<string, string[][]>; ipv6: string[] } {
  const fetched: string[] = [];
  const txt: Record<string, string[][]> = { '_domainconnect.example.com': [['api.dnshost.example/dc']] };
  const ipv6: string[] = [];
  return {
    fetched,
    txt,
    ipv6,
    async resolveTxt(name) {
      if (txt[name]) return txt[name]!;
      throw new Error('ENOTFOUND');
    },
    async resolve4(name) {
      if (name === 'www.stores.waas.example') return ['203.0.113.7'];
      throw new Error('ENOTFOUND');
    },
    async resolve6(name) {
      if (name === 'www.stores.waas.example' && ipv6.length) return ipv6;
      throw new Error('ENODATA');
    },
    fetch: (async (url: string) => {
      fetched.push(url);
      if (url === 'https://api.dnshost.example/dc/v2/example.com/settings') {
        return Response.json({ providerId: 'dnshost.example', providerName: 'DNS Host', providerDisplayName: 'Example DNS', urlSyncUX: 'https://connect.dnshost.example', urlAPI: 'https://api.dnshost.example/dc' });
      }
      const m = url.match(/^https:\/\/api\.dnshost\.example\/dc\/v2\/domainTemplates\/providers\/waas\.example\/services\/(\w+)$/);
      if (m && templates.includes(m[1]!)) return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  };
}

const config = { providerId: 'waas.example', keyHost: '_dck1' };

describe('domainConnectLink', () => {
  it('links to the DNS host with the subdomain as host when it has the template', async () => {
    const link = await domainConnectLink(config, 'shop.example.com', 'website', { ip: '203.0.113.7' }, fakeNet(['website']));
    expect(validateLink(link)).toBe(true);
    expect(link).toEqual({
      dnsProvider: 'Example DNS',
      supported: true,
      url: 'https://connect.dnshost.example/v2/domainTemplates/providers/waas.example/services/website/apply?domain=example.com&host=shop&ip=203.0.113.7',
    });
  });

  it("names the DNS host but gives no link when it doesn't have the template yet", async () => {
    expect(await domainConnectLink(config, 'example.com', 'email', { dkim: 'p=x' }, fakeNet(['website']))).toEqual({ dnsProvider: 'Example DNS', supported: false, url: null });
  });

  it('gives nothing for a DNS host without Domain Connect', async () => {
    const net = fakeNet(['website']);
    expect(await domainConnectLink(config, 'shop.other.example', 'website', { ip: '203.0.113.7' }, net)).toEqual({ dnsProvider: null, supported: false, url: null });
    expect(net.fetched).toEqual([]);
  });

  it('signs the query string with the private key, as the spec describes', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const link = await domainConnectLink({ ...config, privateKey: pem }, 'example.com', 'email', { dkim: 'p=a+b/c' }, fakeNet(['email']));
    const query = link.url!.split('?')[1]!;
    const signed = query.split('&sig=')[0]!;
    expect(signed).toBe('domain=example.com&dkim=p%3Da%2Bb%2Fc');
    const params = new URLSearchParams(query);
    expect(params.get('key')).toBe('_dck1');
    expect(createVerify('RSA-SHA256').update(signed).verify(publicKey, params.get('sig')!, 'base64')).toBe(true);
  });
});

class FakeDomains implements SendingDomains {
  domain: SendingDomain = { id: 'dom1', name: 'mail.example.com', status: 'draft', records: [
    { type: 'TXT', name: 'tosend._domainkey', host: 'tosend._domainkey.mail.example.com', value: 'p=KEY', priority: null },
    { type: 'MX', name: 'send', host: 'send.mail.example.com', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  ] };
  async addDomain() { return this.domain; }
  async getDomain() { return this.domain; }
  async deleteDomain() {}
}

describe('store Domain Connect routes', () => {
  let t: TestContext;
  let tenant: { id: string; externalId: string };
  let net: ReturnType<typeof fakeNet>;

  beforeAll(async () => {
    t = await setup();
    t.deps.config.domainConnect = config;
    t.deps.config.sendingDomains = new FakeDomains();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    t.deps.config.coolify = { mail: { from: 'no-reply@waas.example' } } as any;
    net = fakeNet(['website', 'email']);
    t.deps.domainConnectNet = net;
    const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
    const versionId = ((await res.json()) as { id: string }).id;
    await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    await t.call('PUT', '/v1/versions/production', { body: { versionId } });
    tenant = (await (await t.call('POST', '/v1/tenants', { body: { name: 'DC Shop' } })).json()) as { id: string; externalId: string };
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    await t.pool.query('INSERT INTO tenant_domains (tenant_id, domain_name, is_main) VALUES ($1, $2, false)', [tenant.id, 'shop.example.com']);
  });
  afterAll(async () => {
    await t.close();
  });

  const storefront = (query: string) => t.call('GET', `/v1/tenants/domain-connect?externalId=${tenant.externalId}&${query}`);

  it("links a store's own domain to the stores' address", async () => {
    const res = await storefront('domainName=shop.example.com&service=website');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toContain('/services/website/apply?domain=example.com&host=shop&ip=203.0.113.7');
  });

  it("refuses a domain that isn't the store's, and a bad service", async () => {
    expect((await storefront('domainName=other.example.com&service=website')).status).toBe(400);
    expect((await storefront('domainName=shop.example.com&service=dns')).status).toBe(400);
    expect((await storefront('domainName=mail.example.com&service=email')).status).toBe(400);
  });

  it("links the store's sending domain with its DKIM key, from the admin API too", async () => {
    await t.call('PUT', `/v1/tenants/mail-domain?externalId=${tenant.externalId}`, { body: { domainName: 'mail.example.com' } });
    const res = await storefront('domainName=mail.example.com&service=email');
    expect(((await res.json()) as { url: string }).url).toContain('/services/email/apply?domain=example.com&host=mail&dkim=p%3DKEY');

    const admin = await t.call('GET', `/admin/tenants/${tenant.id}/domain-connect?domainName=mail.example.com&service=email`, { auth: `Bearer ${TEST_ADMIN_TOKEN}` });
    expect(admin.status).toBe(200);
    expect(adminSpec.paths['/admin/tenants/{id}/domain-connect'].get.responses['200']).toBeDefined();
    expect(((await admin.json()) as { supported: boolean }).supported).toBe(true);
  });

  it("adds the server's IPv6 address, from the wildcard's AAAA or else DOMAIN_CONNECT_IPV6", async () => {
    t.deps.config.domainConnect = { ...config, ipv6: '2001:db8::7' };
    let url = ((await (await storefront('domainName=shop.example.com&service=website')).json()) as { url: string }).url;
    expect(url).toContain('&ip=203.0.113.7&ipv6=2001%3Adb8%3A%3A7');
    net.ipv6.push('2001:db8::8');
    url = ((await (await storefront('domainName=shop.example.com&service=website')).json()) as { url: string }).url;
    expect(url).toContain('&ipv6=2001%3Adb8%3A%3A8');
    net.ipv6.length = 0;
    t.deps.config.domainConnect = config;
  });

  it('gives no link when the domain already has a different DKIM key, since some hosts would keep both', async () => {
    net.txt['tosend._domainkey.mail.example.com'] = [['p=OLD']];
    const res = await storefront('domainName=mail.example.com&service=email');
    const link = (await res.json()) as { supported: boolean; url: string | null; conflict?: string };
    expect(validateLink(link)).toBe(true);
    expect(link).toMatchObject({ dnsProvider: 'Example DNS', supported: false, url: null });
    expect(link.conflict).toContain('tosend._domainkey.mail.example.com already has a different DKIM key');

    net.txt['tosend._domainkey.mail.example.com'] = [['p=', 'KEY']];
    expect(((await (await storefront('domainName=mail.example.com&service=email')).json()) as { supported: boolean }).supported).toBe(true);
    delete net.txt['tosend._domainkey.mail.example.com'];
  });
});

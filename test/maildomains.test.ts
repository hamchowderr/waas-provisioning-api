// A store's own sending domain: the admin endpoints (validated against openapi/admin/admin-api.yaml)
// and the check that moves the store to its domain once toSend has verified it, and back.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkMailDomains } from '../src/maildomains.ts';
import { createAjv } from '../src/openapi.ts';
import type { StoreSender } from '../src/provisioner/provisioner.ts';
import { Status } from '../src/status.ts';
import type { SendingDomain, SendingDomains } from '../src/tosend.ts';
import { setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');

class FakeDomains implements SendingDomains {
  domains = new Map<string, SendingDomain>();
  private seq = 0;
  async addDomain(name: string) {
    const existing = [...this.domains.values()].find((d) => d.name === name);
    if (existing) return existing;
    const id = `dom${++this.seq}`;
    const domain = { id, name, status: 'draft', records: [{ type: 'TXT', name: 'tosend._domainkey', host: `tosend._domainkey.${name}`, value: 'p=x', priority: null }] };
    this.domains.set(id, domain);
    return domain;
  }
  async getDomain(id: string) {
    const d = this.domains.get(id);
    if (!d) throw new Error('not found');
    return d;
  }
  async deleteDomain(id: string) {
    this.domains.delete(id);
  }
}

let t: TestContext;
let tenantId: string;
const domains = new FakeDomains();
const senders: { storeId: string; sender?: StoreSender }[] = [];
const quiet = { log: () => undefined, error: (m: string) => console.error(m) };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function admin(method: string, path: string, expected = 200, body?: unknown): Promise<any> {
  const res = await t.call(method, path, { auth: `Bearer ${TEST_ADMIN_TOKEN}`, body });
  const parsed = await res.json();
  expect(res.status, `${method} ${path}: ${JSON.stringify(parsed)}`).toBe(expected);
  const responses = adminSpec.paths['/admin/tenants/{id}/mail-domain'][method.toLowerCase()].responses[String(expected)];
  const media = responses.$ref ? adminSpec.components.responses[responses.$ref.split('/').pop()].content : responses.content;
  const validate = ajv.compile(JSON.parse(JSON.stringify(media['application/json'].schema).replaceAll('"#/components', '"admin#/components')));
  expect(validate(parsed), `${method} ${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  return parsed;
}

const path = () => `/admin/tenants/${tenantId}/mail-domain`;

beforeAll(async () => {
  t = await setup();
  t.deps.config.sendingDomains = domains;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t.deps.config.coolify = { mail: { from: 'no-reply@waas.example' } } as any;
  t.provisioner.ensureStoreMail = async (input) => {
    senders.push(input);
    return 'updated';
  };
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  const tenant = (await (await t.call('POST', '/v1/tenants', { body: { name: 'Mail Shop' } })).json()) as { id: string; externalId: string };
  tenantId = tenant.id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`)).json()) as any[])[0]?.statusCode === Status.Done);
});
afterAll(async () => {
  await t.close();
});

describe('store sending domains', () => {
  it('starts with none, and refuses the platform domain or a bad name', async () => {
    expect(await admin('GET', path())).toEqual({ mailDomain: null });
    await admin('PUT', path(), 400, { domainName: 'shop.waas.example' });
    await admin('PUT', path(), 400, { domainName: 'https://nope' });
    await admin('DELETE', path(), 404);
  });

  it('adds the domain on toSend and returns the records, keeping the platform address until verified', async () => {
    const { mailDomain } = await admin('PUT', path(), 200, { domainName: 'Shop.Example' });
    expect(mailDomain).toMatchObject({ domainName: 'shop.example', status: 'pending', dateVerified: null });
    expect(mailDomain.records[0]).toMatchObject({ type: 'TXT', host: 'tosend._domainkey.shop.example' });
    // The same domain again is fine; a different one is not.
    expect((await admin('PUT', path(), 200, { domainName: 'shop.example' })).mailDomain.domainName).toBe('shop.example');
    await admin('PUT', path(), 400, { domainName: 'other.example' });

    await checkMailDomains(t.pool, domains, t.provisioner, quiet);
    expect(senders).toEqual([]);
  });

  it('moves the store to its domain once toSend has verified it', async () => {
    const domain = [...domains.domains.values()][0]!;
    domain.status = 'verified';
    await checkMailDomains(t.pool, domains, t.provisioner, quiet);
    expect(senders).toEqual([{ storeId: tenantId, sender: { domain: 'shop.example', domainId: domain.id } }]);
    expect((await admin('GET', path())).mailDomain).toMatchObject({ status: 'verified' });
  });

  it('moves the store back and drops the domain from toSend when it is removed', async () => {
    senders.length = 0;
    expect(await admin('DELETE', path())).toEqual({ domainName: 'shop.example' });
    expect((await admin('GET', path())).mailDomain.status).toBe('removing');
    await admin('PUT', path(), 400, { domainName: 'shop.example' });
    await checkMailDomains(t.pool, domains, t.provisioner, quiet);
    expect(senders).toEqual([{ storeId: tenantId }]);
    expect(domains.domains.size).toBe(0);
    expect(await admin('GET', path())).toEqual({ mailDomain: null });
  });

  it("drops a deleted store's domain from toSend", async () => {
    await admin('PUT', path(), 200, { domainName: 'gone.example' });
    await t.pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await checkMailDomains(t.pool, domains, t.provisioner, quiet);
    expect(domains.domains.size).toBe(0);
    expect((await t.pool.query('SELECT 1 FROM tenant_mail_domains')).rowCount).toBe(0);
  });
});

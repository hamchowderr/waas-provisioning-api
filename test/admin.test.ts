// The admin API (outside the WPCS contract): auth, each endpoint, and the failure-record + retry
// flow. Responses are validated against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApp } from '../src/app.ts';
import { createApiKey } from '../src/keys.ts';
import { createAjv } from '../src/openapi.ts';
import { QUEUE } from '../src/queue.ts';
import { Status } from '../src/status.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;

async function admin(method: string, path: string, expected = 200): Promise<any> {
  const res = await t.call(method, path, { auth: ADMIN });
  expect(res.status, `${method} ${path}`).toBe(expected);
  const body = await res.json();
  const opPath = Object.keys(adminSpec.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path.split('?')[0]!))!;
  const responses = adminSpec.paths[opPath][method.toLowerCase()].responses[String(expected)];
  const media = responses.$ref ? adminSpec.components.responses[responses.$ref.split('/').pop()].content : responses.content;
  const schema = JSON.parse(JSON.stringify(media['application/json'].schema).replaceAll('"#/components', '"admin#/components'));
  const validate = ajv.compile(schema);
  expect(validate(body), `${method} ${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  return body;
}

const tenantStatus = async (externalId: string) => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[])[0]?.statusCode;

async function newTenant(body: object, auth?: string) {
  const tenant = (await (await t.call('POST', '/v1/tenants', { body, auth })).json()) as { id: string; externalId: string };
  await waitFor(async () => {
    const res = await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`, { auth });
    return ((await res.json()) as any[])[0]?.statusCode === Status.Done;
  });
  return tenant;
}

let otherAuth: string;
let otherProductId: string;

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  // A second storefront with its own version.
  otherProductId = (await t.pool.query("INSERT INTO products (name) VALUES ('Other storefront') RETURNING id")).rows[0].id;
  const { key, secret } = await createApiKey(t.pool, otherProductId);
  otherAuth = basic(key, secret);
  const v2 = ((await (await t.call('POST', '/v1/versions', { auth: otherAuth, body: { name: 'other-v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } })).json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${v2}`, { auth: otherAuth })).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { auth: otherAuth, body: { versionId: v2 } });
});
afterAll(async () => {
  await t.close();
});

describe('admin auth', () => {
  it('answers 403 to anything but the admin token, product keys included', async () => {
    const productKey = t.auth.replace(/^Basic /, '');
    for (const auth of [null, t.auth, `Bearer ${productKey}`, 'Bearer wrong-token', `Bearer ${TEST_ADMIN_TOKEN}x`, `Basic ${TEST_ADMIN_TOKEN}`]) {
      const res = await t.call('GET', '/admin/overview', { auth });
      expect(res.status, String(auth)).toBe(403);
    }
    await admin('GET', '/admin/overview');
  });

  it('is disabled when ADMIN_TOKEN is unset', async () => {
    const app = createApp({ ...t.deps, config: { ...t.deps.config, adminToken: undefined } });
    const res = await app.request('/admin/overview', { headers: { Authorization: ADMIN } });
    expect(res.status).toBe(403);
  });

  it('does not let the admin token into /v1', async () => {
    expect((await t.call('GET', '/v1/versions', { auth: ADMIN })).status).toBe(403);
  });
});

describe('admin endpoints', () => {
  let shop: { id: string; externalId: string };

  it('overview: counts, health and products', async () => {
    shop = await newTenant({ name: 'Admin Shop', customDomainName: 'admin-shop.example.com', wpOptions: { blogname: 'secret-ish value' } });
    await newTenant({ name: 'Other Shop' }, otherAuth);
    const overview = await admin('GET', '/admin/overview');
    expect(overview.health).toEqual({ ok: true, database: 'ok', queue: 'ok' });
    expect(overview.tenants.done).toBe(2);
    expect(overview.products.map((p: any) => p.name).sort()).toEqual(['Example storefront', 'Other storefront']);
  });

  it('tenants: across products, with filters, search and paging', async () => {
    const all = await admin('GET', '/admin/tenants');
    expect(all.total).toBe(2);
    const other = await admin('GET', `/admin/tenants?productId=${otherProductId}`);
    expect(other.items.map((x: any) => x.name)).toEqual(['Other Shop']);
    const byDomain = await admin('GET', '/admin/tenants?q=ADMIN-SHOP.example');
    expect(byDomain.items).toEqual([expect.objectContaining({ id: shop.id, mainDomain: 'admin-shop.example.com', domainCount: 2, productName: 'Example storefront' })]);
    expect((await admin('GET', '/admin/tenants?q=%25')).total).toBe(0); // % is literal, not a wildcard
    expect((await admin('GET', `/admin/tenants?status=${Status.Failed}`)).total).toBe(0);
    expect((await admin('GET', '/admin/tenants?suspended=false&pageSize=1&page=2')).items).toHaveLength(1);
    await admin('GET', '/admin/tenants?status=7', 400);
  });

  it('tenant detail: domains, backups, recent jobs; option names but no values', async () => {
    await t.call('POST', `/v1/tenants/backups?externalId=${shop.externalId}`);
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants/backups?externalId=${shop.externalId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    const detail = await admin('GET', `/admin/tenants/${shop.id}`);
    expect(detail.domains).toHaveLength(2);
    expect(detail.backups).toHaveLength(1);
    expect(detail.recentJobs.map((j: any) => j.type)).toEqual(expect.arrayContaining(['tenant.create', 'tenant.backup']));
    expect(detail.wpOptionNames).toEqual(['blogname']);
    expect(JSON.stringify(detail)).not.toContain('secret-ish value');
    await admin('GET', `/admin/tenants/${crypto.randomUUID()}`, 404);
  });

  it('backups: includes a deleted tenant\'s, with expiresAt', async () => {
    const gone = await newTenant({ name: 'Gone Shop' });
    await t.call('POST', `/v1/tenants/suspend?externalId=${gone.externalId}`, { body: {} });
    await t.call('DELETE', `/v1/tenants?externalId=${gone.externalId}`);
    await waitFor(async () => (await tenantStatus(gone.externalId)) === undefined);
    const deleted = await admin('GET', '/admin/backups?tenantDeleted=true');
    expect(deleted.items).toEqual([expect.objectContaining({ tenantId: gone.id, reason: 'suspend', expiresAt: expect.any(String) })]);
    const days = (Date.parse(deleted.items[0].expiresAt) - Date.parse(deleted.items[0].tenantDeletedAt)) / 86400000;
    expect(days).toBeCloseTo(90, 5);
    expect((await admin('GET', '/admin/backups')).total).toBe(2);
  });

  it('jobs: queued and running lists with counts', async () => {
    // A job deferred an hour stays queued while we look.
    const id = await t.boss.send(QUEUE, { type: 'tenant.resume', tenantId: shop.id }, { singletonKey: `tenant:${crypto.randomUUID()}`, startAfter: 3600 });
    const queued = await admin('GET', '/admin/jobs?state=queued');
    expect(queued.items).toEqual(expect.arrayContaining([expect.objectContaining({ id, type: 'tenant.resume', tenantId: shop.id, state: 'created' })]));
    expect(queued.counts.queued).toBeGreaterThanOrEqual(1);
    await t.boss.deleteJob(QUEUE, id!);
    await admin('GET', '/admin/jobs?state=running');
    await admin('GET', '/admin/jobs?state=everything', 400);
  });
});

describe('job failures and retry', () => {
  it('records a job that fails its last retry, and retries it once', async () => {
    t.provisioner.failNext('createStore', 10);
    const doomed = (await (await t.call('POST', '/v1/tenants', {
      body: { name: 'Retry Me', wordPressUserName: 'owner', wordPressUserEmail: 'owner@example.com', wordPressUserPassword: 'example-password' },
    })).json()) as { id: string; externalId: string };
    await waitFor(async () => (await tenantStatus(doomed.externalId)) === Status.Failed, 30000);
    t.provisioner.failNext('createStore', 0);

    const failed = await admin('GET', '/admin/jobs?state=failed');
    const failure = failed.items.find((f: any) => f.tenantId === doomed.id);
    expect(failure).toMatchObject({ type: 'tenant.create', status: 'failed', attempts: 4, errorMessage: expect.stringContaining('createStore failed') });
    expect(failed.counts.failed).toBeGreaterThanOrEqual(1);
    // Job data (which holds the encrypted password) is never returned.
    expect(JSON.stringify(failed)).not.toContain('encryptedPassword');

    const retried = await admin('POST', `/admin/jobs/failures/${failure.id}/retry`);
    expect(retried).toMatchObject({ id: failure.id, status: 'retried', retryJobId: expect.any(String) });
    expect([Status.Pending, Status.Done]).toContain(await tenantStatus(doomed.externalId));
    await waitFor(async () => (await tenantStatus(doomed.externalId)) === Status.Done);
    expect(t.provisioner.stores.get(doomed.id)!.user?.password).toBe('example-password');

    // Idempotent.
    expect(await admin('POST', `/admin/jobs/failures/${failure.id}/retry`)).toEqual(retried);
    expect((await admin('GET', '/admin/jobs?state=failed')).items.some((f: any) => f.id === failure.id)).toBe(false);
    await admin('POST', `/admin/jobs/failures/${crypto.randomUUID()}/retry`, 404);
  }, 60000);

  it('refuses a retry when the record is no longer Failed', async () => {
    const tenant = await newTenant({ name: 'Moved On' });
    t.provisioner.failNext('updateStore', 10);
    await t.call('PUT', `/v1/tenants?externalId=${tenant.externalId}`, { body: { wpOptions: { a: 'b' } } });
    await waitFor(async () => (await tenantStatus(tenant.externalId)) === Status.Failed, 30000);
    t.provisioner.failNext('updateStore', 0);
    const failure = (await admin('GET', '/admin/jobs?state=failed')).items.find((f: any) => f.tenantId === tenant.id);
    // Something else fixed the tenant meanwhile.
    await t.pool.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenant.id, Status.Done]);
    const res = await admin('POST', `/admin/jobs/failures/${failure.id}/retry`, 400);
    expect(res.message).toMatch(/no longer Failed/);
  }, 60000);
});

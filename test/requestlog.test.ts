// The request log (src/requestlog.ts): what each call records, what it never records, and
// GET /admin/requests, validated against openapi/admin/admin-api.yaml.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApiKey } from '../src/keys.ts';
import { createAjv } from '../src/openapi.ts';
import { pruneRequestLog } from '../src/requestlog.ts';
import { basic, setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');
const validateList = ajv.compile(
  JSON.parse(
    JSON.stringify(adminSpec.paths['/admin/requests'].get.responses['200'].content['application/json'].schema).replaceAll(
      '"#/components',
      '"admin#/components',
    ),
  ),
);

const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
let t: TestContext;
let key: string;
let secret: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function requests(query = ''): Promise<any> {
  const res = await t.call('GET', `/admin/requests${query}`, { auth: ADMIN });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(validateList(body), ajv.errorsText(validateList.errors)).toBe(true);
  return body;
}

beforeAll(async () => {
  t = await setup();
  ({ key, secret } = await createApiKey(t.pool, t.productId));
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.pool.query('DELETE FROM api_requests');
});

describe('request log', () => {
  it('records a product API call with its key, store and caller, and nothing secret', async () => {
    const tenantId = randomUUID();
    const res = await t.call('GET', `/v1/tenants?tenantId=${tenantId}`, {
      auth: basic(key, secret),
      headers: { 'User-Agent': 'WaaS Client/2.3.0', 'X-Forwarded-For': '203.0.113.9, 10.0.0.2' },
    });
    expect(res.status).toBe(200);

    const { items, total, last24Hours } = await requests();
    expect(total).toBe(1);
    expect(last24Hours).toEqual({ total: 1, clientErrors: 0, serverErrors: 0 });
    expect(items[0]).toMatchObject({
      source: 'v1',
      method: 'GET',
      path: '/v1/tenants',
      query: `tenantId=${tenantId}`,
      status: 200,
      productId: t.productId,
      productName: 'Example storefront',
      apiKeyId: key,
      tenantId,
      tenantName: null,
      ip: '203.0.113.9',
      userAgent: 'WaaS Client/2.3.0',
      error: null,
    });
    const row = JSON.stringify((await t.pool.query('SELECT * FROM api_requests')).rows);
    expect(row).not.toContain(secret);
  });

  it('records a failed sign-in with the key id and the error, but not the secret', async () => {
    const res = await t.call('POST', '/v1/tenants', { auth: basic(key, 'wrong-secret'), body: { name: 'x' } });
    expect(res.status).toBe(403);
    const { items } = await requests('?outcome=error');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ method: 'POST', status: 403, apiKeyId: key, productId: null, error: 'Invalid API key or secret' });
    expect(JSON.stringify((await t.pool.query('SELECT * FROM api_requests')).rows)).not.toContain('wrong-secret');
  });

  it('keeps no key id when the username is not a key id', async () => {
    await t.call('GET', '/v1/tenants', { auth: basic('pasted-secret-by-mistake', 'x') });
    const { items } = await requests();
    expect(items[0]).toMatchObject({ status: 403, apiKeyId: null });
    expect(JSON.stringify((await t.pool.query('SELECT * FROM api_requests')).rows)).not.toContain('pasted-secret-by-mistake');
  });

  it('records admin changes but not admin reads, and never the admin token', async () => {
    await requests();
    await t.call('GET', '/admin/overview', { auth: ADMIN });
    const res = await t.call('PUT', `/admin/products/${t.productId}`, { auth: ADMIN, body: { maxTenants: 10 } });
    expect(res.status).toBe(200);
    const { items } = await requests();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'admin', method: 'PUT', path: `/admin/products/${t.productId}`, status: 200 });
    expect(JSON.stringify((await t.pool.query('SELECT * FROM api_requests')).rows)).not.toContain(TEST_ADMIN_TOKEN);
  });

  it('filters by store, source, outcome, method and path', async () => {
    const tenantId = randomUUID();
    await t.call('GET', `/v1/tenants?tenantId=${tenantId}`);
    await t.call('GET', '/v1/versions');
    await t.call('GET', '/v1/tenants', { auth: null });
    await t.call('PUT', `/admin/products/${t.productId}`, { auth: ADMIN, body: { maxTenants: 'lots' } });

    expect((await requests()).total).toBe(4);
    expect((await requests(`?tenantId=${tenantId}`)).items.map((r: any) => r.tenantId)).toEqual([tenantId]);
    expect((await requests('?source=admin')).items.map((r: any) => r.status)).toEqual([400]);
    expect((await requests('?outcome=client-error')).total).toBe(2);
    expect((await requests('?outcome=ok')).total).toBe(2);
    expect((await requests('?outcome=server-error')).total).toBe(0);
    expect((await requests('?method=put')).total).toBe(1);
    expect((await requests('?path=versions')).items.map((r: any) => r.path)).toEqual(['/v1/versions']);
    expect((await requests(`?productId=${t.productId}`)).total).toBe(2);
    const res = await t.call('GET', '/admin/requests?outcome=bad', { auth: ADMIN });
    expect(res.status).toBe(400);
  });

  it('pages newest first', async () => {
    for (let i = 0; i < 3; i++) await t.call('GET', `/v1/versions?versionName=v${i}`);
    const first = await requests('?pageSize=2');
    expect(first.total).toBe(3);
    expect(first.items.map((r: any) => r.query)).toEqual(['versionName=v2', 'versionName=v1']);
    const second = await requests('?pageSize=2&page=2');
    expect(second.items.map((r: any) => r.query)).toEqual(['versionName=v0']);
  });

  it('prunes rows older than the retention', async () => {
    await t.call('GET', '/v1/versions');
    await t.pool.query(
      "INSERT INTO api_requests (at, source, method, path, status, duration_ms) VALUES (now() - interval '31 days', 'v1', 'GET', '/v1/versions', 200, 1)",
    );
    expect(await pruneRequestLog(t.pool, 30)).toBe(1);
    expect(await pruneRequestLog(t.pool, 0)).toBe(0);
    expect((await requests()).total).toBe(1);
  });
});

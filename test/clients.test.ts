// Clients set up in one step (src/clients.ts): their own storefront started from another's template,
// their site once it has built, and an emailed invitation. Answers are checked against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { testUtils } from 'better-auth/plugins';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { createAjv } from '../src/openapi.ts';
import { Status } from '../src/status.ts';
import { setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

const AUTH: AuthConfig = {
  url: 'https://app.waas.example',
  secret: 'test-auth-secret-not-a-secret-0123456789',
  mail: { key: 'test-key', from: 'no-reply@anypress.example', brand: 'AnyPress' },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');

let t: TestContext;
let app: ReturnType<typeof createApp>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let helpers: any;
const sent: { to: string; subject: string; text: string }[] = [];

/** Calls the admin API; a 2xx JSON answer must match the admin spec. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(`/admin${path}`, {
    method,
    headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (res.ok) {
    const opPath = Object.keys(adminSpec.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(`/admin${path}`))!;
    const schema = adminSpec.paths[opPath][method.toLowerCase()].responses[String(res.status)].content['application/json'].schema;
    const validate = ajv.compile(JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"admin#/components/')));
    expect(validate(json), `${method} ${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  t = await setup();
  t.deps.config.auth = AUTH;
  const auth = createAuth(t.pool, AUTH, [testUtils()]);
  t.deps.auth = auth;
  helpers = ((await auth.$context) as unknown as { test: unknown }).test;
  app = createApp(t.deps);

  // The storefront clients start from: a production version with a template, and a store.
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  expect((await t.call('POST', '/v1/tenants', { body: { name: 'Shop store' } })).status).toBe(200);

  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.tosend.com/')) return realFetch(input, init);
    const body = JSON.parse(String(init!.body));
    sent.push({ to: body.to[0].email, subject: body.subject, text: body.text });
    return new Response('{"id":"e1"}', { status: 200 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

describe('adding a client', () => {
  it('refuses a missing name, a bad email or size, and a storefront with nothing to start from', async () => {
    expect((await admin('POST', '/clients', { email: 'a@b.example' })).status).toBe(400);
    expect((await admin('POST', '/clients', { name: 'X', email: 'nope' })).status).toBe(400);
    expect((await admin('POST', '/clients', { name: 'X', email: 'a@b.example', size: 'huge' })).status).toBe(400);
    const bare = (await (await t.call('POST', '/admin/products', { auth: `Bearer ${TEST_ADMIN_TOKEN}`, body: { name: 'Bare' } })).json()) as { product: { id: string } };
    expect((await admin('POST', '/clients', { name: 'X', email: 'a@b.example', startFrom: bare.product.id })).status).toBe(400);
    expect((await t.pool.query("SELECT 1 FROM products WHERE name = 'X'")).rowCount).toBe(0);
  });

  it('makes their storefront, then their site, then emails them an invitation; accepting makes them active', async () => {
    const added = await admin('POST', '/clients', { name: 'Example Bakery', email: 'Owner@Bakery.example', size: 'medium' });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ name: 'Example Bakery', email: 'owner@bakery.example', size: 'medium', status: 'setting_up', tenantId: null });
    const { productId } = added.json as { productId: string };
    // Started from the storefront with the most stores, with room for one site.
    expect((await t.pool.query('SELECT max_tenants FROM products WHERE id = $1', [productId])).rows[0].max_tenants).toBe(1);

    // Once its copy of the version has built, the site is made and the client invited.
    const client = await waitFor(async () => {
      const { json } = await admin('GET', '/clients');
      const c = json.find((x: { productId: string }) => x.productId === productId);
      return c?.status === 'invited' && c;
    });
    expect(client).toMatchObject({ siteDomain: expect.stringContaining('.stores.waas.example'), invitationEmailed: true, problem: null });
    const { rows: sites } = await t.pool.query('SELECT name, size, status FROM tenants WHERE product_id = $1', [productId]);
    expect(sites).toEqual([{ name: 'Example Bakery', size: 'medium', status: Status.Done }]);
    expect(sent).toEqual([{ to: 'owner@bakery.example', subject: 'Join Example Bakery on AnyPress', text: expect.stringContaining(`${AUTH.url}/invite/`) }]);

    // Listing again makes nothing more and sends nothing more.
    await admin('GET', '/clients');
    expect(sent).toHaveLength(1);
    expect((await t.pool.query('SELECT 1 FROM tenants WHERE product_id = $1', [productId])).rowCount).toBe(1);

    const user = await helpers.saveUser(helpers.createUser({ email: 'owner@bakery.example', name: 'Owner', emailVerified: true }));
    const { headers } = await helpers.login({ userId: user.id });
    const invitationId = /\/invite\/([^\s]+)/.exec(sent[0]!.text)![1];
    const accepted = await app.request('/api/auth/organization/accept-invitation', {
      method: 'POST',
      headers: { Cookie: (headers as Headers).get('cookie')!, 'Content-Type': 'application/json', Origin: AUTH.url },
      body: JSON.stringify({ invitationId }),
    });
    expect(accepted.status).toBe(200);
    const { json } = await admin('GET', '/clients');
    expect(json.find((x: { productId: string }) => x.productId === productId).status).toBe('active');
  });

  it('is for the platform admin only', async () => {
    const res = await app.request('/admin/clients', { headers: { Authorization: t.auth } });
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});

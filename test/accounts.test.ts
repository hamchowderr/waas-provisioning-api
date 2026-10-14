import { readFileSync } from 'node:fs';
import { testUtils } from 'better-auth/plugins';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { createApiKey } from '../src/keys.ts';
import { createAjv } from '../src/openapi.ts';
import { Status } from '../src/status.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

const AUTH: AuthConfig = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789' };

let t: TestContext;
let app: ReturnType<typeof createApp>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let helpers: any;
let otherProductId: string;
let otherAuth: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');

/** Calls the admin API; a 2xx JSON answer must match openapi/admin/admin-api.yaml. */
async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await app.request(`/admin${path}`, {
    method,
    headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) {
    const opPath = Object.keys(adminSpec.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(`/admin${path}`))!;
    const schema = adminSpec.paths[opPath][method.toLowerCase()].responses[String(res.status)].content['application/json'].schema;
    const validate = ajv.compile(JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"admin#/components/')));
    const json = await res.clone().json();
    expect(validate(json), `${method} ${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
  return res;
}

/** A request as the dashboard's server makes it: the session cookie plus X-Session-Auth. */
const asUser = (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { Cookie: cookie, 'X-Session-Auth': '1', 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A saved user with a verified email, and their session cookie. */
async function signedIn(email: string): Promise<{ userId: string; cookie: string }> {
  const user = await helpers.saveUser(helpers.createUser({ email, name: email.split('@')[0], emailVerified: true }));
  const { headers } = await helpers.login({ userId: user.id });
  return { userId: user.id, cookie: (headers as Headers).get('cookie')! };
}

/** Accepts an invitation through Better Auth's own route, the way the dashboard's invite page does. */
const accept = (cookie: string, invitationId: string) =>
  app.request('/api/auth/organization/accept-invitation', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: AUTH.url },
    body: JSON.stringify({ invitationId }),
  });

/** A production version, then a finished store, for the product whose API key is `auth`. */
async function storeFor(auth: string, name: string): Promise<{ id: string; externalId: string }> {
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true }, auth });
  const versionId = ((await res.json()) as { id: string }).id;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`, { auth })).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId }, auth });
  const created = await t.call('POST', '/v1/tenants', { body: { name }, auth });
  expect(created.status).toBe(200);
  const tenant = (await created.json()) as { id: string; externalId: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`, { auth })).json()) as any[])[0]?.statusCode === Status.Done);
  return tenant;
}

async function invite(productId: string, email: string, role?: string) {
  const res = await admin('POST', `/products/${productId}/invitations`, { email, role });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; acceptUrl: string; role: string };
}

beforeAll(async () => {
  t = await setup();
  const auth = createAuth(t.pool, AUTH, [testUtils()]);
  // testUtils adds `test` to the context; the type of a plugin passed this way doesn't carry it.
  helpers = ((await auth.$context) as unknown as { test: unknown }).test;
  t.deps.config.auth = AUTH;
  t.deps.auth = auth;
  app = createApp(t.deps);
  otherProductId = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Other storefront') RETURNING id")).rows[0]!.id;
  const key = await createApiKey(t.pool, otherProductId);
  otherAuth = basic(key.key, key.secret);
});

afterAll(() => t.close());

describe('organizations and invitations (admin)', () => {
  it('makes one organization per product and lists it with its people', async () => {
    const created = await admin('PUT', `/products/${t.productId}/organization`, {});
    expect(created.status).toBe(201);
    const again = await admin('PUT', `/products/${t.productId}/organization`, { name: 'Example Agency' });
    expect(again.status).toBe(200);
    const view = await (await admin('GET', `/products/${t.productId}/organization`)).json();
    expect(view.organization).toMatchObject({ name: 'Example Agency', productId: t.productId });
    expect(view.members).toEqual([]);
  });

  it('invites by email with an accept link, and a new invitation replaces a pending one', async () => {
    const first = await invite(t.productId, 'Replace@Example.com');
    expect(first.acceptUrl).toBe(`${AUTH.url}/invite/${first.id}`);
    expect(first.role).toBe('owner');
    const second = await invite(t.productId, 'replace@example.com', 'member');
    const view = await (await admin('GET', `/products/${t.productId}/organization`)).json();
    expect(view.invitations.filter((i: { email: string }) => i.email === 'replace@example.com').map((i: { id: string }) => i.id)).toEqual([second.id]);
    expect((await admin('DELETE', `/products/${t.productId}/invitations/${second.id}`)).status).toBe(200);
    expect((await admin('DELETE', `/products/${t.productId}/invitations/${second.id}`)).status).toBe(404);
  });

  it('refuses a bad email or role, and an unknown product', async () => {
    expect((await admin('POST', `/products/${t.productId}/invitations`, { email: 'nope' })).status).toBe(400);
    expect((await admin('POST', `/products/${t.productId}/invitations`, { email: 'a@example.com', role: 'god' })).status).toBe(400);
    expect((await admin('POST', '/products/00000000-0000-4000-8000-000000000000/invitations', { email: 'a@example.com' })).status).toBe(404);
  });

  it('needs the admin token', async () => {
    const res = await app.request(`/admin/products/${t.productId}/organization`);
    expect(res.status).toBe(403);
  });
});

describe('a signed-in owner', () => {
  let owner: { userId: string; cookie: string };
  let mine: { id: string; externalId: string };
  let theirs: { id: string; externalId: string };

  beforeAll(async () => {
    owner = await signedIn('owner@agency.example');
    const invitation = await invite(t.productId, 'owner@agency.example');
    const res = await accept(owner.cookie, invitation.id);
    expect(res.status).toBe(200);
    mine = await storeFor(t.auth, 'Owner store');
    theirs = await storeFor(otherAuth, 'Other store');
  });

  it('becomes a member with the invited role', async () => {
    const view = await (await admin('GET', `/products/${t.productId}/organization`)).json();
    expect(view.members).toEqual([expect.objectContaining({ userId: owner.userId, email: 'owner@agency.example', role: 'owner' })]);
    expect(view.invitations.find((i: { email: string }) => i.email === 'owner@agency.example')).toBeUndefined();
  });

  it('sees who they are and their organization', async () => {
    const res = await asUser(owner.cookie, 'GET', '/account');
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.user.email).toBe('owner@agency.example');
    expect(me.active).toMatchObject({ productId: t.productId, role: 'owner' });
  });

  it('reaches /v1 as their product, reading and changing', async () => {
    const keys = await asUser(owner.cookie, 'GET', '/v1/keys');
    expect(keys.status).toBe(200);
    const added = await asUser(owner.cookie, 'POST', '/v1/keys', { label: 'From the dashboard' });
    expect(added.status).toBe(201);
    const list = (await (await t.call('GET', '/v1/keys')).json()) as { label: string }[];
    expect(list.map((k) => k.label)).toContain('From the dashboard');
  });

  it("sees their own stores and never another product's", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (await (await asUser(owner.cookie, 'GET', '/v1/tenants')).json()) as any[];
    expect(list.map((x) => x.id)).toContain(mine.id);
    expect(list.map((x) => x.id)).not.toContain(theirs.id);
    expect(await (await asUser(owner.cookie, 'GET', `/v1/tenants?externalId=${theirs.externalId}`)).json()).toEqual([]);
    // The API answers 400 "not found" for a store that isn't the caller's, and leaves it alone.
    expect((await asUser(owner.cookie, 'DELETE', `/v1/tenants?tenantId=${theirs.id}`)).status).toBe(400);
    expect((await t.pool.query('SELECT status FROM tenants WHERE id = $1', [theirs.id])).rows[0].status).toBe(Status.Done);
  });

  it("sees only their product's request log and backups", async () => {
    await t.call('GET', '/v1/keys', { auth: otherAuth });
    const res = await asUser(owner.cookie, 'GET', '/account/requests');
    expect(res.status).toBe(200);
    const log = await res.json();
    expect(log.items.length).toBeGreaterThan(0);
    expect(log.items.every((r: { productId: string }) => r.productId === t.productId)).toBe(true);
    const backups = await asUser(owner.cookie, 'GET', '/account/backups');
    expect(backups.status).toBe(200);
    expect((await backups.json()).items.every((b: { productId: string }) => b.productId === t.productId)).toBe(true);
  });

  it("gets the dashboard's overview, stores and jobs for their product only", async () => {
    const overview = await (await asUser(owner.cookie, 'GET', '/account/overview')).json();
    expect(overview.products).toEqual([expect.objectContaining({ id: t.productId })]);
    const ownStores = (await t.pool.query('SELECT count(*)::int AS n FROM tenants WHERE product_id = $1', [t.productId])).rows[0].n;
    const total = overview.tenants.pending + overview.tenants.done + overview.tenants.failed + overview.tenants.removing;
    expect(total).toBe(ownStores);

    const stores = await (await asUser(owner.cookie, 'GET', `/account/tenants?productId=${otherProductId}`)).json();
    expect(stores.items.map((x: { id: string }) => x.id)).toContain(mine.id);
    expect(stores.items.every((x: { productId: string }) => x.productId === t.productId)).toBe(true);
    expect((await asUser(owner.cookie, 'GET', `/account/tenants/${mine.id}`)).status).toBe(200);
    expect((await asUser(owner.cookie, 'GET', `/account/tenants/${theirs.id}`)).status).toBe(404);
    expect((await asUser(owner.cookie, 'GET', `/account/tenants/${theirs.id}/mail-domain`)).status).toBe(404);
    expect((await asUser(owner.cookie, 'PUT', `/account/tenants/${theirs.id}/domains/main`, { domainName: 'x.example.com' })).status).toBe(404);
    expect((await asUser(owner.cookie, 'POST', `/account/tenants/${theirs.id}/restore`, { backupId: theirs.id })).status).toBe(404);

    for (const state of ['queued', 'running', 'failed']) {
      expect((await asUser(owner.cookie, 'GET', `/account/jobs?state=${state}`)).status).toBe(200);
    }
    const failure = await t.pool.query<{ id: string }>(
      `INSERT INTO job_failures (job_id, job_type, job_data, tenant_id, error_message, attempts)
       VALUES (gen_random_uuid(), 'tenant.update', $1, $2, 'boom', 3) RETURNING id`,
      [{ type: 'tenant.update', tenantId: theirs.id }, theirs.id],
    );
    const failed = await (await asUser(owner.cookie, 'GET', '/account/jobs?state=failed')).json();
    expect(failed.items.map((f: { id: string }) => f.id)).not.toContain(failure.rows[0]!.id);
    expect((await asUser(owner.cookie, 'POST', `/account/jobs/failures/${failure.rows[0]!.id}/retry`)).status).toBe(404);
    await t.pool.query('DELETE FROM job_failures WHERE id = $1', [failure.rows[0]!.id]);
  });

  it("manages their product's keys and webhooks, and nothing of another product's", async () => {
    expect((await asUser(owner.cookie, 'GET', `/account/products/${t.productId}/keys`)).status).toBe(200);
    expect((await asUser(owner.cookie, 'GET', `/account/products/${otherProductId}/keys`)).status).toBe(404);
    expect((await asUser(owner.cookie, 'POST', `/account/products/${otherProductId}/keys`, { label: 'x' })).status).toBe(404);

    const created = await asUser(owner.cookie, 'POST', '/account/webhooks', { url: 'https://hooks.example.com/a', events: ['tenant.created'] });
    expect(created.status).toBe(201);
    const listed = await (await asUser(owner.cookie, 'GET', `/account/webhooks?productId=${otherProductId}`)).json();
    expect(listed.every((w: { productId: string }) => w.productId === t.productId)).toBe(true);
    expect((await asUser(owner.cookie, 'POST', '/account/webhooks', { productId: otherProductId, url: 'https://hooks.example.com/b' })).status).toBe(400);
    const theirHook = await t.call('POST', '/v1/webhooks', { body: { url: 'https://hooks.example.com/c', events: ['tenant.created'] }, auth: otherAuth });
    const theirId = ((await theirHook.json()) as { id: string }).id;
    expect((await asUser(owner.cookie, 'DELETE', `/account/webhooks/${theirId}`)).status).toBe(404);
  });

  it("can't reach what only the platform admin may do", async () => {
    expect((await asUser(owner.cookie, 'GET', '/account/products')).status).toBe(200);
    expect(await (await asUser(owner.cookie, 'GET', '/account/products')).json()).toEqual([expect.objectContaining({ id: t.productId })]);
    expect((await asUser(owner.cookie, 'POST', '/account/products', { name: 'Mine now' })).status).toBe(404);
    expect((await asUser(owner.cookie, 'PUT', `/account/products/${t.productId}`, { maxTenants: null })).status).toBe(404);
    expect((await asUser(owner.cookie, 'GET', '/account/db-backups')).status).toBe(404);
    expect((await asUser(owner.cookie, 'GET', '/account/plugins')).status).toBe(404);
    expect((await asUser(owner.cookie, 'GET', `/account/products/${t.productId}/organization`)).status).toBe(404);
    expect((await asUser(owner.cookie, 'POST', `/account/products/${t.productId}/invitations`, { email: 'x@example.com' })).status).toBe(404);
  });

  it('has their changes in the request log, with who made them', async () => {
    await asUser(owner.cookie, 'POST', `/account/products/${t.productId}/keys`, { label: 'Logged' });
    const { rows } = await t.pool.query("SELECT source, product_id, user_id FROM api_requests WHERE path = $1 AND method = 'POST' ORDER BY id DESC LIMIT 1", [
      `/account/products/${t.productId}/keys`,
    ]);
    expect(rows[0]).toEqual({ source: 'account', product_id: t.productId, user_id: owner.userId });
  });
});

describe('a signed-in member', () => {
  let member: { userId: string; cookie: string };

  beforeAll(async () => {
    member = await signedIn('viewer@agency.example');
    const invitation = await invite(t.productId, 'viewer@agency.example', 'member');
    expect((await accept(member.cookie, invitation.id)).status).toBe(200);
  });

  it('can look but not change anything', async () => {
    expect((await asUser(member.cookie, 'GET', '/v1/keys')).status).toBe(200);
    const res = await asUser(member.cookie, 'POST', '/v1/keys', { label: 'Nope' });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/only look/);
    expect((await asUser(member.cookie, 'GET', '/account/overview')).status).toBe(200);
    expect((await asUser(member.cookie, 'POST', `/account/products/${t.productId}/keys`, { label: 'Nope' })).status).toBe(403);
  });

  it('loses access once removed', async () => {
    const view = await (await admin('GET', `/products/${t.productId}/organization`)).json();
    const row = view.members.find((m: { userId: string }) => m.userId === member.userId);
    expect((await admin('DELETE', `/products/${t.productId}/members/${row.id}`)).status).toBe(200);
    const res = await asUser(member.cookie, 'GET', '/v1/keys');
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/not part of an organization/);
  });
});

describe('who cannot get in', () => {
  it('someone whose email does not match the invitation', async () => {
    const stranger = await signedIn('stranger@example.com');
    const invitation = await invite(t.productId, 'someone-else@example.com');
    expect((await accept(stranger.cookie, invitation.id)).status).not.toBe(200);
  });

  it('a request without a session, or with a made-up one', async () => {
    expect((await app.request('/v1/keys', { headers: { 'X-Session-Auth': '1' } })).status).toBe(403);
    expect((await asUser('better-auth.session_token=forged.value', 'GET', '/v1/keys')).status).toBe(403);
    expect((await app.request('/account')).status).toBe(403);
    expect((await app.request('/account/requests')).status).toBe(403);
    // A browser's own request (no X-Session-Auth) never reaches the account routes.
    const { cookie } = await signedIn('browser@example.com');
    expect((await app.request('/account/overview', { headers: { Cookie: cookie } })).status).toBe(403);
  });

  it('a session cookie without X-Session-Auth goes to the API key check', async () => {
    const { cookie } = await signedIn('nokey@example.com');
    const res = await app.request('/v1/keys', { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('Invalid API key or secret');
  });

  it('API keys keep working as before', async () => {
    expect((await t.call('GET', '/v1/keys')).status).toBe(200);
  });
});

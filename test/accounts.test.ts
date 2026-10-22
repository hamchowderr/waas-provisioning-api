import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { testUtils } from 'better-auth/plugins';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

  it("sees failed sign-ins with their own keys, but nothing of another product's, nor its store names", async () => {
    const own = await createApiKey(t.pool, t.productId);
    const other = await createApiKey(t.pool, otherProductId);
    const marker = randomUUID();
    // A wrong secret for each product's key, another product's successful call, and a call of ours
    // that names another product's store.
    await t.call('GET', `/v1/versions?versionName=${marker}`, { auth: basic(own.key, 'wrong') });
    await t.call('GET', `/v1/versions?versionName=${marker}`, { auth: basic(other.key, 'wrong') });
    await t.call('GET', `/v1/versions?versionName=${marker}`, { auth: otherAuth });
    await t.call('GET', `/v1/tenants?tenantId=${theirs.id}&versionName=${marker}`);
    const res = await asUser(owner.cookie, 'GET', '/account/requests?path=/v1/');
    expect(res.status).toBe(200);
    const log = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const marked = log.items.filter((r: any) => r.query?.includes(marker));
    expect(marked).toHaveLength(2);
    expect(marked).toContainEqual(expect.objectContaining({ apiKeyId: own.key, productId: null, status: 403 }));
    expect(marked).toContainEqual(expect.objectContaining({ productId: t.productId, tenantId: theirs.id, tenantName: null }));
    expect(JSON.stringify(log)).not.toContain(other.key);
    expect(JSON.stringify(log)).not.toContain(otherProductId);
    expect(JSON.stringify(log)).not.toContain('Other store');
    // Asking for the other product, or its key's store, changes nothing: the session picks the product.
    const asked = await (await asUser(owner.cookie, 'GET', `/account/requests?productId=${otherProductId}`)).json();
    expect(JSON.stringify(asked)).not.toContain(otherProductId);
    // The platform admin still sees all of it, store names included.
    const all = await (await admin('GET', '/requests')).json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allMarked = all.items.filter((r: any) => r.query?.includes(marker));
    expect(allMarked).toHaveLength(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(allMarked.find((r: any) => r.tenantId === theirs.id).tenantName).toBe('Other store');
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
    expect((await asUser(owner.cookie, 'PUT', `/account/products/${t.productId}/organization`, { name: 'Renamed' })).status).toBe(404);
    expect((await asUser(owner.cookie, 'GET', `/account/products/${otherProductId}/organization`)).status).toBe(404);
    expect((await asUser(owner.cookie, 'POST', `/account/products/${otherProductId}/invitations`, { email: 'x@example.com' })).status).toBe(404);
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

describe('the Team page (/account, the team running itself)', () => {
  let productId: string;
  let owner: { userId: string; cookie: string };
  let admin2: { userId: string; cookie: string };
  let viewer: { userId: string; cookie: string };
  const sent: { to: string; subject: string; text: string }[] = [];
  const team = (cookie: string, method: string, path = '', body?: unknown) => asUser(cookie, method, `/account/products/${productId}${path}`, body);
  const memberId = async (userId: string) =>
    ((await (await admin('GET', `/products/${productId}/organization`)).json()).members as { id: string; userId: string }[]).find((m) => m.userId === userId)!.id;

  /** Signs someone up and has them accept an invitation `by` the admin token or a team cookie. */
  async function join(email: string, role: string, by?: string) {
    const person = await signedIn(email);
    const res = by ? await team(by, 'POST', '/invitations', { email, role }) : await admin('POST', `/products/${productId}/invitations`, { email, role });
    expect(res.status).toBe(201);
    expect((await accept(person.cookie, ((await res.json()) as { id: string }).id)).status).toBe(200);
    return person;
  }

  beforeAll(async () => {
    productId = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Team storefront') RETURNING id")).rows[0]!.id;
    owner = await join('team-owner@agency.example', 'owner');
    admin2 = await join('team-admin@agency.example', 'admin', owner.cookie);
    viewer = await join('team-viewer@agency.example', 'member', owner.cookie);
    // Sign-in email on, with toSend answered here.
    t.deps.config.auth = { ...AUTH, mail: { key: 'test-key', from: 'no-reply@anypress.example', brand: 'AnyPress' } };
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.tosend.com/')) return realFetch(input, init);
      const body = JSON.parse(String(init!.body));
      if (body.to[0].email === 'bounce@example.com') return new Response('{"message":"nope"}', { status: 422 });
      sent.push({ to: body.to[0].email, subject: body.subject, text: body.text });
      return new Response('{"id":"e1"}', { status: 200 });
    });
  });

  afterEach(() => void sent.splice(0));
  afterAll(() => {
    vi.unstubAllGlobals();
    t.deps.config.auth = AUTH;
  });

  it('lists the team to everyone on it, members included', async () => {
    const res = await team(viewer.cookie, 'GET', '/organization');
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.members.map((m: { email: string; role: string }) => `${m.email}:${m.role}`)).toEqual([
      'team-owner@agency.example:owner',
      'team-admin@agency.example:admin',
      'team-viewer@agency.example:member',
    ]);
  });

  it('emails an invitation from an owner, as a member unless told otherwise', async () => {
    const res = await team(owner.cookie, 'POST', '/invitations', { email: 'New@Agency.example' });
    expect(res.status).toBe(201);
    const invitation = await res.json();
    expect(invitation).toMatchObject({ email: 'new@agency.example', role: 'member', emailed: true, acceptUrl: `${AUTH.url}/invite/${invitation.id}` });
    expect(sent).toEqual([
      {
        to: 'new@agency.example',
        subject: 'Join Team storefront on AnyPress',
        text: expect.stringContaining(`team-owner invited you to join Team storefront on AnyPress.\n\n${invitation.acceptUrl}`),
      },
    ]);
    const { rows } = await t.pool.query('SELECT "inviterId" FROM auth.invitation WHERE id = $1', [invitation.id]);
    expect(rows[0].inviterId).toBe(owner.userId);
  });

  it("sends invitations in the storefront's look, to accept on its own dashboard address", async () => {
    await t.pool.query("INSERT INTO dashboard_domains (product_id, domain, status, records) VALUES ($1, 'team.agency.example', 'active', '[]')", [productId]);
    try {
      const res = await team(owner.cookie, 'POST', '/invitations', { email: 'branded@agency.example' });
      const invitation = await res.json();
      expect(invitation.acceptUrl).toBe(`https://team.agency.example/invite/${invitation.id}`);
      expect(sent[0]).toMatchObject({ subject: 'Join the Team storefront team', text: expect.stringMatching(/Powered by AnyPress$/) });
      const listed = (await (await team(owner.cookie, 'GET', '/organization')).json()).invitations.find((i: { id: string }) => i.id === invitation.id);
      expect(listed.acceptUrl).toBe(invitation.acceptUrl);
    } finally {
      await t.pool.query('DELETE FROM dashboard_domains WHERE product_id = $1', [productId]);
    }
  });

  it("keeps the invitation when the email doesn't go, so its link can be sent by hand", async () => {
    const res = await team(owner.cookie, 'POST', '/invitations', { email: 'bounce@example.com' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ emailed: false, acceptUrl: expect.stringContaining('/invite/') });
  });

  it('emails invitations the platform admin sends too', async () => {
    const res = await admin('POST', `/products/${productId}/invitations`, { email: 'first@agency.example' });
    expect(await res.json()).toMatchObject({ role: 'owner', emailed: true });
    expect(sent[0]!.text).toMatch(/^You've been invited to join Team storefront on AnyPress\./);
  });

  it('lets admins invite and remove people, but not owners', async () => {
    expect((await team(admin2.cookie, 'POST', '/invitations', { email: 'helper@agency.example', role: 'admin' })).status).toBe(201);
    const res = await team(admin2.cookie, 'POST', '/invitations', { email: 'boss@agency.example', role: 'owner' });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/Only an owner/);
    expect((await team(admin2.cookie, 'DELETE', `/members/${await memberId(owner.userId)}`)).status).toBe(403);
    expect((await team(admin2.cookie, 'PATCH', `/members/${await memberId(viewer.userId)}`, { role: 'owner' })).status).toBe(403);
  });

  it("doesn't let members change anything", async () => {
    expect((await team(viewer.cookie, 'POST', '/invitations', { email: 'x@agency.example' })).status).toBe(403);
    expect((await team(viewer.cookie, 'DELETE', `/members/${await memberId(admin2.userId)}`)).status).toBe(403);
  });

  it('changes roles, and nobody changes or removes themselves', async () => {
    const res = await team(owner.cookie, 'PATCH', `/members/${await memberId(viewer.userId)}`, { role: 'admin' });
    expect(res.status).toBe(200);
    expect((await res.json()).members.find((m: { userId: string }) => m.userId === viewer.userId).role).toBe('admin');
    expect((await team(owner.cookie, 'PATCH', `/members/${await memberId(viewer.userId)}`, { role: 'member' })).status).toBe(200);
    expect((await team(owner.cookie, 'PATCH', `/members/${await memberId(viewer.userId)}`, { role: 'god' })).status).toBe(400);
    expect((await team(owner.cookie, 'DELETE', `/members/${await memberId(owner.userId)}`)).status).toBe(403);
    expect((await team(admin2.cookie, 'PATCH', `/members/${await memberId(admin2.userId)}`, { role: 'member' })).status).toBe(403);
  });

  it('always keeps an owner', async () => {
    const res = await admin('PATCH', `/products/${productId}/members/${await memberId(owner.userId)}`, { role: 'admin' });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toMatch(/at least one owner/);
  });

  it('removes someone and cancels an invitation', async () => {
    const view = await (await team(admin2.cookie, 'DELETE', `/members/${await memberId(viewer.userId)}`)).json();
    expect(view.members.map((m: { userId: string }) => m.userId)).not.toContain(viewer.userId);
    const id = view.invitations.find((i: { email: string }) => i.email === 'helper@agency.example').id;
    expect((await team(admin2.cookie, 'DELETE', `/invitations/${id}`)).status).toBe(200);
    expect((await team(viewer.cookie, 'GET', '/organization')).status).toBe(403);
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

describe("a reseller's team (docs/resellers.md)", () => {
  let resellerId: string;
  let first: string;
  let second: string;
  let partner: { userId: string; cookie: string };

  const productNamed = async (name: string) => (await t.pool.query<{ id: string }>('INSERT INTO products (name) VALUES ($1) RETURNING id', [name])).rows[0]!.id;
  const picking = (productId: string) => ({ 'X-Product-Id': productId });

  beforeAll(async () => {
    first = await productNamed('Alpha storefront');
    second = await productNamed('Beta storefront');
    const res = await admin('POST', '/resellers', { name: 'Team Partners', productIds: [first, second] });
    expect(res.status).toBe(201);
    resellerId = ((await res.json()) as { id: string }).id;
  });

  it('is made, invited to and listed by the platform admin only', async () => {
    expect((await admin('PUT', `/resellers/${resellerId}/organization`, {})).status).toBe(201);
    const invitation = await admin('POST', `/resellers/${resellerId}/invitations`, { email: 'Lead@Partner.example' });
    expect(invitation.status).toBe(201);
    const sent = (await invitation.json()) as { id: string };
    expect(sent).toMatchObject({ email: 'lead@partner.example', role: 'owner' });
    partner = await signedIn('lead@partner.example');
    expect((await accept(partner.cookie, sent.id)).status).toBe(200);
    const view = await (await admin('GET', `/resellers/${resellerId}/organization`)).json();
    expect(view.organization).toMatchObject({ name: 'Team Partners', resellerId });
    expect(view.organization.productId).toBeUndefined();
    expect(view.members).toEqual([expect.objectContaining({ userId: partner.userId, role: 'owner' })]);
    expect((await admin('GET', '/resellers/00000000-0000-4000-8000-000000000000/organization')).status).toBe(404);
    // Not on /account: a storefront's team doesn't manage its reseller's.
    expect((await asUser(partner.cookie, 'GET', `/account/resellers/${resellerId}/organization`, undefined, picking(first))).status).toBe(404);
  });

  it("reaches every one of the reseller's storefronts, one membership each", async () => {
    const me = await (await asUser(partner.cookie, 'GET', '/account')).json();
    expect(me.memberships.map((m: { productId: string }) => m.productId).sort()).toEqual([first, second].sort());
    expect(me.memberships.every((m: { resellerId: string; role: string }) => m.resellerId === resellerId && m.role === 'owner')).toBe(true);
  });

  it('acts on the storefront X-Product-Id picks, and only on one of theirs', async () => {
    const onFirst = await asUser(partner.cookie, 'GET', '/account', undefined, picking(first));
    expect((await onFirst.json()).active).toMatchObject({ productId: first, resellerId });
    expect((await asUser(partner.cookie, 'POST', '/v1/keys', { label: 'Alpha key' }, picking(first))).status).toBe(201);
    expect((await asUser(partner.cookie, 'POST', '/v1/keys', { label: 'Beta key' }, picking(second))).status).toBe(201);
    const labels = async (productId: string) => (await t.pool.query('SELECT label FROM api_keys WHERE product_id = $1', [productId])).rows.map((r) => r.label);
    expect(await labels(first)).toEqual(['Alpha key']);
    expect(await labels(second)).toEqual(['Beta key']);
    expect((await asUser(partner.cookie, 'GET', `/account/products/${second}/organization`, undefined, picking(second))).status).toBe(200);
    expect((await asUser(partner.cookie, 'GET', `/account/products/${first}/organization`, undefined, picking(second))).status).toBe(404);
    // A storefront outside the reseller can't be picked: the session's own pick stands, one of theirs.
    const outside = await (await asUser(partner.cookie, 'GET', '/account', undefined, picking(t.productId))).json();
    expect([first, second]).toContain(outside.active.productId);
    expect((await asUser(partner.cookie, 'GET', `/account/products/${t.productId}/organization`, undefined, picking(t.productId))).status).toBe(404);
  });

  it("keeps the higher role for someone also on a storefront's own team", async () => {
    const both = await signedIn('both@partner.example');
    expect((await accept(both.cookie, ((await (await admin('POST', `/resellers/${resellerId}/invitations`, { email: 'both@partner.example', role: 'member' })).json()) as { id: string }).id)).status).toBe(200);
    expect((await accept(both.cookie, (await invite(first, 'both@partner.example', 'admin')).id)).status).toBe(200);
    const me = await (await asUser(both.cookie, 'GET', '/account')).json();
    expect(me.memberships).toHaveLength(2);
    expect(me.memberships.find((m: { productId: string }) => m.productId === first)).toMatchObject({ role: 'admin', resellerId: null });
    expect(me.memberships.find((m: { productId: string }) => m.productId === second)).toMatchObject({ role: 'member', resellerId });
    expect((await asUser(both.cookie, 'POST', '/v1/keys', { label: 'x' }, picking(second))).status).toBe(403);
  });

  it('follows the storefront when it moves out, and the person when they leave', async () => {
    expect((await admin('DELETE', `/resellers/${resellerId}/products/${second}`)).status).toBe(200);
    let me = await (await asUser(partner.cookie, 'GET', '/account')).json();
    expect(me.memberships.map((m: { productId: string }) => m.productId)).toEqual([first]);
    expect(me.active).toMatchObject({ productId: first });

    const view = await (await admin('GET', `/resellers/${resellerId}/organization`)).json();
    const lead = view.members.find((m: { userId: string }) => m.userId === partner.userId);
    expect((await admin('PATCH', `/resellers/${resellerId}/members/${lead.id}`, { role: 'member' })).status).toBe(409);
    expect((await admin('DELETE', `/resellers/${resellerId}/members/${lead.id}`)).status).toBe(200);
    me = await (await asUser(partner.cookie, 'GET', '/account')).json();
    expect(me.memberships).toEqual([]);
    expect((await asUser(partner.cookie, 'GET', '/v1/keys', undefined, picking(first))).status).toBe(403);
  });
});

// Connecting an AI app to /mcp by signing in as a person (src/oauth.ts, src/oauthserver.ts): Better
// Auth's MCP plugin sends the browser to the dashboard's Connect page (AUTH_URL/connect?<its signed
// request>), which approves for one of the person's storefronts through /account/oauth/connect, with
// the scopes they ticked. The token acts as that person, with
// their role, while they stay on the team. A platform admin (the dashboard's server vouches with the
// admin token) sees every storefront and may approve for any of them.
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { testUtils } from 'better-auth/plugins';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { createApp } from '../src/app.ts';
import { ALL_SCOPES, READ_SCOPES } from '../mcp/src/scopes.ts';
import { setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

const BASE = 'https://api.example.test';
const REDIRECT = 'http://localhost:3999/callback';
const AUTH: AuthConfig = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789', brand: 'AnyPress', apiUrl: BASE };

let t: TestContext;
let app: ReturnType<typeof createApp>;
let helpers: any;
let owner: { userId: string; cookie: string };
let viewer: { userId: string; cookie: string };

const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(request.url);
  return app.request(`${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
  });
}) as typeof fetch;

function provider() {
  const saved: { client?: unknown; tokens?: unknown; verifier?: string; authorizationUrl?: URL } = {};
  const p: OAuthClientProvider & { saved: typeof saved } = {
    saved,
    redirectUrl: REDIRECT,
    clientMetadata: { client_name: 'Claude', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    clientInformation: () => saved.client as never,
    saveClientInformation: (info) => void (saved.client = info),
    tokens: () => saved.tokens as never,
    saveTokens: (tokens) => void (saved.tokens = tokens),
    redirectToAuthorization: (url) => void (saved.authorizationUrl = url),
    saveCodeVerifier: (verifier) => void (saved.verifier = verifier),
    codeVerifier: () => saved.verifier!,
  };
  return p;
}

const transportFor = (p: OAuthClientProvider) => new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: appFetch, authProvider: p });

/** The dashboard's server, calling /account with the person's session. */
const asUser = (cookie: string, method: string, path: string, body?: unknown, adminToken?: string) =>
  app.request(path, {
    method,
    headers: { Cookie: cookie, 'X-Session-Auth': '1', 'Content-Type': 'application/json', ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const admin = (method: string, path: string, body?: unknown) =>
  app.request(`/admin${path}`, { method, headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function signedIn(email: string) {
  const user = await helpers.saveUser(helpers.createUser({ email, name: email.split('@')[0], emailVerified: true }));
  const { headers } = await helpers.login({ userId: user.id });
  return { userId: user.id as string, cookie: (headers as Headers).get('cookie')! };
}

async function join(email: string, role: string) {
  const person = await signedIn(email);
  const invitation = await (await admin('POST', `/products/${t.productId}/invitations`, { email, role })).json();
  const accepted = await app.request('/api/auth/organization/accept-invitation', {
    method: 'POST',
    headers: { Cookie: person.cookie, 'Content-Type': 'application/json', Origin: AUTH.url },
    body: JSON.stringify({ invitationId: invitation.id }),
  });
  expect(accepted.status).toBe(200);
  return person;
}

/**
 * Up to the dashboard's Connect page: the app starts connecting, the browser (signed in as `who`, or
 * not) follows the plugin to AUTH_URL/connect, and the page has the plugin's signed request.
 */
async function startSignIn(who?: { cookie: string }) {
  const p = provider();
  await expect(new Client({ name: 'agent', version: '1' }).connect(transportFor(p))).rejects.toBeInstanceOf(UnauthorizedError);
  const url = p.saved.authorizationUrl!;
  expect(`${url.origin}${url.pathname}`).toBe(`${AUTH.url}/api/auth/oauth2/authorize`);
  const response = await app.request(`${url.pathname}${url.search}`, { headers: who ? { Cookie: who.cookie } : {} });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('Location')!, AUTH.url);
  expect(`${location.origin}${location.pathname}`).toBe(`${AUTH.url}/connect`);
  return { oauthQuery: location.search.slice(1), p };
}

const connectPath = (oauthQuery: string) => `/account/oauth/connect?${new URLSearchParams({ oauth_query: oauthQuery })}`;

/** Approves on the dashboard as `who`, ticking `scopes` (every one by default), then lets the app finish connecting. */
async function connectAs(who: { cookie: string }, options: { scopes?: readonly string[]; adminToken?: string; productId?: string } = {}) {
  const { oauthQuery, p } = await startSignIn(who);
  const body = { oauth_query: oauthQuery, action: 'approve', productId: options.productId ?? t.productId, scopes: options.scopes ?? ALL_SCOPES };
  const res = await asUser(who.cookie, 'POST', '/account/oauth/connect', body, options.adminToken);
  expect(res.status).toBe(200);
  const callback = new URL((await res.json()).redirectUrl);
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
  expect(callback.searchParams.get('iss')).toBe(BASE);
  await transportFor(p).finishAuth(callback.searchParams);
  // A refresh token always comes too (offline_access is added for every app), so connections last 30 days.
  expect(p.saved.tokens).toMatchObject({ refresh_token: expect.any(String), expires_in: 3600 });
  const client = new Client({ name: 'agent', version: '1' });
  await client.connect(transportFor(p));
  return { client, p };
}

/** The scopes a token response gave, without the refresh token's offline_access. */
const scopesOf = (p: { saved: { tokens?: unknown } }) => ((p.saved.tokens as { scope: string }).scope.split(' ').filter((s) => s !== 'offline_access')).join(' ');

const tools = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name);

beforeAll(async () => {
  t = await setup();
  t.deps.config.publicUrl = BASE;
  const auth = createAuth(t.pool, AUTH, [testUtils()]);
  helpers = ((await auth.$context) as unknown as { test: unknown }).test;
  t.deps.config.auth = AUTH;
  t.deps.auth = auth;
  app = createApp(t.deps);
  owner = await join('owner@agency.example', 'owner');
  viewer = await join('viewer@agency.example', 'member');
});
afterAll(() => t.close());

describe('connecting an AI app by signing in', () => {
  it('shows the dashboard what is asking, and the storefronts to pick from', async () => {
    const { oauthQuery } = await startSignIn(owner);
    const res = await asUser(owner.cookie, 'GET', connectPath(oauthQuery));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      clientName: 'Claude',
      returnTo: 'localhost:3999',
      wantsWrite: true,
      asAdmin: false,
      storefronts: [{ productId: t.productId, role: 'owner', canChange: true }],
    });
    // The dashboard's server only: no X-Session-Auth, no answer.
    expect((await app.request(connectPath(oauthQuery), { headers: { Cookie: owner.cookie } })).status).toBe(403);
    // A request the plugin didn't sign, or one changed on the way, is refused.
    expect((await asUser(owner.cookie, 'GET', connectPath(oauthQuery.replace('scope=', 'scope=webhooks%3Awrite+')))).status).toBe(404);
  });

  it("redirects the browser through the dashboard's server, whose own fetch says cors", async () => {
    const p = provider();
    await expect(new Client({ name: 'agent', version: '1' }).connect(transportFor(p))).rejects.toBeInstanceOf(UnauthorizedError);
    const url = p.saved.authorizationUrl!;
    const through = (headers: Record<string, string>) => app.request(`${url.pathname}${url.search}`, { headers: { Cookie: owner.cookie, Accept: 'text/html', 'Sec-Fetch-Mode': 'cors', ...headers } });
    // The browser navigated: a redirect to the Connect page.
    const navigated = await through({ 'X-Forwarded-Sec-Fetch-Mode': 'navigate' });
    expect(navigated.status).toBe(302);
    expect(new URL(navigated.headers.get('Location')!, AUTH.url).pathname).toBe('/connect');
    // A script's request still gets the plugin's JSON answer.
    expect((await through({})).status).toBe(200);
  });

  it('connects as the person, with changes allowed for an owner', async () => {
    const { client, p } = await connectAs(owner);
    expect(scopesOf(p)).toBe(ALL_SCOPES.join(' '));
    expect(await tools(client)).toContain('create_store');
    expect((await client.callTool({ name: 'manage_versions', arguments: { action: 'list' } })).isError).toBeFalsy();
    // Tool calls go through /v1 as this person, so the request log says who.
    const { rows } = await t.pool.query("SELECT api_key_id, user_id, product_id FROM api_requests WHERE path = '/v1/versions' ORDER BY id DESC LIMIT 1");
    expect(rows[0]).toEqual({ api_key_id: null, user_id: owner.userId, product_id: t.productId });
    await client.close();
  });

  it('gives someone who may only look read-only access, whatever they ticked', async () => {
    const { client, p } = await connectAs(viewer);
    expect(scopesOf(p)).toBe(READ_SCOPES.join(' '));
    expect(await tools(client)).not.toContain('create_store');
    await client.close();
  });

  it('declining goes back with access_denied', async () => {
    const { oauthQuery } = await startSignIn(owner);
    const denied = await asUser(owner.cookie, 'POST', '/account/oauth/connect', { oauth_query: oauthQuery, action: 'deny' });
    expect(new URL((await denied.json()).redirectUrl).searchParams.get('error')).toBe('access_denied');
  });

  it('asks again on a second connection, and what is ticked then counts', async () => {
    const first = await connectAs(owner);
    await first.client.close();
    const second = await connectAs(owner, { scopes: ['stores:read'] });
    expect(scopesOf(second.p)).toBe('stores:read');
    await second.client.close();
  });

  it("refuses a storefront the person isn't on", async () => {
    const stranger = await signedIn('stranger@example.com');
    const { oauthQuery } = await startSignIn(stranger);
    expect((await (await asUser(stranger.cookie, 'GET', connectPath(oauthQuery))).json()).storefronts).toEqual([]);
    expect((await asUser(stranger.cookie, 'POST', '/account/oauth/connect', { oauth_query: oauthQuery, action: 'approve', productId: t.productId, scopes: ['stores:read'] })).status).toBe(400);
  });

  it('follows the person: read-only once they may only look, cut off once they leave the team', async () => {
    const { client, p } = await connectAs(owner);
    await client.close();
    const tokens = p.saved.tokens as { access_token: string; refresh_token: string };
    const clientId = (p.saved.client as { client_id: string }).client_id;
    const mcp = () =>
      app.request('/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect(await (await mcp()).text()).toContain('create_store');

    // A second owner, so this one can become a member.
    await join('second@agency.example', 'owner');
    const view = await (await admin('GET', `/products/${t.productId}/organization`)).json();
    const memberId = view.members.find((m: { userId: string }) => m.userId === owner.userId).id;
    expect((await admin('PATCH', `/products/${t.productId}/members/${memberId}`, { role: 'member' })).status).toBe(200);
    const readOnly = await mcp();
    expect(readOnly.status).toBe(200);
    expect(await readOnly.text()).not.toContain('create_store');

    expect((await admin('DELETE', `/products/${t.productId}/members/${memberId}`)).status).toBe(200);
    expect((await mcp()).status).toBe(401);
    const refreshed = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }).toString(),
    });
    expect(refreshed.status).toBe(400);
  });

  it('lets a platform admin approve for any storefront, as an owner would', async () => {
    const admin = await signedIn('platform@anypress.example');
    const other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Another storefront') RETURNING id")).rows[0]!.id;
    const { oauthQuery } = await startSignIn(admin);
    // Without the admin token, someone on no team has nothing to pick.
    expect((await (await asUser(admin.cookie, 'GET', connectPath(oauthQuery))).json()).storefronts).toEqual([]);
    // A wrong token is no better.
    expect((await (await asUser(admin.cookie, 'GET', connectPath(oauthQuery), undefined, 'not-the-token')).json()).asAdmin).toBe(false);
    const view = await (await asUser(admin.cookie, 'GET', connectPath(oauthQuery), undefined, TEST_ADMIN_TOKEN)).json();
    expect(view.asAdmin).toBe(true);
    expect(view.storefronts).toEqual(
      expect.arrayContaining([
        { productId: t.productId, name: 'Example storefront', role: 'platform admin', canChange: true },
        { productId: other, name: 'Another storefront', role: 'platform admin', canChange: true },
      ]),
    );

    const { client, p } = await connectAs(admin, { adminToken: TEST_ADMIN_TOKEN });
    expect(scopesOf(p)).toBe(ALL_SCOPES.join(' '));
    expect(await tools(client)).toContain('create_store');
    expect((await client.callTool({ name: 'manage_versions', arguments: { action: 'list' } })).isError).toBeFalsy();
    await client.close();
    // The token says a platform admin approved it.
    const access = (p.saved.tokens as { access_token: string }).access_token;
    expect(JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString())).toMatchObject({ product_id: t.productId, platform_admin: true, sub: admin.userId });

    // Without the admin token, the same person can't approve for a storefront they aren't on.
    const second = await startSignIn(admin);
    expect((await asUser(admin.cookie, 'POST', '/account/oauth/connect', { oauth_query: second.oauthQuery, action: 'approve', productId: other, scopes: ['stores:read'] })).status).toBe(400);
  });

  it('has no app sign-in when sign-in is off', async () => {
    t.deps.config.auth = undefined;
    try {
      expect((await app.request('/.well-known/oauth-authorization-server')).status).toBe(404);
    } finally {
      t.deps.config.auth = AUTH;
    }
  });
});

describe("a reseller's team member (docs/resellers.md)", () => {
  it('connects for one of the reseller\'s storefronts, and is cut off once they leave the team', async () => {
    const reseller = await (await admin('POST', '/resellers', { name: 'Signin Partners', productIds: [t.productId] })).json();
    const partner = await signedIn('partner@reseller.example');
    const invitation = await (await admin('POST', `/resellers/${reseller.id}/invitations`, { email: 'partner@reseller.example', role: 'admin' })).json();
    const accepted = await app.request('/api/auth/organization/accept-invitation', {
      method: 'POST',
      headers: { Cookie: partner.cookie, 'Content-Type': 'application/json', Origin: AUTH.url },
      body: JSON.stringify({ invitationId: invitation.id }),
    });
    expect(accepted.status).toBe(200);

    const { client, p } = await connectAs(partner);
    expect(await tools(client)).toContain('create_store');
    await client.close();
    const tokens = p.saved.tokens as { access_token: string };
    const mcp = () =>
      app.request('/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await mcp()).status).toBe(200);

    const view = await (await admin('GET', `/resellers/${reseller.id}/organization`)).json();
    const memberId = view.members.find((m: { userId: string }) => m.userId === partner.userId).id;
    expect((await admin('DELETE', `/resellers/${reseller.id}/members/${memberId}`)).status).toBe(200);
    expect((await mcp()).status).toBe(401);
  });
});

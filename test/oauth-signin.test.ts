// Connecting an AI app to /mcp by signing in as a person (src/oauth.ts): the approve page hands over
// to the dashboard (AUTH_URL/connect/<id>), which approves for one of the person's storefronts
// through /account/oauth/requests. The token acts as that person, with their role, while they stay
// on the team.
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { testUtils } from 'better-auth/plugins';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { createApp } from '../src/app.ts';
import { setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

const BASE = 'https://api.example.test';
const REDIRECT = 'http://localhost:3999/callback';
const AUTH: AuthConfig = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789' };

let t: TestContext;
let app: ReturnType<typeof createApp>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The dashboard's server, calling /account with the person's session. */
const asUser = (cookie: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { Cookie: cookie, 'X-Session-Auth': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

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

/** Up to the approve page's "Sign in" button; returns the connection request's id and the provider. */
async function startSignIn() {
  const p = provider();
  await expect(new Client({ name: 'agent', version: '1' }).connect(transportFor(p))).rejects.toBeInstanceOf(UnauthorizedError);
  const url = p.saved.authorizationUrl!;
  const html = await (await app.request(`${url.pathname}${url.search}`)).text();
  expect(html).toContain('Sign in to AnyPress');
  const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, decode(m[2]!)]));
  const response = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...hidden, action: 'signin' }).toString(),
  });
  expect(response.status).toBe(302);
  const location = response.headers.get('Location')!;
  expect(location).toMatch(new RegExp(`^${AUTH.url}/connect/[0-9a-f-]{36}$`));
  return { id: location.split('/').pop()!, p };
}

/** Approves on the dashboard as `who`, then lets the app finish connecting. */
async function connectAs(who: { cookie: string }, allowWrite = true) {
  const { id, p } = await startSignIn();
  const res = await asUser(who.cookie, 'POST', `/account/oauth/requests/${id}`, { action: 'approve', productId: t.productId, allowWrite });
  expect(res.status).toBe(200);
  const callback = new URL((await res.json()).redirectUrl);
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
  expect(callback.searchParams.get('iss')).toBe(BASE);
  await transportFor(p).finishAuth(callback.searchParams);
  const client = new Client({ name: 'agent', version: '1' });
  await client.connect(transportFor(p));
  return { client, p };
}

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
    const { id } = await startSignIn();
    const res = await asUser(owner.cookie, 'GET', `/account/oauth/requests/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      clientName: 'Claude',
      returnTo: 'localhost:3999',
      wantsWrite: true,
      storefronts: [{ productId: t.productId, role: 'owner', canChange: true }],
    });
    // The dashboard's server only: no X-Session-Auth, no answer.
    expect((await app.request(`/account/oauth/requests/${id}`, { headers: { Cookie: owner.cookie } })).status).toBe(403);
  });

  it('connects as the person, with changes allowed for an owner', async () => {
    const { client, p } = await connectAs(owner);
    expect(p.saved.tokens).toMatchObject({ scope: 'stores:read stores:write' });
    expect(await tools(client)).toContain('create_store');
    expect((await client.callTool({ name: 'list_versions', arguments: {} })).isError).toBeFalsy();
    // Tool calls go through /v1 as this person, so the request log says who.
    const { rows } = await t.pool.query("SELECT api_key_id, user_id, product_id FROM api_requests WHERE path = '/v1/versions' ORDER BY id DESC LIMIT 1");
    expect(rows[0]).toEqual({ api_key_id: null, user_id: owner.userId, product_id: t.productId });
    await client.close();
  });

  it('gives someone who may only look read-only access, whatever they ticked', async () => {
    const { client, p } = await connectAs(viewer, true);
    expect(p.saved.tokens).toMatchObject({ scope: 'stores:read' });
    expect(await tools(client)).not.toContain('create_store');
    await client.close();
  });

  it('uses each connection request once, and declining goes back with access_denied', async () => {
    const { id } = await startSignIn();
    const denied = await asUser(owner.cookie, 'POST', `/account/oauth/requests/${id}`, { action: 'deny' });
    expect(new URL((await denied.json()).redirectUrl).searchParams.get('error')).toBe('access_denied');
    expect((await asUser(owner.cookie, 'POST', `/account/oauth/requests/${id}`, { action: 'approve', productId: t.productId })).status).toBe(404);
    expect((await asUser(owner.cookie, 'GET', `/account/oauth/requests/${id}`)).status).toBe(404);
  });

  it("refuses a storefront the person isn't on", async () => {
    const stranger = await signedIn('stranger@example.com');
    const { id } = await startSignIn();
    expect((await (await asUser(stranger.cookie, 'GET', `/account/oauth/requests/${id}`)).json()).storefronts).toEqual([]);
    expect((await asUser(stranger.cookie, 'POST', `/account/oauth/requests/${id}`, { action: 'approve', productId: t.productId })).status).toBe(400);
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

  it('offers no sign-in button when sign-in is off', async () => {
    t.deps.config.auth = undefined;
    try {
      const p = provider();
      await expect(new Client({ name: 'agent', version: '1' }).connect(transportFor(p))).rejects.toBeInstanceOf(UnauthorizedError);
      const url = p.saved.authorizationUrl!;
      expect(await (await app.request(`${url.pathname}${url.search}`)).text()).not.toContain('Sign in to');
    } finally {
      t.deps.config.auth = AUTH;
    }
  });
});

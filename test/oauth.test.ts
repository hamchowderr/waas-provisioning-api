// OAuth sign-in for /mcp (src/oauth.ts), driven by the MCP client SDK the way Claude or ChatGPT
// connect: discovery, registration (dynamic, or a Client ID Metadata Document), the approve page
// handing over to the dashboard's sign-in, ticking scopes per area, the token exchange, and then tool
// calls with the token. Also: grants from before scopes per area keep what they had.
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { createHash, randomBytes } from 'node:crypto';
import { testUtils } from 'better-auth/plugins';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_SCOPES, READ_SCOPES } from '../mcp/src/scopes.ts';
import { createApp } from '../src/app.ts';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { createApiKey } from '../src/keys.ts';
import { basic, setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

const BASE = 'https://api.example.test';
const REDIRECT = 'http://localhost:3999/callback';
const AUTH: AuthConfig = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789' };

type Access = 'read' | 'write';
/**
 * Every tool, its area, and the access each of its actions needs (mcp/src/server.ts). A tool
 * without actions needs one access. Listings are compared as `tool` or `tool.action`, so each
 * action's scope is checked, not just the tool's.
 */
const TOOLS: Record<string, { area: string; access?: Access; actions?: Record<string, Access> }> = {
  show_stores: { area: 'stores', access: 'read' },
  show_store: { area: 'stores', access: 'read' },
  get_stores: { area: 'stores', actions: { list: 'read', get: 'read', wait: 'read' } },
  create_store: { area: 'stores', access: 'write' },
  import_site: { area: 'stores', actions: { start: 'write', new_code: 'write' } },
  update_store: { area: 'stores', actions: { options: 'write', move: 'write' } },
  store_status: { area: 'stores', actions: { suspend: 'write', resume: 'write', go_live: 'write', delete: 'write' } },
  show_store_backups: { area: 'backups', access: 'read' },
  manage_backups: { area: 'backups', actions: { list: 'read', create: 'write', restore: 'write' } },
  show_store_domains: { area: 'domains', access: 'read' },
  manage_domain: { area: 'domains', actions: { list: 'read', check: 'read', connect_link: 'read', add: 'write', set_main: 'write', remove: 'write' } },
  mail_domain: { area: 'email', actions: { get: 'read', set: 'write', remove: 'write' } },
  manage_versions: { area: 'versions', actions: { list: 'read', snapshots: 'read', templates: 'read', create: 'write', set_production: 'write', delete: 'write' } },
  get_site: { area: 'site', access: 'read' },
  site_pages: { area: 'site', actions: { list: 'read', read: 'read', revisions: 'read', create: 'write', update: 'write', restore_revision: 'write' } },
  page_section: { area: 'site', actions: { add: 'write', replace: 'write', remove: 'write' } },
  site_patterns: { area: 'site', actions: { find: 'read', get: 'read' } },
  site_styles: { area: 'site', actions: { get: 'read', update: 'write' } },
  header_footer: { area: 'site', actions: { get: 'read', update: 'write' } },
  site_menus: { area: 'site', actions: { list: 'read', update: 'write' } },
  add_image: { area: 'site', access: 'write' },
};
/** What the scopes should offer: `tool` or `tool.action`, sorted. */
const toolsFor = (scopes: readonly string[]) =>
  Object.entries(TOOLS)
    .flatMap(([name, { area, access, actions }]) =>
      actions
        ? Object.entries(actions).filter(([, need]) => scopes.includes(`${area}:${need}`)).map(([action]) => `${name}.${action}`)
        : scopes.includes(`${area}:${access}`) ? [name] : [],
    )
    .sort();
/** What a tools/list offers, in the same form: each tool's action enum spelled out. */
const listing = (tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[]) =>
  tools.flatMap((tool) => {
    const actions = (tool.inputSchema.properties?.action as { enum?: string[] } | undefined)?.enum;
    return actions ? actions.map((action) => `${tool.name}.${action}`) : [tool.name];
  }).sort();

let t: TestContext;
let app: ReturnType<typeof createApp>;
let key: string;
let secret: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let helpers: any;
let owner: { userId: string; cookie: string };

/** Hands the request to the app in-process, keeping redirects visible as they are to a browser. */
const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(request.url);
  return app.request(`${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
  });
}) as typeof fetch;

/** An in-memory OAuthClientProvider: what an MCP host keeps between steps. */
function provider(options: { clientMetadataUrl?: string; scope?: string } = {}) {
  const saved: { client?: unknown; tokens?: unknown; verifier?: string; authorizationUrl?: URL } = {};
  const p: OAuthClientProvider & { saved: typeof saved } = {
    saved,
    redirectUrl: REDIRECT,
    clientMetadataUrl: options.clientMetadataUrl,
    clientMetadata: {
      client_name: 'Test Agent',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
    },
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

const transportFor = (path: string, authProvider: OAuthClientProvider) =>
  new StreamableHTTPClientTransport(new URL(`${BASE}${path}`), { fetch: appFetch, authProvider });
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hiddenFields = (html: string) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, decode(m[2]!)]));
const postForm = (fields: Record<string, string>) =>
  app.request('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

/** The dashboard's server, calling /account with the person's session (and, for a platform admin, the admin token). */
const asUser = (cookie: string, method: string, path: string, body?: unknown, adminToken?: string) =>
  app.request(path, {
    method,
    headers: { Cookie: cookie, 'X-Session-Auth': '1', 'Content-Type': 'application/json', ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Up to the approve page's "Sign in" button; returns the connection request's id. */
async function startSignIn(authorizationUrl: URL) {
  const page = await app.request(`${authorizationUrl.pathname}${authorizationUrl.search}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  const response = await postForm({ ...hiddenFields(html), action: 'signin' });
  expect(response.status).toBe(302);
  return response.headers.get('Location')!.split('/').pop()!;
}

/** The whole connect flow, ticking `scopes` on the dashboard; returns a connected client and the provider holding its tokens. */
async function connectWithOAuth(path = '/mcp', options: { clientMetadataUrl?: string; scope?: string; scopes?: readonly string[] } = {}) {
  const p = provider(options);
  await expect(new Client({ name: 'agent', version: '1' }).connect(transportFor(path, p))).rejects.toBeInstanceOf(UnauthorizedError);
  expect(p.saved.authorizationUrl).toBeDefined();
  const id = await startSignIn(p.saved.authorizationUrl!);
  const res = await asUser(owner.cookie, 'POST', `/account/oauth/requests/${id}`, { action: 'approve', productId: t.productId, scopes: options.scopes ?? ALL_SCOPES });
  expect(res.status).toBe(200);
  const callback = new URL((await res.json()).redirectUrl);
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
  await transportFor(path, p).finishAuth(callback.searchParams);
  const client = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transportFor(path, p));
  return { client, provider: p };
}

const toolNames = async (client: Client) => listing((await client.listTools()).tools);

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

/** Puts an access and refresh token straight in the table, as an older API would have written them (no legacy_scope given). */
async function oldToken(scope: string) {
  const access = randomBytes(32).toString('base64url');
  const refresh = randomBytes(32).toString('base64url');
  const clientId = (await t.pool.query<{ id: string }>("INSERT INTO oauth_clients (client_name, redirect_uris) VALUES ('Old', $1) RETURNING id", [[REDIRECT]])).rows[0]!.id;
  await t.pool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, api_key_id, scope, resource, expires_at) VALUES
       ($1, 'access', $3, $4, $5, $6, now() + interval '1 hour'), ($2, 'refresh', $3, $4, $5, $6, now() + interval '30 days')`,
    [sha256(access), sha256(refresh), clientId, key, scope, `${BASE}/mcp`],
  );
  return { access, refresh, clientId };
}

const rpc = (bearer: string, method: string) =>
  app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  });

/** The tool names a bearer token gets from tools/list. */
async function listedWith(bearer: string) {
  const res = await rpc(bearer, 'tools/list');
  expect(res.status).toBe(200);
  const text = await res.text();
  const json = JSON.parse(text.includes('data:') ? text.split('data:').pop()! : text);
  return listing(json.result.tools);
}

const token = (body: Record<string, string>) =>
  app.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

beforeAll(async () => {
  t = await setup();
  t.deps.config.publicUrl = BASE;
  ({ key, secret } = await createApiKey(t.pool, t.productId));
  const auth = createAuth(t.pool, AUTH, [testUtils()]);
  helpers = ((await auth.$context) as unknown as { test: unknown }).test;
  t.deps.config.auth = AUTH;
  t.deps.auth = auth;
  app = createApp(t.deps);
  const user = await helpers.saveUser(helpers.createUser({ email: 'owner@agency.example', name: 'owner', emailVerified: true }));
  const { headers } = await helpers.login({ userId: user.id });
  owner = { userId: user.id, cookie: (headers as Headers).get('cookie')! };
  const invitation = await (
    await app.request(`/admin/products/${t.productId}/invitations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@agency.example', role: 'owner' }),
    })
  ).json();
  const accepted = await app.request('/api/auth/organization/accept-invitation', {
    method: 'POST',
    headers: { Cookie: owner.cookie, 'Content-Type': 'application/json', Origin: AUTH.url },
    body: JSON.stringify({ invitationId: invitation.id }),
  });
  expect(accepted.status).toBe(200);
});
afterAll(async () => {
  await t.close();
});

describe('OAuth for /mcp', () => {
  it('tells clients where to sign in, and every scope per area', async () => {
    const unauthenticated = await app.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="${ALL_SCOPES.join(' ')}", Basic realm="waas-mcp"`,
    );
    expect(ALL_SCOPES).toEqual([
      'stores:read', 'stores:write', 'backups:read', 'backups:write', 'domains:read', 'domains:write',
      'email:read', 'email:write', 'versions:read', 'versions:write', 'site:read', 'site:write',
    ]);

    const resource = await (await app.request('/.well-known/oauth-protected-resource/mcp')).json();
    expect(resource).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE], scopes_supported: ALL_SCOPES });
    const readOnly = await (await app.request('/.well-known/oauth-protected-resource/mcp/read-only')).json();
    expect(readOnly).toMatchObject({ resource: `${BASE}/mcp/read-only`, scopes_supported: READ_SCOPES });

    const server = await (await app.request('/.well-known/oauth-authorization-server')).json();
    expect(server).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      scopes_supported: ALL_SCOPES,
    });
  });

  it('connects a client that registers itself, and its token works on /mcp', async () => {
    const { client, provider: p } = await connectWithOAuth();
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect((p.saved.client as { client_id: string }).client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.saved.tokens).toMatchObject({ token_type: 'Bearer', scope: ALL_SCOPES.join(' ') });

    expect(await toolNames(client)).toEqual(toolsFor(ALL_SCOPES));
    const result = await client.callTool({ name: 'manage_versions', arguments: { action: 'list' } });
    expect(result.isError).toBeFalsy();

    // The tool call went through /v1 as this person, so it is in the request log under them.
    const { rows } = await t.pool.query("SELECT user_id, product_id FROM api_requests WHERE path = '/v1/versions' ORDER BY id DESC LIMIT 1");
    expect(rows[0]).toMatchObject({ user_id: owner.userId, product_id: t.productId });
    await client.close();
  });

  it('connects a client identified by a Client ID Metadata Document', async () => {
    const documentUrl = 'https://agent.example.com/oauth/client.json';
    t.deps.clientMetadataFetch = (async (input: string | URL | Request) => {
      expect(String(input)).toBe(documentUrl);
      return Response.json({ client_id: documentUrl, client_name: 'Metadata Agent', redirect_uris: [REDIRECT] });
    }) as typeof fetch;
    const { client, provider: p } = await connectWithOAuth('/mcp', { clientMetadataUrl: documentUrl });
    expect(p.saved.authorizationUrl!.searchParams.get('client_id')).toBe(documentUrl);
    expect(await toolNames(client)).toEqual(toolsFor(ALL_SCOPES));
    await client.close();
  });

  it('offers only the tools of the areas ticked, and a write box brings its read box', async () => {
    const { client, provider: p } = await connectWithOAuth('/mcp', { scopes: ['stores:read', 'backups:write'] });
    expect(p.saved.tokens).toMatchObject({ scope: 'stores:read backups:read backups:write' });
    const names = await toolNames(client);
    expect(names).toEqual(toolsFor(['stores:read', 'backups:read', 'backups:write']));
    expect(names).toContain('manage_backups.restore');
    expect(names).toContain('get_stores.list');
    expect(names).not.toContain('create_store');
    expect(names).not.toContain('manage_domain.list');
    expect(names).not.toContain('get_site');
    // A tool outside the grant isn't there to call.
    const refused = await client.callTool({ name: 'store_status', arguments: { action: 'delete', externalId: 'x' } }).catch((error: Error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }));
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/store_status/);
    // The instructions say what the connection may not do.
    expect(client.getInstructions()).toContain('not allowed to change stores, see or change domains');
    await client.close();
  });

  it('gives each tool and action to exactly one scope', async () => {
    const seen: string[] = [];
    for (const scope of ALL_SCOPES) {
      const { access } = await oldToken('placeholder');
      await t.pool.query('UPDATE oauth_tokens SET scope = $1, legacy_scope = false WHERE token_hash = $2', [scope, sha256(access)]);
      const listed = await listedWith(access);
      expect(listed).toEqual(toolsFor([scope]));
      seen.push(...listed);
    }
    expect(seen.sort()).toEqual(toolsFor(ALL_SCOPES));
  });

  it('refuses an action whose scope was not granted, even on a tool it offers', async () => {
    const { access } = await oldToken('placeholder');
    await t.pool.query('UPDATE oauth_tokens SET scope = $1, legacy_scope = false WHERE token_hash = $2', ['backups:read domains:read', sha256(access)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const text = await res.text();
      return JSON.parse(text.includes('data:') ? text.split('data:').pop()! : text) as { result?: { isError?: boolean; content: { text: string }[] }; error?: unknown };
    };
    // The read action works...
    expect((await call('manage_domain', { action: 'check', domainName: 'free.oauth-example.com' })).result?.isError).toBeFalsy();
    // ...and the write actions of the same tools are refused.
    for (const [name, args] of [
      ['manage_backups', { action: 'create', externalId: 'x' }],
      ['manage_backups', { action: 'restore', externalId: 'x' }],
      ['manage_domain', { action: 'remove', externalId: 'x', domainName: 'a.example.com' }],
    ] as const) {
      const answer = await call(name, args);
      expect(answer.error ?? answer.result?.isError, `${name} ${args.action}`).toBeTruthy();
    }
  });

  it('signs in to /mcp/read-only with a read-only token that /mcp refuses', async () => {
    const { client, provider: p } = await connectWithOAuth('/mcp/read-only');
    expect(p.saved.tokens).toMatchObject({ scope: READ_SCOPES.join(' ') });
    expect(await toolNames(client)).toEqual(toolsFor(READ_SCOPES));
    await client.close();

    // A token is for one resource (RFC 8707).
    const bearer = (p.saved.tokens as { access_token: string }).access_token;
    const elsewhere = await app.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(elsewhere.status).toBe(401);
  });

  it('ticks the read boxes, and the write boxes the app asked for', async () => {
    // Clients ask for what the 401 offers (every scope); this one asks for less.
    const asked = provider();
    await new Client({ name: 'agent', version: '1' }).connect(transportFor('/mcp', asked)).catch(() => {});
    expect(asked.saved.authorizationUrl!.searchParams.get('scope')).toBe(ALL_SCOPES.join(' '));
    asked.saved.authorizationUrl!.searchParams.set('scope', 'stores:read domains:write');
    const id = await startSignIn(asked.saved.authorizationUrl!);
    const view = await (await asUser(owner.cookie, 'GET', `/account/oauth/requests/${id}`)).json();
    expect(view).toMatchObject({ wantsWrite: true, readOnly: false, asAdmin: false, requestedScopes: ['stores:read', 'domains:write'] });
    const ticks = Object.fromEntries(view.areas.map((a: { area: string; read: { ticked: boolean }; write: { ticked: boolean } }) => [a.area, [a.read.ticked, a.write.ticked]]));
    expect(ticks).toEqual({ stores: [true, false], backups: [true, false], domains: [true, true], email: [true, false], versions: [true, false], site: [true, false] });
    expect(view.areas[0]).toMatchObject({ name: 'Stores', read: { scope: 'stores:read' }, write: { scope: 'stores:write' } });

    // Nothing ticked, or a scope we don't have, is refused, and the request is still there.
    expect((await asUser(owner.cookie, 'POST', `/account/oauth/requests/${id}`, { action: 'approve', productId: t.productId, scopes: [] })).status).toBe(400);
    expect((await asUser(owner.cookie, 'POST', `/account/oauth/requests/${id}`, { action: 'approve', productId: t.productId, scopes: ['everything'] })).status).toBe(400);
    expect((await asUser(owner.cookie, 'GET', `/account/oauth/requests/${id}`)).status).toBe(200);

    // A client that asks for nothing: the person decides; no write box starts ticked.
    const none = provider();
    await new Client({ name: 'agent', version: '1' }).connect(transportFor('/mcp', none)).catch(() => {});
    none.saved.authorizationUrl!.searchParams.delete('scope');
    const noneId = await startSignIn(none.saved.authorizationUrl!);
    const noneView = await (await asUser(owner.cookie, 'GET', `/account/oauth/requests/${noneId}`)).json();
    expect(noneView.wantsWrite).toBe(false);
    expect(noneView.areas.every((a: { read: { ticked: boolean }; write: { ticked: boolean } }) => a.read.ticked && !a.write.ticked)).toBe(true);
  });

  it('only signs in: no API key and secret on the approve page', async () => {
    const p = provider();
    await new Client({ name: 'agent', version: '1' }).connect(transportFor('/mcp', p)).catch(() => {});
    const url = p.saved.authorizationUrl!;
    const html = await (await app.request(`${url.pathname}${url.search}`)).text();
    expect(html).toContain('Connect Test Agent');
    expect(html).toContain('Sign in to AnyPress');
    expect(html).not.toContain('api_secret');
    expect(html).not.toContain('API key');
    expect(html).not.toContain('WPCS');

    // Approving with a key and secret is no longer taken, even when they are right.
    const withKey = await postForm({ ...hiddenFields(html), action: 'approve', api_key: key, api_secret: secret });
    expect(withKey.status).toBe(400);
    expect(withKey.headers.get('Location')).toBeNull();
    expect(await withKey.text()).toContain('no longer offered');

    const cancelled = await postForm({ ...hiddenFields(html), action: 'deny' });
    const back = new URL(cancelled.headers.get('Location')!);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe(url.searchParams.get('state'));

    // A redirect URI the client never registered is refused on our page, never redirected to.
    const elsewhere = new URL(url);
    elsewhere.searchParams.set('redirect_uri', 'https://evil.example/steal');
    const refused = await app.request(`${elsewhere.pathname}${elsewhere.search}`);
    expect(refused.status).toBe(400);
    expect(refused.headers.get('Location')).toBeNull();
    expect(refused.headers.get('X-Frame-Options')).toBe('DENY');

    // PKCE is required, and scopes must be ours.
    const noPkce = new URL(url);
    noPkce.searchParams.delete('code_challenge');
    expect(new URL((await app.request(`${noPkce.pathname}${noPkce.search}`)).headers.get('Location')!).searchParams.get('error')).toBe('invalid_request');
    const badScope = new URL(url);
    badScope.searchParams.set('scope', 'stores:read admin');
    expect(new URL((await app.request(`${badScope.pathname}${badScope.search}`)).headers.get('Location')!).searchParams.get('error')).toBe('invalid_scope');
  });

  it('refuses script redirect URIs at registration', async () => {
    const response = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }),
    });
    expect(response.status).toBe(400);
    const plainHttp = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://example.com/callback'] }),
    });
    expect(plainHttp.status).toBe(400);
  });

  it('uses each code once, rotates refresh tokens, narrows on request, and revokes', async () => {
    const { client, provider: p } = await connectWithOAuth();
    await client.close();
    const clientId = (p.saved.client as { client_id: string }).client_id;
    const { refresh_token: refresh, access_token: access } = p.saved.tokens as { refresh_token: string; access_token: string };

    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: ALL_SCOPES.join(' ') });
    expect(next.refresh_token).not.toBe(refresh);

    // The old refresh token is spent.
    const again = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });

    // Narrowing keeps only what is asked for; widening is refused.
    const narrowed = await (await token({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: clientId, scope: 'stores:read' })).json();
    expect(narrowed.scope).toBe('stores:read');
    expect(await listedWith(narrowed.access_token)).toEqual(toolsFor(['stores:read']));
    const wider = await token({ grant_type: 'refresh_token', refresh_token: narrowed.refresh_token, client_id: clientId, scope: 'stores:read stores:write' });
    expect(await wider.json()).toMatchObject({ error: 'invalid_scope' });

    // Revoking the access token (RFC 7009) cuts the client off.
    expect((await rpc(next.access_token, 'ping')).status).not.toBe(401);
    const revoked = await app.request('/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${access}` });
    expect(revoked.status).toBe(200);
    expect((await rpc(access, 'ping')).status).toBe(401);
  });

  it('keeps grants from before scopes per area working as they did', async () => {
    // stores:read used to mean seeing everything.
    const reader = await oldToken('stores:read');
    expect(await listedWith(reader.access)).toEqual(toolsFor(READ_SCOPES));

    // stores:write used to mean changing everything.
    const writer = await oldToken('stores:read stores:write');
    expect(await listedWith(writer.access)).toEqual(toolsFor(ALL_SCOPES));

    // A refresh keeps the old names and what they meant, even when the client sends its old scope back.
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: writer.refresh, client_id: writer.clientId, scope: 'stores:read stores:write' });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next.scope).toBe('stores:read stores:write');
    expect(await listedWith(next.access_token)).toEqual(toolsFor(ALL_SCOPES));
    const again = await (await token({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: writer.clientId })).json();
    expect(await listedWith(again.access_token)).toEqual(toolsFor(ALL_SCOPES));
    const { rows } = await t.pool.query('SELECT legacy_scope FROM oauth_tokens WHERE token_hash = $1', [sha256(again.refresh_token)]);
    expect(rows[0]).toEqual({ legacy_scope: true });

    // Tokens an API key approved stop when the key is revoked.
    await t.pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [key]);
    expect((await rpc(again.access_token, 'ping')).status).toBe(401);
    await t.pool.query('UPDATE api_keys SET revoked_at = NULL WHERE id = $1', [key]);
  });

  it('still takes Basic auth, with every tool', async () => {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: basic(key, secret), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    });
    expect(response.status).toBe(200);
    // AI apps show the AnyPress logo for the connector.
    const init = await response.text();
    const { serverInfo } = JSON.parse(init.includes('data:') ? init.split('data:').pop()! : init).result;
    expect(serverInfo).toMatchObject({ title: 'AnyPress', icons: [{ src: `${BASE}/icon.png`, mimeType: 'image/png' }, { src: `${BASE}/icon.svg` }] });
    const icon = await app.request('/favicon.ico');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await icon.arrayBuffer()).slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    const listed = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: basic(key, secret), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const text = await listed.text();
    const json = JSON.parse(text.includes('data:') ? text.split('data:').pop()! : text);
    expect(listing(json.result.tools)).toEqual(toolsFor(ALL_SCOPES));
  });
});

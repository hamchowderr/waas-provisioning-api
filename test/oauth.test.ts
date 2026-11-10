// OAuth sign-in for /mcp (src/oauth.ts, src/oauthserver.ts), driven by the MCP client SDK the way
// Claude or ChatGPT connect: discovery, registration (dynamic, or a Client ID Metadata Document),
// Better Auth's MCP plugin sending the browser to the dashboard's Connect page, ticking scopes per
// area, the token exchange, and then tool calls with the token. Also: grants from before the plugin
// (and from before scopes per area) keep what they had.
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { testUtils } from 'better-auth/plugins';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_SCOPES, READ_SCOPES } from '../mcp/src/scopes.ts';
import { createApp } from '../src/app.ts';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { createApiKey } from '../src/keys.ts';
import { basic, setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

const BASE = 'https://api.example.test';
const REDIRECT = 'http://localhost:3999/callback';
const AUTH: AuthConfig = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789', brand: 'AnyPress', apiUrl: BASE };
const AUTHORIZE = `${AUTH.url}/api/auth/oauth2/authorize`;

type Access = 'read' | 'write';
/**
 * Every tool, its area, and the access each of its actions needs (mcp/src/server.ts). A tool
 * without actions needs one access. Listings are compared as `tool` or `tool.action`, so each
 * action's scope is checked, not just the tool's.
 */
const TOOLS: Record<string, { area: string; access?: Access; actions?: Record<string, Access> }> = {
  show_stores: { area: 'stores', access: 'read' },
  show_store: { area: 'stores', access: 'read' },
  get_stores: { area: 'stores', actions: { list: 'read', get: 'read', wait: 'read', move_in: 'read' } },
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
  manage_webhooks: { area: 'webhooks', actions: { list: 'read', get: 'read', deliveries: 'read', create: 'write', update: 'write', test: 'write', retry: 'write', rotate_secret: 'write', delete: 'write' } },
  get_site: { area: 'site', access: 'read' },
  site_pages: { area: 'site', actions: { list: 'read', read: 'read', revisions: 'read', create: 'write', update: 'write', translate: 'write', restore_revision: 'write' } },
  page_section: { area: 'site', actions: { add: 'write', replace: 'write', remove: 'write' } },
  site_patterns: { area: 'site', actions: { categories: 'read', blocks: 'read', find: 'read', get: 'read', preview: 'read' } },
  show_looks: { area: 'site', access: 'read' },
  site_styles: { area: 'site', actions: { get: 'read', update: 'write', variations: 'read', apply: 'write' } },
  header_footer: { area: 'site', actions: { get: 'read', update: 'write' } },
  site_menus: { area: 'site', actions: { list: 'read', update: 'write' } },
  add_image: { area: 'site', access: 'write' },
  site_languages: { area: 'site', actions: { read: 'read', on: 'write', off: 'write' } },
  business_profile: { area: 'site', actions: { read: 'read', save: 'write', undo: 'write' } },
  support: { area: 'stores', actions: { list: 'read', show: 'read', open: 'write', reply: 'write', close: 'write' } },
  read_reference: { area: 'site', actions: { start: 'write', wait: 'read', get: 'read', usage: 'read', check: 'read', add_products: 'write' } },
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
let helpers: any;
let owner: { userId: string; cookie: string };
/** Answers Client ID Metadata Document fetches; a test sets it. */
let metadataFetch: (input: RequestInfo | URL) => Promise<Response> = async () => new Response(null, { status: 404 });

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
function provider(options: { clientMetadataUrl?: string } = {}) {
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

/** The dashboard's server, calling /account with the person's session. */
const asUser = (cookie: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { Cookie: cookie, 'X-Session-Auth': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** The app's authorization request, followed by the owner's browser to the dashboard's Connect page; answers the plugin's signed request. */
async function toConnectPage(authorizationUrl: URL) {
  expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(AUTHORIZE);
  const response = await app.request(`${authorizationUrl.pathname}${authorizationUrl.search}`, { headers: { Cookie: owner.cookie } });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('Location')!, AUTH.url);
  expect(`${location.origin}${location.pathname}`).toBe(`${AUTH.url}/connect`);
  return location.search.slice(1);
}

const connectPath = (oauthQuery: string) => `/account/oauth/connect?${new URLSearchParams({ oauth_query: oauthQuery })}`;

/** Starts connecting to `path` and stops at the Connect page. */
async function startSignIn(path = '/mcp', options: { clientMetadataUrl?: string } = {}) {
  const p = provider(options);
  await expect(new Client({ name: 'agent', version: '1' }).connect(transportFor(path, p))).rejects.toBeInstanceOf(UnauthorizedError);
  expect(p.saved.authorizationUrl).toBeDefined();
  return { p, oauthQuery: await toConnectPage(p.saved.authorizationUrl!) };
}

/** The whole connect flow, ticking `scopes` on the dashboard; returns a connected client and the provider holding its tokens. */
async function connectWithOAuth(path = '/mcp', options: { clientMetadataUrl?: string; scopes?: readonly string[] } = {}) {
  const { p, oauthQuery } = await startSignIn(path, options);
  const res = await asUser(owner.cookie, 'POST', '/account/oauth/connect', { oauth_query: oauthQuery, action: 'approve', productId: t.productId, scopes: options.scopes ?? ALL_SCOPES });
  expect(res.status).toBe(200);
  const callback = new URL((await res.json()).redirectUrl);
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
  await transportFor(path, p).finishAuth(callback.searchParams);
  const client = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transportFor(path, p));
  return { client, provider: p };
}

/** The scopes a token response gave, without the refresh token's offline_access. */
const scopesOf = (tokens: unknown) => (tokens as { scope: string }).scope.split(' ').filter((s) => s !== 'offline_access').join(' ');

const toolNames = async (client: Client) => listing((await client.listTools()).tools);

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

/** Puts an access and refresh token straight in the table, as the API wrote them before the plugin (no legacy_scope given). */
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
  const auth = createAuth(t.pool, AUTH, [testUtils()], { clientMetadataFetch: (input) => metadataFetch(input) });
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
      'email:read', 'email:write', 'versions:read', 'versions:write', 'webhooks:read', 'webhooks:write', 'site:read', 'site:write',
    ]);

    const resource = await (await app.request('/.well-known/oauth-protected-resource/mcp')).json();
    expect(resource).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE], scopes_supported: ALL_SCOPES });
    const readOnly = await (await app.request('/.well-known/oauth-protected-resource/mcp/read-only')).json();
    expect(readOnly).toMatchObject({ resource: `${BASE}/mcp/read-only`, scopes_supported: READ_SCOPES });

    // The plugin's own metadata: the API is the issuer, the endpoints are on the dashboard (which passes them on).
    const server = await (await app.request('/.well-known/oauth-authorization-server')).json();
    expect(server).toMatchObject({
      issuer: BASE,
      authorization_endpoint: AUTHORIZE,
      token_endpoint: `${AUTH.url}/api/auth/oauth2/token`,
      registration_endpoint: `${AUTH.url}/api/auth/oauth2/register`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      scopes_supported: ALL_SCOPES,
    });
  });

  it('connects a client that registers itself, and its token works on /mcp', async () => {
    const { client, provider: p } = await connectWithOAuth();
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(p.saved.tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, refresh_token: expect.any(String) });
    expect(scopesOf(p.saved.tokens)).toBe(ALL_SCOPES.join(' '));

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
    metadataFetch = async (input) => {
      expect(String(input instanceof Request ? input.url : input)).toBe(documentUrl);
      return Response.json({ client_id: documentUrl, client_name: 'Metadata Agent', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    };
    const { client, provider: p } = await connectWithOAuth('/mcp', { clientMetadataUrl: documentUrl });
    expect(p.saved.authorizationUrl!.searchParams.get('client_id')).toBe(documentUrl);
    expect(await toolNames(client)).toEqual(toolsFor(ALL_SCOPES));
    await client.close();
  });

  it('offers only the tools of the areas ticked, and a write box brings its read box', async () => {
    const { client, provider: p } = await connectWithOAuth('/mcp', { scopes: ['stores:read', 'backups:write'] });
    expect(scopesOf(p.saved.tokens).split(' ').sort()).toEqual(['backups:read', 'backups:write', 'stores:read']);
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
    expect(scopesOf(p.saved.tokens)).toBe(READ_SCOPES.join(' '));
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
    const oauthQuery = await toConnectPage(asked.saved.authorizationUrl!);
    const view = await (await asUser(owner.cookie, 'GET', connectPath(oauthQuery))).json();
    expect(view).toMatchObject({ clientName: 'Test Agent', wantsWrite: true, readOnly: false, asAdmin: false, requestedScopes: ['stores:read', 'domains:write'] });
    const ticks = Object.fromEntries(view.areas.map((a: { area: string; read: { ticked: boolean }; write: { ticked: boolean } | null }) => [a.area, [a.read.ticked, a.write?.ticked ?? null]]));
    // An area the app only asked to see has no box to change.
    expect(ticks).toEqual({ stores: [true, null], domains: [true, true] });
    expect(view.areas[1]).toMatchObject({ name: 'Domains', read: { scope: 'domains:read' }, write: { scope: 'domains:write' } });

    // Nothing ticked, or a scope we don't have, is refused, and the request is still there.
    const approve = (scopes: unknown) => asUser(owner.cookie, 'POST', '/account/oauth/connect', { oauth_query: oauthQuery, action: 'approve', productId: t.productId, scopes });
    expect((await approve([])).status).toBe(400);
    expect((await approve(['everything'])).status).toBe(400);
    expect((await asUser(owner.cookie, 'GET', connectPath(oauthQuery))).status).toBe(200);
    // Only what the app asked for is given, whatever else is ticked.
    const res = await approve(ALL_SCOPES);
    expect(res.status).toBe(200);
    const callback = new URL((await res.json()).redirectUrl);
    await transportFor('/mcp', asked).finishAuth(callback.searchParams);
    expect(scopesOf(asked.saved.tokens).split(' ').sort()).toEqual(['domains:write', 'stores:read']);
  });

  it('refuses requests the plugin did not sign, unknown redirects, no PKCE and scopes it does not have', async () => {
    const { p, oauthQuery } = await startSignIn();
    // The Connect page only answers for the plugin's signed request.
    expect((await asUser(owner.cookie, 'GET', connectPath(oauthQuery.replace('scope=', 'scope=webhooks%3Awrite+')))).status).toBe(404);
    const url = p.saved.authorizationUrl!;
    const follow = async (changed: URL) => {
      const res = await app.request(`${changed.pathname}${changed.search}`, { headers: { Cookie: owner.cookie } });
      return { status: res.status, location: res.headers.get('Location') ?? '' };
    };
    // A redirect URI the client never registered is never redirected to.
    const elsewhere = new URL(url);
    elsewhere.searchParams.set('redirect_uri', 'https://evil.example/steal');
    expect((await follow(elsewhere)).location).not.toContain('evil.example');
    // PKCE is required, and scopes must be ours.
    const noPkce = new URL(url);
    noPkce.searchParams.delete('code_challenge');
    expect((await follow(noPkce)).location).not.toContain('/connect?');
    const badScope = new URL(url);
    badScope.searchParams.set('scope', 'stores:read admin');
    expect(new URL((await follow(badScope)).location, AUTH.url).searchParams.get('error')).toBe('invalid_scope');
  });

  it('declines with access_denied and the app’s state', async () => {
    const { p, oauthQuery } = await startSignIn();
    const res = await asUser(owner.cookie, 'POST', '/account/oauth/connect', { oauth_query: oauthQuery, action: 'deny' });
    const back = new URL((await res.json()).redirectUrl);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe(p.saved.authorizationUrl!.searchParams.get('state'));
  });

  it('refuses script redirect URIs at registration', async () => {
    const response = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'], token_endpoint_auth_method: 'none' }),
    });
    expect(response.status).toBe(400);
  });

  it('uses each code once, rotates refresh tokens, narrows on request, and revokes', async () => {
    const { client, provider: p } = await connectWithOAuth();
    await client.close();
    const clientId = (p.saved.client as { client_id: string }).client_id;
    const { refresh_token: refresh } = p.saved.tokens as { refresh_token: string; access_token: string };

    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(scopesOf(next)).toBe(ALL_SCOPES.join(' '));
    expect(next.refresh_token).not.toBe(refresh);

    // The old refresh token is spent. For 30 seconds the same request (an app retrying) gets the same
    // answer back, as the MCP plugin does for every MCP app; anything else with it is refused.
    const retried = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(retried.status).toBe(200);
    expect((await retried.json()).refresh_token).toBe(next.refresh_token);
    const again = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, scope: 'stores:read offline_access' });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });

    // Narrowing keeps only what is asked for; widening is refused.
    const narrowed = await (await token({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: clientId, scope: 'stores:read offline_access' })).json();
    expect(scopesOf(narrowed)).toBe('stores:read');
    expect(await listedWith(narrowed.access_token)).toEqual(toolsFor(['stores:read']));
    const wider = await token({ grant_type: 'refresh_token', refresh_token: narrowed.refresh_token, client_id: clientId, scope: 'stores:read stores:write offline_access' });
    expect(wider.status).toBe(400);

    // Revoking the refresh token (RFC 7009) ends the connection: no more tokens.
    const fresh = await (await token({ grant_type: 'refresh_token', refresh_token: narrowed.refresh_token, client_id: clientId })).json();
    expect(fresh.refresh_token).toBeTruthy();
    const revoked = await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: fresh.refresh_token, token_type_hint: 'refresh_token', client_id: clientId }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect((await token({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: clientId })).status).toBe(400);
  });

  it('takes tokens an app binds to its own key (DPoP) only with a fresh proof from that key', async () => {
    const { client, provider: p } = await connectWithOAuth();
    await client.close();
    const clientId = (p.saved.client as { client_id: string }).client_id;
    const { refresh_token: refresh } = p.saved.tokens as { refresh_token: string };
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    const proof = (method: string, htu: string, accessToken?: string) =>
      new SignJWT({ htm: method, htu, jti: randomBytes(16).toString('hex'), ...(accessToken ? { ath: createHash('sha256').update(accessToken).digest('base64url') } : {}) })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
        .setIssuedAt()
        .sign(privateKey);

    // The app gets a bound token from the plugin's token endpoint (where the metadata points).
    const tokenUrl = `${AUTH.url}/api/auth/oauth2/token`;
    const res = await app.request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: await proof('POST', tokenUrl) },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }).toString(),
    });
    expect(res.status).toBe(200);
    const bound = await res.json();
    expect(bound.token_type).toBe('DPoP');
    const claims = JSON.parse(Buffer.from(bound.access_token.split('.')[1], 'base64url').toString());
    expect(claims.cnf).toEqual({ jkt: await calculateJwkThumbprint(jwk) });

    const call = async (authorization: string, dpop?: string) =>
      app.request('/mcp', {
        method: 'POST',
        headers: { Authorization: authorization, ...(dpop ? { DPoP: dpop } : {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
    const ok = await call(`DPoP ${bound.access_token}`, await proof('POST', `${BASE}/mcp`, bound.access_token));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('show_stores');

    // Refused: as a plain Bearer token, without a proof, a proof used twice, and a proof for another address.
    expect((await call(`Bearer ${bound.access_token}`)).status).toBe(401);
    expect((await call(`DPoP ${bound.access_token}`)).status).toBe(401);
    const once = await proof('POST', `${BASE}/mcp`, bound.access_token);
    expect((await call(`DPoP ${bound.access_token}`, once)).status).toBe(200);
    expect((await call(`DPoP ${bound.access_token}`, once)).status).toBe(401);
    expect((await call(`DPoP ${bound.access_token}`, await proof('POST', `${BASE}/mcp/site`, bound.access_token))).status).toBe(401);
    // And an unbound token can't claim the DPoP scheme.
    const plain = (p.saved.tokens as { access_token: string }).access_token;
    expect((await call(`DPoP ${plain}`, await proof('POST', `${BASE}/mcp`, plain))).status).toBe(401);
  });

  it('signs in again an app registered before the plugin, with the client id it already has', async () => {
    const { rows } = await t.pool.query<{ id: string }>("INSERT INTO oauth_clients (client_name, redirect_uris) VALUES ('Claude', $1) RETURNING id", [[REDIRECT]]);
    // The migration's copy of the apps registered before it (migrations/1765900000000_oauth-better-auth.sql).
    const migration = readFileSync(new URL('../migrations/1765900000000_oauth-better-auth.sql', import.meta.url), 'utf8');
    const copy = /INSERT INTO auth\."oauthClient"[\s\S]*?DO NOTHING;/.exec(migration)![0];
    await t.pool.query(copy);
    const p = provider();
    p.saved.client = { client_id: rows[0]!.id, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' };
    await expect(new Client({ name: 'agent', version: '1' }).connect(transportFor('/mcp', p))).rejects.toBeInstanceOf(UnauthorizedError);
    const oauthQuery = await toConnectPage(p.saved.authorizationUrl!);
    expect((await (await asUser(owner.cookie, 'GET', connectPath(oauthQuery))).json()).clientName).toBe('Claude');
    const res = await asUser(owner.cookie, 'POST', '/account/oauth/connect', { oauth_query: oauthQuery, action: 'approve', productId: t.productId, scopes: ['stores:read'] });
    await transportFor('/mcp', p).finishAuth(new URL((await res.json()).redirectUrl).searchParams);
    expect(scopesOf(p.saved.tokens)).toBe('stores:read');
    expect(await listedWith((p.saved.tokens as { access_token: string }).access_token)).toEqual(toolsFor(['stores:read']));
  });

  it('keeps tokens from before the plugin working, with what they meant', async () => {
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

    // Revoking one (RFC 7009) cuts it off.
    const revoked = await app.request('/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${reader.access}` });
    expect(revoked.status).toBe(200);
    expect((await rpc(reader.access, 'ping')).status).toBe(401);

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

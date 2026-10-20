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

/** Every tool and the scope it needs (mcp/src/server.ts). */
const TOOL_SCOPES: Record<string, string> = {
  show_stores: 'stores:read',
  list_stores: 'stores:read',
  get_store: 'stores:read',
  wait_for_store: 'stores:read',
  create_store: 'stores:write',
  update_store_options: 'stores:write',
  suspend_store: 'stores:write',
  resume_store: 'stores:write',
  delete_store: 'stores:write',
  move_store_to_version: 'stores:write',
  list_store_backups: 'backups:read',
  create_store_backup: 'backups:write',
  restore_store: 'backups:write',
  list_store_domains: 'domains:read',
  check_domain_availability: 'domains:read',
  get_domain_connect_link: 'domains:read',
  add_store_domain: 'domains:write',
  set_store_main_domain: 'domains:write',
  remove_store_domain: 'domains:write',
  get_store_mail_domain: 'email:read',
  set_store_mail_domain: 'email:write',
  remove_store_mail_domain: 'email:write',
  list_versions: 'versions:read',
  list_snapshots: 'versions:read',
  list_templates: 'versions:read',
  create_version: 'versions:write',
  set_production_version: 'versions:write',
  delete_version: 'versions:write',
  get_site: 'site:read',
  list_pages: 'site:read',
  read_page: 'site:read',
  list_page_revisions: 'site:read',
  find_patterns: 'site:read',
  get_pattern: 'site:read',
  get_site_styles: 'site:read',
  get_header_footer: 'site:read',
  list_menus: 'site:read',
  create_page: 'site:write',
  update_page: 'site:write',
  add_section: 'site:write',
  replace_section: 'site:write',
  remove_section: 'site:write',
  restore_page_revision: 'site:write',
  update_site_styles: 'site:write',
  update_header_footer: 'site:write',
  update_menu: 'site:write',
  add_image: 'site:write',
};
const toolsFor = (scopes: readonly string[]) =>
  Object.entries(TOOL_SCOPES)
    .filter(([, scope]) => scopes.includes(scope))
    .map(([name]) => name)
    .sort();

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

const toolNames = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).sort();

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
  return (json.result.tools as { name: string }[]).map((tool) => tool.name).sort();
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
    const result = await client.callTool({ name: 'list_versions', arguments: {} });
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
    expect((await client.listTools()).tools.length).toBeGreaterThan(20);
    await client.close();
  });

  it('offers only the tools of the areas ticked, and a write box brings its read box', async () => {
    const { client, provider: p } = await connectWithOAuth('/mcp', { scopes: ['stores:read', 'backups:write'] });
    expect(p.saved.tokens).toMatchObject({ scope: 'stores:read backups:read backups:write' });
    const names = await toolNames(client);
    expect(names).toEqual(toolsFor(['stores:read', 'backups:read', 'backups:write']));
    expect(names).toContain('restore_store');
    expect(names).not.toContain('create_store');
    expect(names).not.toContain('list_store_domains');
    expect(names).not.toContain('get_site');
    // A tool outside the grant isn't there to call.
    const refused = await client.callTool({ name: 'delete_store', arguments: { externalId: 'x' } }).catch((error: Error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }));
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/delete_store/);
    // The instructions say what the connection may not do.
    expect(client.getInstructions()).toContain('not allowed to change stores, see or change domains');
    await client.close();
  });

  it('gives each tool to exactly one area', async () => {
    for (const scope of ALL_SCOPES) {
      const { access } = await oldToken('placeholder');
      await t.pool.query('UPDATE oauth_tokens SET scope = $1, legacy_scope = false WHERE token_hash = $2', [scope, sha256(access)]);
      expect(await listedWith(access)).toEqual(toolsFor([scope]));
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
    const listed = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: basic(key, secret), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const text = await listed.text();
    const json = JSON.parse(text.includes('data:') ? text.split('data:').pop()! : text);
    expect(json.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(toolsFor(ALL_SCOPES));
  });
});

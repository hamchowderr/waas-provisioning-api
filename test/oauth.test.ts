// OAuth sign-in for /mcp (src/oauth.ts), driven by the MCP client SDK the way Claude or ChatGPT
// connect: discovery, registration (dynamic, or a Client ID Metadata Document), the approve page
// signed in with an API key and secret, the token exchange, and then tool calls with the token.
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../src/keys.ts';
import { basic, setup, type TestContext } from './helpers.ts';

const BASE = 'https://api.example.test';
const REDIRECT = 'http://localhost:3999/callback';

let t: TestContext;
let key: string;
let secret: string;

/** Hands the request to the app in-process, keeping redirects visible as they are to a browser. */
const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(request.url);
  return t.app.request(`${url.pathname}${url.search}`, {
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
      ...(options.scope ? { scope: options.scope } : {}),
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

/** What the person does on the approve page: sign in and approve (or cancel). Returns where the browser goes next. */
async function approve(authorizationUrl: URL, form: Record<string, string>) {
  const page = await t.app.request(`${authorizationUrl.pathname}${authorizationUrl.search}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, decode(m[2]!)]));
  const response = await t.app.request('/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...hidden, ...form }).toString(),
  });
  return { response, html };
}

const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The whole connect flow; returns a connected client and the provider holding its tokens. */
async function connectWithOAuth(path = '/mcp', options: { clientMetadataUrl?: string; allowWrite?: boolean } = {}) {
  const p = provider(options);
  await expect(new Client({ name: 'agent', version: '1' }).connect(transportFor(path, p))).rejects.toBeInstanceOf(UnauthorizedError);
  expect(p.saved.authorizationUrl).toBeDefined();
  const form: Record<string, string> = { api_key: key, api_secret: secret, action: 'approve' };
  if (options.allowWrite !== false) form.allow_write = 'on';
  const { response } = await approve(p.saved.authorizationUrl!, form);
  expect(response.status).toBe(302);
  const callback = new URL(response.headers.get('Location')!);
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
  const transport = transportFor(path, p);
  await transport.finishAuth(callback.searchParams);
  const client = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transportFor(path, p));
  return { client, provider: p };
}

beforeAll(async () => {
  t = await setup();
  t.deps.config.publicUrl = BASE;
  ({ key, secret } = await createApiKey(t.pool, t.productId));
});
afterAll(async () => {
  await t.close();
});

describe('OAuth for /mcp', () => {
  it('tells clients where to sign in', async () => {
    const unauthenticated = await t.app.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="stores:read stores:write", Basic realm="waas-mcp"`,
    );

    const resource = await (await t.app.request('/.well-known/oauth-protected-resource/mcp')).json();
    expect(resource).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE], scopes_supported: ['stores:read', 'stores:write'] });
    const readOnly = await (await t.app.request('/.well-known/oauth-protected-resource/mcp/read-only')).json();
    expect(readOnly).toMatchObject({ resource: `${BASE}/mcp/read-only`, scopes_supported: ['stores:read'] });

    const server = await (await t.app.request('/.well-known/oauth-authorization-server')).json();
    expect(server).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });

  it('connects a client that registers itself, and its token works on /mcp', async () => {
    const { client, provider: p } = await connectWithOAuth();
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect((p.saved.client as { client_id: string }).client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.saved.tokens).toMatchObject({ token_type: 'Bearer', scope: 'stores:read stores:write' });

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('create_store');
    const result = await client.callTool({ name: 'list_versions', arguments: {} });
    expect(result.isError).toBeFalsy();

    // The tool call went through /v1 as this API key, so it is in the request log under it.
    const { rows } = await t.pool.query("SELECT api_key_id, product_id FROM api_requests WHERE path = '/v1/versions' ORDER BY id DESC LIMIT 1");
    expect(rows[0]).toMatchObject({ api_key_id: key, product_id: t.productId });
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

  it('gives only the read tools when the box for changes is left unticked', async () => {
    const { client, provider: p } = await connectWithOAuth('/mcp', { allowWrite: false });
    expect(p.saved.tokens).toMatchObject({ scope: 'stores:read' });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_stores');
    expect(names).not.toContain('delete_store');
    await client.close();
  });

  it('signs in to /mcp/read-only with a read-only token that /mcp refuses', async () => {
    const { client, provider: p } = await connectWithOAuth('/mcp/read-only');
    expect(p.saved.tokens).toMatchObject({ scope: 'stores:read' });
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('create_store');
    await client.close();

    // A token is for one resource (RFC 8707).
    const token = (p.saved.tokens as { access_token: string }).access_token;
    const elsewhere = await t.app.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(elsewhere.status).toBe(401);
  });

  it('keeps the approve page honest', async () => {
    const p = provider();
    await new Client({ name: 'agent', version: '1' }).connect(transportFor('/mcp', p)).catch(() => {});
    const url = p.saved.authorizationUrl!;

    const wrong = await approve(url, { api_key: key, api_secret: 'wrong', action: 'approve' });
    expect(wrong.html).toContain('Connect Test Agent');
    expect(wrong.response.status).toBe(401);
    expect(await wrong.response.text()).toContain('did not match');

    const cancelled = await approve(url, { action: 'deny' });
    const back = new URL(cancelled.response.headers.get('Location')!);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe(url.searchParams.get('state'));

    // A redirect URI the client never registered is refused on our page, never redirected to.
    const elsewhere = new URL(url);
    elsewhere.searchParams.set('redirect_uri', 'https://evil.example/steal');
    const refused = await t.app.request(`${elsewhere.pathname}${elsewhere.search}`);
    expect(refused.status).toBe(400);
    expect(refused.headers.get('Location')).toBeNull();
    expect(refused.headers.get('X-Frame-Options')).toBe('DENY');

    // PKCE is required.
    const noPkce = new URL(url);
    noPkce.searchParams.delete('code_challenge');
    const noPkceResponse = await t.app.request(`${noPkce.pathname}${noPkce.search}`);
    expect(new URL(noPkceResponse.headers.get('Location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses script redirect URIs at registration', async () => {
    const response = await t.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }),
    });
    expect(response.status).toBe(400);
    const plainHttp = await t.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://example.com/callback'] }),
    });
    expect(plainHttp.status).toBe(400);
  });

  it('uses each code once, rotates refresh tokens, and stops when the API key is revoked', async () => {
    const { client, provider: p } = await connectWithOAuth();
    await client.close();
    const clientId = (p.saved.client as { client_id: string }).client_id;
    const { refresh_token: refresh, access_token: access } = p.saved.tokens as { refresh_token: string; access_token: string };

    const token = (body: Record<string, string>) =>
      t.app.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'stores:read stores:write' });
    expect(next.refresh_token).not.toBe(refresh);

    // The old refresh token is spent.
    const again = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });

    const mcp = (bearer: string) =>
      t.app.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect((await mcp(next.access_token)).status).not.toBe(401);

    // Revoking the access token (RFC 7009), then the API key, each cut the client off.
    const revoked = await t.app.request('/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${access}` });
    expect(revoked.status).toBe(200);
    expect((await mcp(access)).status).toBe(401);
    await t.pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [key]);
    expect((await mcp(next.access_token)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: clientId })).status).toBe(400);
    await t.pool.query('UPDATE api_keys SET revoked_at = NULL WHERE id = $1', [key]);
  });

  it('still takes Basic auth', async () => {
    const response = await t.app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: basic(key, secret), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    });
    expect(response.status).toBe(200);
  });
});

// "Sign in with your website" (src/oauth.ts): a store owner types their site's address on the approve
// page, presses Allow in their own wp-admin (WaaS Client's connect page, played here by signing its
// answer with the store's key), and the app gets a token that only edits that store's site.
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatusCode, WaasClient } from '../sdk/typescript/src/index.ts';
import { createApiKey } from '../src/keys.ts';
import { connectAnswerSignature, connectLinkSignature, siteKey, siteKeyMaster, type ConnectAnswer, type ConnectLink } from '../src/sitekeys.ts';
import { basic, setup, TEST_SECRETS_KEY, type TestContext } from './helpers.ts';
import { createHash, randomBytes } from 'node:crypto';

const BASE = 'https://api.example.test';
const REDIRECT = 'http://localhost:3999/callback';

let t: TestContext;
let tenantId: string;
let apiAuth: string;
let mainDomain: string;
const keyOf = (storeId: string) => siteKey(siteKeyMaster(TEST_SECRETS_KEY), storeId);
let seen: string[] = [];

const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(request.url);
  return t.app.request(`${url.pathname}${url.search}`, {
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
    clientMetadata: { client_name: 'Test Agent', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
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

const transportFor = (authProvider: OAuthClientProvider) => new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/site`), { fetch: appFetch, authProvider });
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Starts a connection and types `site` on the approve page; returns the provider and the answer. */
async function typeAddress(site: string) {
  const p = provider();
  await expect(new Client({ name: 'agent', version: '1' }).connect(transportFor(p))).rejects.toBeInstanceOf(UnauthorizedError);
  const url = p.saved.authorizationUrl!;
  const html = await (await t.app.request(`${url.pathname}${url.search}`)).text();
  expect(html).toContain('Your website');
  expect(html).not.toContain('value="signin"');
  const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, decode(m[2]!)]));
  const response = await t.app.request('/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...hidden, action: 'site', site }).toString(),
  });
  return { p, response };
}

/** What WaaS Client does when the owner presses a button: answer at `back`, signed with the store's key. */
function storeAnswers(link: URL, answer: ConnectAnswer, key = keyOf(tenantId)) {
  const back = new URL(link.searchParams.get('back')!);
  const request = link.searchParams.get('request')!;
  back.search = new URLSearchParams({ request, answer, s: connectAnswerSignature(key, request, answer) }).toString();
  return t.app.request(`${back.pathname}${back.search}`);
}

async function finish(p: ReturnType<typeof provider>, response: Response) {
  expect(response.status).toBe(302);
  const callback = new URL(response.headers.get('Location')!);
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
  await transportFor(p).finishAuth(callback.searchParams);
  const client = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transportFor(p));
  return client;
}

beforeAll(async () => {
  t = await setup();
  t.deps.config.publicUrl = BASE;
  t.deps.siteFetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return Response.json({ name: 'Bakery' });
  }) as typeof fetch;
  const { key, secret } = await createApiKey(t.pool, t.productId);
  apiAuth = basic(key, secret);
  const waas = new WaasClient({ baseUrl: BASE, apiKey: key, apiSecret: secret, fetch: appFetch });
  const version = await waas.versions.create({ name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true });
  for (let i = 0; (await waas.versions.list({ versionId: version.id }))[0]?.statusCode !== StatusCode.Done; i++) {
    if (i > 150) throw new Error('version never became Done');
    await new Promise((r) => setTimeout(r, 100));
  }
  await waas.versions.setProduction(version.id!);
  await waas.tenants.create({ name: 'Bakery', externalId: 'bakery' });
  const done = await waas.waitForTenant({ externalId: 'bakery' }, { intervalMs: 100, timeoutMs: 15_000 });
  tenantId = done.id!;
  mainDomain = done.domainName!;
});
afterAll(async () => {
  await t.close();
});

describe('Sign in with your website', () => {
  it('sends the owner to their wp-admin with a signed link, and the token edits only that site', async () => {
    const { p, response } = await typeAddress(`  HTTPS://${mainDomain.toUpperCase()}/shop?x=1 `);
    expect(response.status).toBe(302);
    const link = new URL(response.headers.get('Location')!);
    expect(`${link.origin}${link.pathname}`).toBe(`https://${mainDomain}/wp-admin/admin.php`);
    expect(link.searchParams.get('page')).toBe('waas-connect');
    const fields = Object.fromEntries(['request', 'app', 'to', 'write', 'back', 't'].map((f) => [f, link.searchParams.get(f)!])) as unknown as ConnectLink;
    expect(fields).toMatchObject({ app: 'Test Agent', to: 'localhost:3999', write: '1', back: `${BASE}/oauth/site/answer` });
    expect(link.searchParams.get('s')).toBe(connectLinkSignature(keyOf(tenantId), fields));

    const client = await finish(p, await storeAnswers(link, 'allow'));
    expect(p.saved.tokens).toMatchObject({ scope: 'site:read site:write' });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('page_section');
    expect(names).toContain('get_site');
    expect(names).not.toContain('get_stores');
    expect(names).not.toContain('show_stores');
    expect(names).not.toContain('show_store');
    expect(names).not.toContain('store_status');
    expect(names).not.toContain('manage_domain');

    // Whatever store the agent names, the call goes to this one.
    seen = [];
    const result = await client.callTool({ name: 'get_site', arguments: { externalId: 'someone-else' } });
    expect(result.isError).toBeFalsy();
    expect(seen).toEqual([`https://${mainDomain}/wp-json/waas-client/v1/site`]);
    await client.close();
  });

  it('gives only the read tools when the owner allows looking only', async () => {
    const { p, response } = await typeAddress(mainDomain);
    const client = await finish(p, await storeAnswers(new URL(response.headers.get('Location')!), 'allow-read'));
    expect(p.saved.tokens).toMatchObject({ scope: 'site:read' });
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('site_pages');
    expect(names).not.toContain('page_section');
    expect(names).not.toContain('add_image');
    expect((tools.find((tool) => tool.name === 'site_pages')!.inputSchema.properties?.action as { enum: string[] }).enum).toEqual(['list', 'read', 'revisions']);
    await client.close();
  });

  it('says so when no store has that address', async () => {
    const { response } = await typeAddress('not-a-store.example');
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('could not find an AnyPress website');
  });

  it('refuses an answer the store did not sign, and uses each request once', async () => {
    const { response } = await typeAddress(mainDomain);
    const link = new URL(response.headers.get('Location')!);
    const forged = await storeAnswers(link, 'allow', keyOf('another-store'));
    expect(forged.status).toBe(400);
    expect(forged.headers.get('Location')).toBeNull();

    const denied = await storeAnswers(link, 'deny');
    expect(new URL(denied.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
    expect((await storeAnswers(link, 'allow')).status).toBe(400);
  });

  it('keeps the store address for store owners: /mcp offers no website box and refuses one', async () => {
    const p = provider();
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: appFetch, authProvider: p });
    await expect(new Client({ name: 'agent', version: '1' }).connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    const url = p.saved.authorizationUrl!;
    const html = await (await t.app.request(`${url.pathname}${url.search}`)).text();
    expect(html).not.toContain('name="site"');
    const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, decode(m[2]!)]));
    const response = await t.app.request('/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...hidden, action: 'site', site: mainDomain }).toString(),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
  });

  it('takes no API key at /mcp/site', async () => {
    const { key, secret } = await createApiKey(t.pool, t.productId);
    const response = await t.app.request('/mcp/site', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).not.toContain('Basic');
  });
});

describe('The storefront signs its owner in', () => {
  const signIn = (query: string, body: unknown, auth = apiAuth) =>
    t.app.request(`/v1/tenants/site/sign-in?${query}`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('gives a registered app a code it finishes with its PKCE verifier, for this one website', async () => {
    const registered = await t.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Website assistant', redirect_uris: [REDIRECT] }),
    });
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');

    // Only a registered app, at one of its own addresses, on a store of this storefront.
    expect((await signIn('externalId=bakery', { clientId: '00000000-0000-0000-0000-000000000000', redirectUri: REDIRECT, codeChallenge })).status).toBe(400);
    expect((await signIn('externalId=bakery', { clientId, redirectUri: 'https://evil.example/callback', codeChallenge })).status).toBe(400);
    expect((await signIn('externalId=nobody', { clientId, redirectUri: REDIRECT, codeChallenge })).status).toBe(400);
    expect((await signIn('externalId=bakery', { clientId, redirectUri: REDIRECT, codeChallenge }, 'Basic bm9wZTpub3Bl')).status).toBe(403);

    const answer = await signIn('externalId=bakery', { clientId, redirectUri: REDIRECT, codeChallenge, state: 'xyz' });
    expect(answer.status).toBe(200);
    const target = new URL(((await answer.json()) as { redirectUrl: string }).redirectUrl);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get('state')).toBe('xyz');
    expect(target.searchParams.get('iss')).toBe(BASE);

    const exchange = (code_verifier: string) =>
      t.app.request('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: target.searchParams.get('code')!, code_verifier, client_id: clientId, redirect_uri: REDIRECT }).toString(),
      });
    expect((await exchange('wrong-verifier-wrong-verifier-wrong-verifier')).status).toBe(400);
    // A wrong verifier used the code up, so sign in again.
    const again = new URL(((await (await signIn('externalId=bakery', { clientId, redirectUri: REDIRECT, codeChallenge })).json()) as { redirectUrl: string }).redirectUrl);
    target.searchParams.set('code', again.searchParams.get('code')!);
    const tokens = (await (await exchange(verifier)).json()) as { access_token: string; scope: string };
    expect(tokens.scope.split(' ').sort()).toEqual(['site:read', 'site:write']);

    // The token is the owner's, for the site tools on this store only.
    const client = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/site`), { fetch: appFetch, requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }),
    );
    seen = [];
    const site = await client.callTool({ name: 'get_site', arguments: {} });
    expect(site.isError).toBeFalsy();
    expect(seen.every((url) => new URL(url).host === mainDomain)).toBe(true);
    expect((await t.app.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })).status).toBe(401);
    await client.close();
  });
});

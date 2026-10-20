// Site editing (src/routes/site.ts, src/sitekeys.ts): /v1/tenants/site signs a request with the store's
// site key and passes it to the store's WaaS Client; the MCP site tools go through it. The store here
// is a fake that checks signatures the way WaaS Client's Core\SignedRequest does.
import { createHash, createHmac } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatusCode, WaasClient } from '../sdk/typescript/src/index.ts';
import { createApiKey } from '../src/keys.ts';
import { signedRoute, siteKey, siteKeyMaster } from '../src/sitekeys.ts';
import { basic, setup, TEST_SECRETS_KEY, type TestContext } from './helpers.ts';

let t: TestContext;
let waas: WaasClient;
let auth: string;
let tenantId: string;
let mainDomain: string;

interface Seen {
  url: string;
  method: string;
  body: string;
  signatureOk: boolean;
}
let seen: Seen[] = [];
let storeAnswer: { status: number; body: unknown } | Error = { status: 200, body: { ok: true } };

const master = siteKeyMaster(TEST_SECRETS_KEY);

/** WaaS Client's check: t, n, s over t\nn\nMETHOD\nroute?sorted query\nsha256(body), with the store's key. */
function signatureOk(header: string | null, method: string, url: URL, body: string): boolean {
  const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.split('=') as [string, string]));
  const route = signedRoute(url.pathname.replace(/^\/wp-json/, ''), Object.fromEntries(url.searchParams));
  const payload = [parts.t, parts.n, method, route, createHash('sha256').update(body).digest('hex')].join('\n');
  const expected = createHmac('sha256', siteKey(master, tenantId)).update(payload).digest('hex');
  return parts.s === expected && Math.abs(Date.now() / 1000 - Number(parts.t)) < 300 && /^[0-9a-f]{32}$/.test(parts.n ?? '');
}

const storeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const body = typeof init?.body === 'string' ? init.body : '';
  const method = init?.method ?? 'GET';
  const header = new Headers(init?.headers).get('x-waas-signature');
  seen.push({ url: String(input), method, body, signatureOk: signatureOk(header, method, url, body) });
  if (storeAnswer instanceof Error) throw storeAnswer;
  return new Response(JSON.stringify(storeAnswer.body), { status: storeAnswer.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  return t.app.request(`${url.pathname}${url.search}`, init);
}) as typeof fetch;

beforeAll(async () => {
  t = await setup();
  t.deps.siteFetch = storeFetch;
  const created = await createApiKey(t.pool, t.productId);
  auth = basic(created.key, created.secret);
  waas = new WaasClient({ baseUrl: 'https://api.example.test', apiKey: created.key, apiSecret: created.secret, fetch: appFetch });
  const version = await waas.versions.create({ name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true });
  for (let i = 0; (await waas.versions.list({ versionId: version.id }))[0]?.statusCode !== StatusCode.Done; i++) {
    if (i > 150) throw new Error('version never became Done');
    await new Promise((r) => setTimeout(r, 100));
  }
  await waas.versions.setProduction(version.id!);
  await waas.tenants.create({ name: 'Bakery', externalId: 'site-1' });
  const done = await waas.waitForTenant({ externalId: 'site-1' }, { intervalMs: 100, timeoutMs: 15_000 });
  tenantId = done.id!;
  mainDomain = done.domainName!;
});
afterAll(async () => {
  await t.close();
});

describe('site keys', () => {
  it('are fixed per store and differ between stores', () => {
    expect(siteKey(master, 'a')).toBe(siteKey(master, 'a'));
    expect(siteKey(master, 'a')).not.toBe(siteKey(master, 'b'));
    expect(siteKey(master, 'a')).toHaveLength(43);
    expect(siteKey(siteKeyMaster(Buffer.alloc(32, 8).toString('base64')), 'a')).not.toBe(siteKey(master, 'a'));
  });

  it('sign the query sorted and encoded as PHP rawurlencode does', () => {
    expect(signedRoute('/x', {})).toBe('/x');
    expect(signedRoute('/x', { search: 'big text (dark)!', category: 'hero' })).toBe('/x?category=hero&search=big%20text%20%28dark%29%21');
  });
});

describe('POST /v1/tenants/site', () => {
  it('signs a read with its query and answers with the store’s reply', async () => {
    seen = [];
    storeAnswer = { status: 200, body: [{ name: 'ollie/hero-light' }] };
    const answer = await waas.tenants.editSite({ externalId: 'site-1' }, { method: 'GET', path: '/patterns', query: { search: 'hero light', category: 'ollie/hero' } });
    expect(answer).toEqual({ status: 200, body: [{ name: 'ollie/hero-light' }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://${mainDomain}/wp-json/waas-client/v1/site/patterns?category=ollie%2Fhero&search=hero%20light`);
    expect(seen[0]!.signatureOk).toBe(true);
  });

  it('signs a write with its body', async () => {
    seen = [];
    storeAnswer = { status: 200, body: { id: 12 } };
    await waas.tenants.editSite({ externalId: 'site-1' }, { method: 'POST', path: '/pages/12/sections', body: { pattern: 'ollie/hero-light', position: 0 } });
    expect(seen[0]).toMatchObject({ method: 'POST', body: '{"pattern":"ollie/hero-light","position":0}', signatureOk: true });
  });

  it('passes the store’s 4xx on, and turns a refused signature or no answer into 502', async () => {
    storeAnswer = { status: 404, body: { code: 'waas_site_not_found', message: 'No page has that id.' } };
    expect(await waas.tenants.editSite({ externalId: 'site-1' }, { method: 'GET', path: '/pages/99' })).toEqual({
      status: 404,
      body: { code: 'waas_site_not_found', message: 'No page has that id.' },
    });

    storeAnswer = { status: 401, body: { code: 'waas_site_unauthorized' } };
    const refused = await t.call('POST', '/v1/tenants/site?externalId=site-1', { auth, body: { method: 'GET', path: '' } });
    expect(refused.status).toBe(502);
    expect((await refused.json()).message).toMatch(/no site key yet/);

    storeAnswer = new Error('connect ECONNREFUSED');
    const down = await t.call('POST', '/v1/tenants/site?externalId=site-1', { auth, body: { method: 'GET', path: '' } });
    expect(down.status).toBe(502);
    storeAnswer = { status: 200, body: {} };
  });

  it('refuses paths outside the site routes and unknown stores', async () => {
    seen = [];
    for (const path of ['/../../wp/v2/users', 'pages', '/pages?x=1', '/Pages']) {
      const response = await t.call('POST', '/v1/tenants/site?externalId=site-1', { auth, body: { method: 'GET', path } });
      expect(response.status).toBe(400);
    }
    expect((await t.call('POST', '/v1/tenants/site?externalId=nope', { auth, body: { method: 'GET', path: '' } })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('refuses a suspended store', async () => {
    await waas.tenants.suspend({ externalId: 'site-1' }, { takeBackup: false });
    await waas.waitForTenant({ externalId: 'site-1' }, { intervalMs: 100, timeoutMs: 15_000 });
    const response = await t.call('POST', '/v1/tenants/site?externalId=site-1', { auth, body: { method: 'GET', path: '' } });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/suspended/);
    await waas.tenants.resume({ externalId: 'site-1' });
    await waas.waitForTenant({ externalId: 'site-1' }, { intervalMs: 100, timeoutMs: 15_000 });
  });
});

describe('MCP site tools', () => {
  let mcp: Client;

  beforeAll(async () => {
    const transport = new StreamableHTTPClientTransport(new URL('https://api.example.test/mcp'), { fetch: appFetch, requestInit: { headers: { Authorization: auth } } });
    mcp = new Client({ name: 'test', version: '1.0.0' });
    await mcp.connect(transport);
  });
  afterAll(async () => {
    await mcp?.close();
  });

  const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { text: string }[])[0]!.text;

  it('adds a section through the store', async () => {
    seen = [];
    storeAnswer = { status: 200, body: { id: 12, outline: [{ section: 0, block: 'core/cover' }] } };
    const result = await mcp.callTool({ name: 'add_section', arguments: { externalId: 'site-1', pageId: 12, pattern: 'ollie/hero-light', position: 0 } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({ id: 12 });
    expect(seen[0]).toMatchObject({ method: 'POST', signatureOk: true });
    expect(seen[0]!.url).toMatch(/\/site\/pages\/12\/sections$/);
  });

  it('reports the store’s refusal as a tool error', async () => {
    storeAnswer = { status: 404, body: { message: 'That page has no such section. Read the page for its outline.' } };
    const result = await mcp.callTool({ name: 'remove_section', arguments: { externalId: 'site-1', pageId: 12, section: 7 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('The store answered 404: That page has no such section. Read the page for its outline.');
    storeAnswer = { status: 200, body: {} };
  });

  it('marks reads read-only and removing a section destructive', async () => {
    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('read_page')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('update_site_styles')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('remove_section')?.annotations?.destructiveHint).toBe(true);
  });
});

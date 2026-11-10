// Site editing (src/routes/site.ts, src/sitekeys.ts): /v1/tenants/site signs a request with the store's
// site key and passes it to the store's AnyPress Client; the MCP site tools go through it. The store here
// is a fake that checks signatures the way AnyPress Client's Core\SignedRequest does.
import { createHash, createHmac } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatusCode, WaasClient } from '../sdk/typescript/src/index.ts';
import { createApiKey } from '../src/keys.ts';
import { signedRoute, siteKey, siteKeyMaster } from '../src/sitekeys.ts';
import { basic, setup, TEST_SECRETS_KEY, type TestContext, OWNER } from './helpers.ts';

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
/** When set, the store answers by path (after /site) instead of with storeAnswer. */
let storeRoutes: Record<string, unknown> | null = null;

const master = siteKeyMaster(TEST_SECRETS_KEY);

/** AnyPress Client's check: t, n, s over t\nn\nMETHOD\nroute?sorted query\nsha256(body), with the store's key. */
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
  const header = new Headers(init?.headers).get('x-anypress-signature');
  seen.push({ url: String(input), method, body, signatureOk: signatureOk(header, method, url, body) });
  if (storeRoutes) {
    const path = url.pathname.replace(/^.*\/site/, '');
    return path in storeRoutes ? Response.json(storeRoutes[path]) : Response.json({ message: 'No such page' }, { status: 404 });
  }
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
  await waas.tenants.create({ ...OWNER, name: 'Bakery', externalId: 'site-1' });
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
    expect(seen[0]!.url).toBe(`https://${mainDomain}/wp-json/anypress-client/v1/site/patterns?category=ollie%2Fhero&search=hero%20light`);
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
    const result = await mcp.callTool({ name: 'page_section', arguments: { action: 'add', externalId: 'site-1', pageId: 12, pattern: 'ollie/hero-light', section: 0 } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({ id: 12 });
    expect(seen[0]).toMatchObject({ method: 'POST', signatureOk: true });
    expect(seen[0]!.url).toMatch(/\/site\/pages\/12\/sections$/);
  });

  it('reports the store’s refusal as a tool error', async () => {
    storeAnswer = { status: 404, body: { message: 'That page has no such section. Read the page for its outline.' } };
    const result = await mcp.callTool({ name: 'page_section', arguments: { action: 'remove', externalId: 'site-1', pageId: 12, section: 7 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('The store answered 404: That page has no such section. Read the page for its outline.');
    storeAnswer = { status: 200, body: {} };
  });

  it('marks read-only tools read-only and page_section destructive', async () => {
    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('site_patterns')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('site_styles')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('page_section')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('site_styles')?.annotations?.destructiveHint).toBe(false);
  });

  it('sends a page_section add with its position, and asks for what an action needs', async () => {
    seen = [];
    await mcp.callTool({ name: 'page_section', arguments: { action: 'add', externalId: 'site-1', pageId: 12, pattern: 'ollie/hero-light', section: 2 } });
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ pattern: 'ollie/hero-light', position: 2 });
    const missing = await mcp.callTool({ name: 'page_section', arguments: { action: 'replace', externalId: 'site-1', pageId: 12, content: '<p>x</p>' } });
    expect(missing).toMatchObject({ isError: true, content: [{ text: 'Action replace needs section.' }] });
  });
});

describe('POST /v1/tenants/site/reference-check', () => {
  const page = (url: string, title: string, text: string, images: string[] = [], links: string[] = []) => ({ url, title, text, sections: [], screenshot: `${url}#shot`, mobileScreenshot: null, images, links });
  const ownText = 'We bake fresh sourdough bread every single morning in our small family kitchen downtown';
  const bundle = {
    kind: 'website', source: 'https://oldbakery.example/', title: 'Old Bakery', platform: 'other', design: {}, items: [{ kind: 'post' }], products: [], collections: [], coverage: null, notes: [],
    pages: [
      page('https://oldbakery.example/', 'Home', `# Fresh bread daily\n\n${ownText}.\n\n## Visit us\n\nOpen every day.`, ['https://oldbakery.example/a.jpg'], ['https://oldbakery.example/menu', 'https://oldbakery.example/catering']),
      page('https://oldbakery.example/menu/', 'Menu', '# Our menu\n\n## Breads\n\n## Pastries\n\n## Drinks', ['https://oldbakery.example/b.jpg', 'https://oldbakery.example/c.jpg']),
      page('https://oldbakery.example/catering/', 'Catering', '# Catering\n\nWe cater weddings.'),
    ],
  };
  let referenceId: string;

  beforeAll(async () => {
    const { rows } = await t.pool.query("INSERT INTO site_references (product_id, kind, source, status, bundle) VALUES ($1, 'website', $2, 1, $3) RETURNING id", [t.productId, bundle.source, bundle]);
    referenceId = rows[0].id;
    storeRoutes = {
      '': { homePage: 5 },
      '/pages': [
        { id: 5, title: 'Welcome', slug: 'welcome', status: 'publish', link: 'https://bakery.example/' },
        { id: 6, title: 'Menu', slug: 'menu', status: 'draft', link: 'https://bakery.example/?p=6' },
        { id: 7, title: 'Contact', slug: 'contact', status: 'publish', link: 'https://bakery.example/contact/' },
      ],
      '/pages/5': { content: `<!-- wp:heading --><h1>Fresh bread daily</h1><!-- /wp:heading --><p>${ownText}.</p><h2>Visit us</h2><img src="https://bakery.example/a.jpg">` },
      '/pages/6': { content: '<h1>Our menu</h1><p>Bread.</p>' },
    };
  });
  afterAll(() => {
    storeRoutes = null;
  });

  const check = (body: unknown) => t.call('POST', '/v1/tenants/site/reference-check?externalId=site-1', { body });

  it('matches every reference page and says what each is missing, for the owner’s own site', async () => {
    const res = await check({ referenceId, ownContent: true });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.summary).toEqual({ pages: 3, pass: 0, warn: 1, fail: 2 });
    const [home, menu, catering] = r.pages;
    // The home page is matched as the home page, whatever its slug; its link to catering leads nowhere.
    expect(home).toMatchObject({ storePage: { id: 5 }, status: 'warn', counts: { headings: [2, 2], images: [1, 1] }, referenceScreenshot: 'https://oldbakery.example/#shot' });
    expect(home.findings).toEqual([{ level: 'warn', message: 'The reference links to pages the store has no page for: /catering.' }]);
    expect(menu.storePage).toMatchObject({ id: 6, status: 'draft' });
    expect(menu.findings.map((f: any) => f.message)).toEqual([
      "The store's page is still draft.",
      'It has 1 headings; the reference has 4: sections may be missing.',
      'It has 0 images; the reference has 2.',
      'Headings not carried over: "Breads", "Pastries", "Drinks".',
    ]);
    expect(catering).toMatchObject({ storePage: null, status: 'fail', findings: [{ level: 'fail', message: 'The store has no page for this one ("Catering").' }] });
    expect(r.extraStorePages).toEqual([{ id: 7, title: 'Contact', link: 'https://bakery.example/contact/' }]);
    expect(r.notes.join(' ')).toContain('1 posts or other items');
  });

  it("fails a page that copies someone else's site, and goes through a big reference a part at a time", async () => {
    const r = await (await check({ referenceId, limit: 1 })).json();
    expect(r.pages[0].findings).toContainEqual({ level: 'fail', message: expect.stringContaining("copied from the reference, which is someone else's site") });
    expect(r.notes[0]).toBe('2 more reference pages: check them with offset 1.');
    const rest = await (await check({ referenceId, offset: 1 })).json();
    expect(rest.pages.map((p: any) => p.referenceTitle)).toEqual(['Menu', 'Catering']);
    expect(rest.extraStorePages).toEqual([]);
  });

  it('refuses a reference that is not read yet', async () => {
    const { rows } = await t.pool.query("INSERT INTO site_references (product_id, kind, source) VALUES ($1, 'website', 'https://x.example/') RETURNING id", [t.productId]);
    const res = await check({ referenceId: rows[0].id });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('still being read');
  });
});

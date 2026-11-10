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
/** When set, the store answers by path (after /site) instead of with storeAnswer; a function answers from the request body. */
let storeRoutes: Record<string, unknown> | null = null;
const routeAnswer = (route: unknown, body: string) => Response.json(typeof route === 'function' ? route(JSON.parse(body || 'null')) : route);

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
    return path in storeRoutes ? routeAnswer(storeRoutes[path], body) : Response.json({ message: 'No such page' }, { status: 404 });
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

  it('lists pattern categories, blocks and looks, and switches a look on', async () => {
    seen = [];
    storeAnswer = { status: 200, body: [] };
    await mcp.callTool({ name: 'site_patterns', arguments: { action: 'categories', externalId: 'site-1' } });
    await mcp.callTool({ name: 'site_patterns', arguments: { action: 'blocks', externalId: 'site-1' } });
    storeAnswer = { status: 200, body: {} };
    await mcp.callTool({ name: 'site_styles', arguments: { action: 'variations', externalId: 'site-1' } });
    const apply = await mcp.callTool({ name: 'site_styles', arguments: { action: 'apply', externalId: 'site-1', slug: 'kit-ridge' } });
    expect(apply.isError).toBeFalsy();
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname.replace(/^.*\/site/, '')}`)).toEqual([
      'GET /patterns/categories',
      'GET /blocks',
      'GET /styles/variations',
      'POST /styles/variations/kit-ridge',
    ]);
    const missing = await mcp.callTool({ name: 'site_styles', arguments: { action: 'apply', externalId: 'site-1' } });
    expect(missing).toMatchObject({ isError: true, content: [{ text: 'Action apply needs slug.' }] });
  });

  it('makes preview links on the store’s platform address, and shows the looks screen (MCP App)', async () => {
    seen = [];
    storeRoutes = {
      '/preview': { url: `https://${mainDomain}/?anypress_preview=abc.def`, siteUrl: `https://${mainDomain}/`, expiresIn: 900 },
      '/styles/variations': { variations: [{ slug: 'kit-hearth', title: 'Hearth (food and drink)', kind: 'kit', homePage: 'anypress/kit-food' }], blockStyles: [] },
      '/patterns/categories': [{ name: 'anypress/kit-food', label: 'Kit: Food and drink (Hearth)', patterns: 12 }],
    };
    const result = await mcp.callTool({ name: 'site_patterns', arguments: { action: 'preview', externalId: 'site-1', name: 'anypress/kit-food', variation: 'kit-hearth' } });
    expect(result.isError).toBeFalsy();
    const base = (await waas.domains.list({ externalId: 'site-1' })).find((d) => d.isBaseDomain)!.domainName;
    expect(JSON.parse(text(result))).toMatchObject({ url: `https://${base}/?anypress_preview=abc.def`, expiresIn: 900 });
    expect(base).toMatch(/\.stores\.waas\.example$/);
    expect(new URL(seen[0]!.url).search).toBe('?name=anypress%2Fkit-food&variation=kit-hearth');
    const missing = await mcp.callTool({ name: 'site_patterns', arguments: { action: 'preview', externalId: 'site-1' } });
    expect(missing).toMatchObject({ isError: true, content: [{ text: 'Action preview needs name.' }] });

    const { tools } = await mcp.listTools();
    expect(tools.find((tool) => tool.name === 'show_looks')?._meta).toMatchObject({ ui: { resourceUri: 'ui://waas/looks.html' } });
    const looks = await mcp.callTool({ name: 'show_looks', arguments: { externalId: 'site-1' } });
    expect(looks.structuredContent).toMatchObject({
      ref: { externalId: 'site-1' },
      variations: [expect.objectContaining({ slug: 'kit-hearth', homePage: 'anypress/kit-food' })],
      categories: [expect.objectContaining({ name: 'anypress/kit-food' })],
      canApply: true,
      framed: true,
    });
    // Hosts frame the store's preview pages only from the stores' domain.
    const { contents } = await mcp.readResource({ uri: 'ui://waas/looks.html' });
    expect(contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: { frameDomains: ['https://*.stores.waas.example'] } } } });
    const html = (contents[0] as { text: string }).text;
    for (const marker of ['/*MCP_APPS_BUNDLE*/', '/*VIEW_STYLE*/', '/*VIEW_COMMON*/']) expect(html).not.toContain(marker);
    // Its buttons call tools and actions that exist.
    expect(html).toContain("call('site_patterns', { action: 'preview'");
    expect(html).toContain("call('site_styles', { action: 'apply'");
    expect(html).toContain("call('site_patterns', { action: 'find'");
    storeRoutes = null;
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

describe('POST /v1/tenants/site/reference-products', () => {
  const variant = (title: string, price: string, available = true) => ({ title, sku: `SKU-${title}`, price, compareAtPrice: null, available });
  const product = (n: number, extra: Record<string, unknown> = {}) => ({
    url: `https://oldbakery.example/products/p${n}`, title: `Product ${n}`, handle: `p${n}`, description: `<p>About ${n}</p>`, vendor: null, type: 'Bread', tags: ['Fresh'],
    price: '5.00', compareAtPrice: null, images: [`https://cdn.example/p${n}.jpg`], variants: [], ...extra,
  });
  const bundle = {
    kind: 'website', source: 'https://oldbakery.example/', title: 'Old Bakery', platform: 'shopify', design: {}, pages: [], items: [], collections: [], coverage: null, notes: [],
    products: [product(1, { variants: [variant('Small', '8.50'), variant('Large', '12.00', false)] }), ...Array.from({ length: 22 }, (_, i) => product(i + 2))],
  };
  let referenceId: string;
  const batches: any[][] = [];

  beforeAll(async () => {
    const { rows } = await t.pool.query("INSERT INTO site_references (product_id, kind, source, status, bundle) VALUES ($1, 'website', $2, 1, $3) RETURNING id", [t.productId, bundle.source, bundle]);
    referenceId = rows[0].id;
    storeRoutes = {
      '/products': ({ products }: { products: any[] }) => {
        batches.push(products);
        return { results: products.map((p, i) => (p.title === 'Product 2' ? { url: p.url, status: 'exists', id: 40, link: 'https://bakery.example/p2/', productStatus: 'publish' } : { url: p.url, status: 'created', id: 100 + i, link: `https://bakery.example/?p=${100 + i}`, productStatus: p.status, images: p.images?.length ?? 0 })) };
      },
    };
  });
  afterAll(() => {
    storeRoutes = null;
  });

  const add = (body: unknown) => t.call('POST', '/v1/tenants/site/reference-products?externalId=site-1', { body });

  it("sends the owner's own products 20 at a time as drafts, with options, categories, descriptions and photos", async () => {
    const res = await add({ referenceId, ownContent: true });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(batches.map((b) => b.length)).toEqual([20, 3]);
    expect(batches[0]?.[0]).toEqual({
      title: 'Product 1', url: 'https://oldbakery.example/products/p1', status: 'draft', categories: ['Bread', 'Fresh'], description: '<p>About 1</p>', images: ['https://cdn.example/p1.jpg'],
      variants: [{ title: 'Small', sku: 'SKU-Small', price: '8.50', available: true }, { title: 'Large', sku: 'SKU-Large', price: '12.00', available: false }],
    });
    // A product with no variants is one option at its own price.
    expect(batches[0]?.[2].variants).toEqual([{ price: '5.00' }]);
    expect(r.summary).toEqual({ products: 23, created: 22, exists: 1, failed: 0 });
    expect(r.results[1]).toMatchObject({ title: 'Product 2', status: 'exists', id: 40, storeStatus: 'publish' });
    expect(r.results[0]).toMatchObject({ status: 'created', storeStatus: 'draft', images: 1, reason: null });
    expect(r.remaining).toBe(0);
    expect(seen.every((s) => s.signatureOk)).toBe(true);
  });

  it("adds someone else's products without their descriptions or photos, a part at a time", async () => {
    batches.length = 0;
    const r = await (await add({ referenceId, limit: 2, offset: 1, status: 'publish' })).json();
    expect(batches[0]?.map((p) => p.title)).toEqual(['Product 2', 'Product 3']);
    expect(batches[0]?.[1]).not.toHaveProperty('description');
    expect(batches[0]?.[1]).not.toHaveProperty('images');
    expect(batches[0]?.[1].status).toBe('publish');
    expect(r.remaining).toBe(20);
    expect(r.notes.join(' ')).toContain('call again with offset 3');
    expect(r.notes.join(' ')).toContain('someone else');
  });

  it('says so when the store is too old for products', async () => {
    const routes = storeRoutes;
    storeRoutes = {};
    const res = await add({ referenceId });
    storeRoutes = routes;
    expect(res.status).toBe(502);
    expect((await res.json()).message).toContain('older than 2.19.0');
  });
});

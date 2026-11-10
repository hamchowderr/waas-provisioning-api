// Reading references to build sites from (src/references.ts, src/referencesite.ts, docs/references.md): websites on
// Shopify, WordPress, Squarespace and anything else (every page, the platform's own data first, a coverage list), a
// Figma file and a document, each into the same bundle. Firecrawl, Figma and the sites are fakes. Responses are
// checked against openapi/waas-provisioning-api.yaml.
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAjv, spec } from '../src/openapi.ts';
import { figmaLink, parseReferenceInput, startReferences, type ReferenceReaders } from '../src/references.ts';
import { setup, waitFor, type TestContext } from './helpers.ts';

const ajv = createAjv();
const opSchema = (operationId: string) => {
  for (const item of Object.values(spec.paths as Record<string, Record<string, any>>)) {
    for (const op of Object.values(item)) if (op?.operationId === operationId) return op.responses['200'].content['application/json'].schema;
  }
  throw new Error(operationId);
};
const valid = (operationId: string, body: unknown) => {
  const validate = ajv.compile(JSON.parse(JSON.stringify(opSchema(operationId)).replaceAll('"#/components', '"spec#/components')));
  expect(validate(body), ajv.errorsText(validate.errors)).toBe(true);
};

let t: TestContext;
const scraped: Array<{ url: string; options: any }> = [];
const crawls: Array<{ url: string; options: any }> = [];
const batches: string[][] = [];
const figmaCalls: string[] = [];

const doc = (url: string, extra: Record<string, unknown> = {}) => ({
  markdown: `# Page ${url}`,
  images: ['https://cdn.example/a.jpg', 'https://cdn.example/a.jpg'],
  screenshot: 'https://shots.example/1.png',
  metadata: { title: `Title of ${url}`, sourceURL: url, statusCode: 200 },
  ...extra,
});
const branding = {
  brandName: 'Example Co',
  colorScheme: 'light',
  logo: 'https://example.com/logo.svg',
  colors: { primary: '#1D4ED8', background: '#FFFFFF', textPrimary: '#111827' },
  fonts: [{ family: 'Inter' }],
  typography: { fontFamilies: { primary: 'Inter', heading: 'Fraunces' }, fontSizes: { h1: '56px', body: '16px' } },
  spacing: { borderRadius: 8 },
};

/** What each fake site's map finds, and what its crawl reaches (the rest is left for the batch). */
const sites: Record<string, { map: string[]; crawl: string[] }> = {
  'example.com': {
    map: ['/', '/about', '/services/roofing', '/cart', '/logo.png', '/products/runner', '/products/walker', '/pages/faq', 'https://other.example/x'],
    crawl: ['/', '/about', '/services/roofing', '/missing'],
  },
  'wp.example': { map: ['/', '/about/', '/2026/01/hello/', '/2026/02/second/', '/tag/news/', '/shop/mug/'], crawl: ['/', '/about/'] },
  'sq.example': { map: ['/', '/blog', '/blog/first-post', '/blog/second-post', '/contact'], crawl: ['/', '/blog', '/contact'] },
  'plain.example': { map: ['/', '/a', '/b', '/c'], crawl: ['/', '/a', '/b', '/c'] },
};
const siteOf = (url: string) => sites[new URL(url).hostname] ?? { map: [], crawl: [] };
const abs = (url: string, path: string) => new URL(path, url).toString();

const firecrawl = {
  scrape: async (url: string, options: any) => {
    scraped.push({ url, options });
    if (url.includes('broken')) throw new Error('Request failed with status 500');
    return doc(url, { branding, links: [abs(url, '/about'), abs(url, '/contact')] });
  },
  map: async (url: string) => ({ links: siteOf(url).map.map((p) => ({ url: abs(url, p) })) }),
  startCrawl: async (url: string, options: any) => {
    crawls.push({ url, options });
    return { id: `crawl:${url}`, url };
  },
  getCrawlStatus: async (id: string) => {
    const url = id.slice(6);
    const data = siteOf(url)
      .crawl.slice(0, crawls.at(-1)!.options.limit)
      .map((p) => (p === '/missing' ? { ...doc(abs(url, p)), metadata: { sourceURL: abs(url, p), statusCode: 404 } } : doc(abs(url, p))));
    return { id, status: 'completed', total: data.length, completed: data.length, creditsUsed: data.length, data };
  },
  getCrawlErrors: async (id: string) => (id.includes('example.com') ? { errors: [{ id: '1', url: 'https://example.com/slow', error: 'Timed out' }], robotsBlocked: ['https://example.com/private'] } : { errors: [], robotsBlocked: [] }),
  cancelCrawl: async () => true,
  startBatchScrape: async (urls: string[]) => {
    batches.push(urls);
    return { id: `batch:${batches.length - 1}`, url: '' };
  },
  getBatchScrapeStatus: async (id: string) => {
    const urls = batches[Number(id.slice(6))]!;
    const data = urls.map((u) => doc(u, u.includes('/products/') ? { product: { title: 'Runner page', url: u, variants: [{ availability: { inStock: true } }] } } : {}));
    return { status: 'completed', total: data.length, completed: data.length, creditsUsed: data.length, data };
  },
  getBatchScrapeErrors: async () => ({ errors: [], robotsBlocked: [] }),
  cancelBatchScrape: async () => true,
  parse: async (file: { filename: string; data: Buffer }) => ({ markdown: `# ${file.filename}\n\n${file.data.toString()}`, metadata: { title: 'The brief', creditsUsed: 1 } }),
};

const json = (body: unknown, headers: Record<string, string> = {}) => Response.json(body, { headers });
const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { 'content-type': 'text/html', ...headers } });

/** sq.example's robots.txt names a sitemap index; its one sitemap is gzipped and lists a page no link points to. */
const sqSitemap: Record<string, () => Response> = {
  '/robots.txt': () => new Response('User-agent: *\nSitemap: https://sq.example/sitemap.xml\n', { headers: { 'content-type': 'text/plain' } }),
  '/sitemap.xml': () => new Response('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://sq.example/pages.xml.gz</loc></sitemap></sitemapindex>', { headers: { 'content-type': 'application/xml' } }),
  '/pages.xml.gz': () => new Response(gzipSync('<urlset><url><loc>https://sq.example/blog/first-post</loc></url><url><loc><![CDATA[https://sq.example/only-in-sitemap]]></loc></url></urlset>'), { headers: { 'content-type': 'application/x-gzip' } }),
};

/** The sites' own pages and data. */
const siteFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const route = url.pathname + (url.searchParams.get('format') ? '?format=json' : '');
  switch (url.hostname) {
    case 'example.com':
      if (url.pathname === '/') return html('<link href="https://cdn.shopify.com/s/theme.css">');
      if (url.pathname === '/collections.json') return json({ collections: [{ title: 'Shoes', handle: 'shoes', description: '<p>All our shoes</p>' }] });
      if (url.pathname === '/products.json')
        return json({
          products:
            url.searchParams.get('page') === '1'
              ? [
                  { title: 'Runner', handle: 'runner', body_html: '<p>Light &amp; quick.</p>', vendor: 'Example', product_type: 'Shoes', tags: ['new', 'running'], images: [{ src: 'https://cdn.shopify.example/runner.jpg' }], variants: [{ title: '9', sku: 'RUN-9', price: '98.00', compare_at_price: null, available: true }] },
                  { title: 'Walker', handle: 'walker', body_html: '', vendor: 'Example', product_type: 'Shoes', tags: '', images: [], variants: [{ title: '10', sku: null, price: '88.00', compare_at_price: '99.00', available: false }] },
                ]
              : [],
        });
      break;
    case 'www.wp.example':
      return new Response(null, { status: 301, headers: { location: 'https://wp.example/' } });
    case 'wp.example': {
      if (url.pathname === '/') return html('<p>hi</p>', { link: '<https://wp.example/wp-json/>; rel="https://api.w.org/"' });
      if (url.pathname === '/wp-json/wp/v2/types') return json({ page: { rest_base: 'pages', rest_namespace: 'wp/v2' }, post: { rest_base: 'posts', rest_namespace: 'wp/v2' }, attachment: { rest_base: 'media' }, feedback: { rest_base: 'feedback' } });
      if (url.pathname === '/wp-json/wp/v2/pages') return json([{ link: 'https://wp.example/about/' }, { link: 'https://wp.example/hidden-offer/' }], { 'x-wp-totalpages': '1' });
      if (url.pathname === '/wp-json/wp/v2/posts') {
        const page = Number(url.searchParams.get('page'));
        const post = (n: number, path: string) => ({ link: `https://wp.example${path}`, title: { rendered: `Post ${n}` }, content: { rendered: `<p>Body ${n} &amp; more</p><img src="https://wp.example/img${n}.jpg">` }, date: '2026-01-01T00:00:00', _embedded: { 'wp:featuredmedia': [{ source_url: `https://wp.example/feature${n}.jpg` }] } });
        return json(page === 1 ? [post(1, '/2026/01/hello/')] : [post(2, '/2026/02/second/')], { 'x-wp-totalpages': '2' });
      }
      if (url.pathname === '/wp-json/wc/store/v1/products') return json([{ name: 'Mug', slug: 'mug', permalink: 'https://wp.example/shop/mug/', description: '<p>A mug</p>', prices: { price: '1250', regular_price: '1500', currency_minor_unit: 2 }, on_sale: true, is_in_stock: true, sku: 'MUG', images: [{ src: 'https://wp.example/mug.jpg' }], categories: [{ name: 'Kitchen' }], tags: [] }], { 'x-wp-totalpages': '1' });
      break;
    }
    case 'sq.example':
      if (route === '/') return html('<link href="https://static1.squarespace.com/x.css">');
      if (sqSitemap[route]) return sqSitemap[route]!();
      if (route === '/blog?format=json')
        return json({
          collection: { typeName: 'blog', title: 'Blog', description: '<p>News</p>' },
          items: [
            { title: 'First post', fullUrl: '/blog/first-post', body: '<p>One</p>', publishOn: 1767225600000, assetUrl: 'https://images.sq/1.jpg' },
            { title: 'Second post', fullUrl: '/blog/second-post', body: '<p>Two</p>', publishOn: 1767312000000 },
          ],
        });
      break;
    case 'plain.example':
      if (url.pathname === '/') return html('<p>plain</p>');
      break;
  }
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
}) as typeof fetch;

const readers: ReferenceReaders = {
  firecrawl: firecrawl as unknown as NonNullable<ReferenceReaders['firecrawl']>,
  siteFetch,
  pollMs: 10,
  figmaToken: 'figma-test-token',
  figmaFetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    figmaCalls.push(url);
    expect((init?.headers as Record<string, string>)['X-Figma-Token']).toBe('figma-test-token');
    if (url.includes('/v1/images/')) return Response.json({ images: { '1:2': 'https://figma-shots.example/home.png' } });
    if (url.endsWith('/images')) return Response.json({ meta: { images: { ref1: 'https://figma-images.example/photo.jpg' } } });
    if (url.includes('/v1/files/Missing')) return new Response('{}', { status: 404 });
    const solid = (r: number, g: number, b: number) => [{ type: 'SOLID', color: { r, g, b, a: 1 } }];
    return Response.json({
      name: 'KnowBS mockup',
      document: {
        id: '0:0',
        type: 'DOCUMENT',
        children: [
          {
            id: '0:1',
            type: 'CANVAS',
            name: 'Page 1',
            children: [
              {
                id: '1:2',
                type: 'FRAME',
                name: 'Home',
                fills: solid(1, 1, 1),
                cornerRadius: 0,
                children: [
                  { id: '2:1', type: 'FRAME', name: 'Hero', fills: solid(0.1, 0.3, 0.9), cornerRadius: 12, children: [
                    { id: '3:1', type: 'TEXT', name: 'h', characters: 'Grow your business', style: { fontFamily: 'Fraunces', fontSize: 64 }, fills: solid(0.07, 0.07, 0.07) },
                    { id: '3:2', type: 'TEXT', name: 'p', characters: 'We build websites.', style: { fontFamily: 'Inter', fontSize: 18 }, fills: solid(0.07, 0.07, 0.07) },
                    { id: '3:3', type: 'RECTANGLE', name: 'photo', fills: [{ type: 'IMAGE', imageRef: 'ref1' }] },
                  ] },
                  { id: '2:2', type: 'FRAME', name: 'Hidden', visible: false, children: [{ id: '3:4', type: 'TEXT', characters: 'secret', name: 't' }] },
                  { id: '2:3', type: 'FRAME', name: 'Footer', children: [{ id: '3:5', type: 'TEXT', name: 't', characters: 'Contact us today, we answer every message.', style: { fontFamily: 'Inter', fontSize: 14 }, fills: solid(0.07, 0.07, 0.07) }] },
                ],
              },
            ],
          },
        ],
      },
    });
  }) as typeof fetch,
};

const start = (body: unknown) => t.call('POST', '/v1/references', { body });
const get = async (id: string, query = '') => (await t.call('GET', `/v1/references?id=${id}${query}`)).json() as Promise<any>;
const done = (id: string) => waitFor(async () => {
  const r = await get(id);
  return r.statusCode !== 0 && r;
});
const read = async (body: unknown) => {
  const res = await start(body);
  expect(res.status).toBe(200);
  const started = await res.json();
  valid('startReference', started);
  const r = await done(started.id);
  valid('getReference', r);
  return r;
};
const entry = (r: any, path: string) => r.bundle.coverage.urls.find((u: any) => new URL(u.url).pathname.replace(/\/$/, '') === path.replace(/\/$/, ''));

beforeAll(async () => {
  t = await setup();
  await startReferences(t.boss, t.pool, readers, { pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5, log: { error: () => {} }, config: () => t.deps.config.references ?? { readsPerMonth: 0 } });
});
afterAll(async () => t?.close());

describe('reference input', () => {
  it('tells a Figma link, a document link and a website apart, and reads every page unless told fewer', () => {
    expect(figmaLink(new URL('https://www.figma.com/design/cBeZphfCqyY75Rlk3VgyW2/KnowBS?node-id=0-1&t=x'))).toEqual({ key: 'cBeZphfCqyY75Rlk3VgyW2', nodeId: '0:1' });
    expect(figmaLink(new URL('https://example.com/design/cBeZphfCqyY75Rlk3VgyW2'))).toBeNull();
    expect(parseReferenceInput({ url: 'example.com' })).toMatchObject({ kind: 'website', source: 'https://example.com/', maxPages: 500 });
    expect(parseReferenceInput({ url: 'example.com', maxPages: 20 }, 100).maxPages).toBe(20);
    expect(parseReferenceInput({ url: 'https://example.com/menu.PDF' }).kind).toBe('document');
    expect(parseReferenceInput({ file: { name: 'brief.docx', data: Buffer.from('hi').toString('base64') } })).toMatchObject({ kind: 'document', source: 'brief.docx' });
    for (const bad of [{}, { url: 'ftp://example.com' }, { url: 'https://u:p@example.com' }, { url: 'https://example.com', maxPages: 501 }, { file: { name: 'a.exe', data: 'aGk=' } }, { url: 'https://example.com', file: { name: 'a.pdf', data: 'aGk=' } }]) {
      expect(() => parseReferenceInput(bad)).toThrow();
    }
  });
});

describe('reading references', () => {
  it('answers 503 until reading is set up, and counts nothing', async () => {
    t.deps.config.references = { readsPerMonth: 5 };
    expect((await start({ url: 'https://example.com' })).status).toBe(503);
    const usage = await (await t.call('GET', '/v1/references/usage')).json();
    valid('getReferenceUsage', usage);
    expect(usage).toMatchObject({ available: false, used: 0, limit: 5, creditsUsed: 0, creditLimit: 5000, maxPages: 500 });
  });

  it('reads every page of a Shopify shop, its products from products.json, and accounts for every address', async () => {
    t.deps.config.references = { firecrawlApiKey: 'fc-test', figmaToken: 'figma-test-token', readsPerMonth: 6, creditsPerMonth: 1000, maxPagesPerRead: 50 };
    const r = await read({ url: 'https://example.com' });
    expect(r.statusCode).toBe(1);
    const b = r.bundle;
    expect(b).toMatchObject({ title: 'Example Co', platform: 'shopify' });
    expect(b.design).toMatchObject({ colors: { primary: '#1D4ED8' }, fonts: { heading: 'Fraunces', body: 'Inter' }, fontSizes: { h1: '56px' }, radius: '8px', logo: 'https://example.com/logo.svg' });
    // The home page whole (menus, brand, phone picture); every other page its main content, a product format and a full-page picture.
    const homeScrape = scraped.find((s) => s.url === 'https://example.com/' && s.options.formats.includes('branding'))!;
    expect(homeScrape.options).toMatchObject({ onlyMainContent: false, proxy: 'auto', blockAds: true });
    expect(scraped.some((s) => s.options.mobile === true)).toBe(true);
    expect(b.pages[0]).toMatchObject({ url: 'https://example.com/', mobileScreenshot: 'https://shots.example/1.png', links: ['https://example.com/about', 'https://example.com/contact'] });
    const crawl = crawls.at(-1)!;
    expect(crawl.options).toMatchObject({ sitemap: 'include', crawlEntireDomain: true, ignoreQueryParameters: true, deduplicateSimilarURLs: true, limit: 49 });
    expect(crawl.options.scrapeOptions).toMatchObject({ onlyMainContent: true, proxy: 'auto', formats: expect.arrayContaining(['product', { type: 'screenshot', fullPage: true }]) });
    expect(crawl.options.excludePaths).toEqual(expect.arrayContaining(['^/products/.+', '^/products/walker/?$']));
    expect(crawl.options.excludePaths).toEqual(expect.arrayContaining(['^/collections/[^/]+/?$']));
    // The crawl reached three pages; the batch read what the map found that it didn't (the FAQ) and one product and
    // one collection for their look; then the page Firecrawl timed out on got one more try.
    expect(batches.at(-2)).toEqual(['https://example.com/products/runner', 'https://example.com/pages/faq', 'https://example.com/collections/shoes']);
    expect(batches.at(-1)).toEqual(['https://example.com/slow']);
    expect(b.pages.map((p: any) => p.url)).toEqual(['https://example.com/', 'https://example.com/about', 'https://example.com/services/roofing', 'https://example.com/products/runner', 'https://example.com/pages/faq', 'https://example.com/collections/shoes', 'https://example.com/slow']);
    expect(b.pages[1]).toMatchObject({ images: ['https://cdn.example/a.jpg'], mobileScreenshot: null, links: [] });
    expect(b.products.map((p: any) => [p.title, p.url])).toEqual([['Runner', 'https://example.com/products/runner'], ['Walker', 'https://example.com/products/walker']]);
    expect(b.products[1]).toMatchObject({ price: '88.00', compareAtPrice: '99.00', tags: [], variants: [{ title: '10', sku: null, available: false }] });
    expect(b.collections).toEqual([{ title: 'Shoes', handle: 'shoes', description: 'All our shoes' }]);
    expect(entry(r, '/products/walker')).toMatchObject({ status: 'read', via: 'shopify', kind: 'product' });
    expect(entry(r, '/products/runner')).toMatchObject({ status: 'read', via: 'firecrawl', kind: 'product' });
    expect(entry(r, '/cart')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('cart') });
    expect(entry(r, '/logo.png')).toMatchObject({ status: 'skipped', kind: 'file' });
    expect(entry(r, '/missing')).toMatchObject({ status: 'failed', reason: 'the site answered 404' });
    expect(entry(r, '/slow')).toMatchObject({ status: 'read', via: 'firecrawl' });
    expect(entry(r, '/collections/shoes')).toMatchObject({ status: 'read', kind: 'collection' });
    expect(entry(r, '/private')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('robots.txt') });
    expect(b.coverage.urls.some((u: any) => u.url.includes('other.example'))).toBe(false);
    expect(b.coverage).toMatchObject({ found: 12, read: 8, failed: 1, skipped: 3 });
    // Home page, phone picture and map, then a credit a page: 4 crawled (one a 404), 3 in the batch, 1 retried.
    expect(b.coverage.creditsUsed).toBe(11);
    expect(r.creditsUsed).toBe(11);
    expect(r.totals).toEqual({ pages: 7, items: 0, products: 2, urls: 12 });
  });

  it('reads a WordPress site from its REST API: posts and products as data, every page including unlinked ones', async () => {
    const r = await read({ url: 'https://www.wp.example' });
    const b = r.bundle;
    // Read from where www.wp.example redirects to.
    expect(b).toMatchObject({ platform: 'wordpress', source: 'https://wp.example/' });
    expect(crawls.at(-1)!.url).toBe('https://wp.example/');
    expect(b.items).toEqual([
      { kind: 'post', url: 'https://wp.example/2026/01/hello/', title: 'Post 1', text: 'Body 1 & more', date: '2026-01-01T00:00:00', images: ['https://wp.example/feature1.jpg', 'https://wp.example/img1.jpg'] },
      { kind: 'post', url: 'https://wp.example/2026/02/second/', title: 'Post 2', text: 'Body 2 & more', date: '2026-01-01T00:00:00', images: ['https://wp.example/feature2.jpg', 'https://wp.example/img2.jpg'] },
    ]);
    expect(b.products).toEqual([expect.objectContaining({ title: 'Mug', url: 'https://wp.example/shop/mug/', price: '12.50', compareAtPrice: '15.00', type: 'Kitchen', variants: [{ title: 'Default', sku: 'MUG', price: '12.50', compareAtPrice: '15.00', available: true }] })]);
    expect(crawls.at(-1)!.options.excludePaths).toEqual(expect.arrayContaining(['^/2026/02/second/?$']));
    // A page no link points to, one post and one product for their look.
    expect(batches.at(-1)).toEqual(['https://wp.example/2026/01/hello/', 'https://wp.example/shop/mug/', 'https://wp.example/hidden-offer/']);
    expect(entry(r, '/2026/02/second')).toMatchObject({ status: 'read', via: 'wordpress', kind: 'post' });
    expect(entry(r, '/tag/news')).toMatchObject({ status: 'skipped', kind: 'listing' });
    expect(b.notes.join(' ')).toContain('Move a site in');
  });

  it("reads a Squarespace site's collections from ?format=json", async () => {
    const r = await read({ url: 'https://sq.example' });
    const b = r.bundle;
    expect(b.platform).toBe('squarespace');
    expect(b.items.map((i: any) => [i.kind, i.url, i.text])).toEqual([['blog', 'https://sq.example/blog/first-post', 'One'], ['blog', 'https://sq.example/blog/second-post', 'Two']]);
    expect(b.items[0]).toMatchObject({ date: '2026-01-01T00:00:00.000Z', images: ['https://images.sq/1.jpg'] });
    expect(b.collections).toEqual([{ title: 'Blog', handle: 'blog', description: 'News' }]);
    expect(entry(r, '/blog/second-post')).toMatchObject({ status: 'read', via: 'squarespace' });
    // The sitemap is read first, free: a page only it lists is found and read.
    expect(b.coverage).toMatchObject({ sitemaps: ['https://sq.example/sitemap.xml', 'https://sq.example/pages.xml.gz'], fromSitemap: 2 });
    expect(entry(r, '/only-in-sitemap')).toMatchObject({ status: 'read', via: 'firecrawl' });
    expect(b.notes.join(' ')).toContain('The sitemap listed 2 addresses');
  });

  it('stops at maxPages and says which pages were left, and says why a site could not be read', async () => {
    const r = await read({ url: 'https://plain.example', maxPages: 2 });
    expect(r.bundle).toMatchObject({ platform: 'other', products: [], items: [] });
    expect(crawls.at(-1)!.options.limit).toBe(1);
    expect(r.bundle.pages).toHaveLength(2);
    expect(entry(r, '/c')).toMatchObject({ status: 'skipped', reason: 'not read: the 2-page limit of this read was reached' });
    expect(r.bundle.notes.join(' ')).toContain('higher maxPages');
    expect(r.bundle.coverage).toMatchObject({ sitemaps: [], fromSitemap: 0 });
    expect(r.bundle.notes.join(' ')).toContain('no sitemap');
    const broken = await read({ url: 'https://broken.example' });
    expect(broken).toMatchObject({ statusCode: 2, bundle: null, creditsUsed: 1 });
    expect(broken.error).toContain('broken.example');
  });

  it('answers a big bundle a part at a time', async () => {
    const { rows } = await t.pool.query("SELECT id FROM site_references WHERE source = 'https://example.com/' AND status = 1");
    const part = await get(rows[0].id, '&offset=1&limit=2');
    valid('getReference', part);
    expect(part.bundle.pages.map((p: any) => p.url)).toEqual(['https://example.com/about', 'https://example.com/services/roofing']);
    expect(part.bundle.coverage.urls).toHaveLength(2);
    expect(part.totals).toEqual({ pages: 7, items: 0, products: 2, urls: 12 });
    expect((await t.call('GET', `/v1/references?id=${rows[0].id}&limit=0`)).status).toBe(400);
  });

  it('reads a Figma frame in three calls: layers, text, colours, fonts and a picture', async () => {
    figmaCalls.length = 0;
    const read = await done((await (await start({ url: 'https://www.figma.com/design/cBeZphfCqyY75Rlk3VgyW2/KnowBS' })).json()).id);
    valid('getReference', read);
    expect(read.statusCode).toBe(1);
    expect(figmaCalls).toHaveLength(3);
    const b = read.bundle;
    expect(b).toMatchObject({ kind: 'figma', title: 'KnowBS mockup' });
    expect(b.pages).toHaveLength(1);
    expect(b.pages[0]).toMatchObject({ url: 'Home', screenshot: 'https://figma-shots.example/home.png', images: ['https://figma-images.example/photo.jpg'] });
    expect(b.pages[0].sections).toEqual([
      { name: 'Hero', text: ['Grow your business', 'We build websites.'] },
      { name: 'Footer', text: ['Contact us today, we answer every message.'] },
    ]);
    expect(b.design.fonts).toEqual({ heading: 'Fraunces', body: 'Inter', all: ['Inter', 'Fraunces'] });
    expect(b.design.colors).toMatchObject({ background: '#ffffff', textPrimary: '#121212', primary: '#1a4de6' });
    expect(b.design.radius).toBe('12px');
  });

  it('says to share a Figma file it cannot open', async () => {
    const read = await done((await (await start({ url: 'https://www.figma.com/file/MissingFile123/x' })).json()).id);
    expect(read.statusCode).toBe(2);
    expect(read.error).toContain('Share it');
  });

  it('reads an uploaded document and forgets the file', async () => {
    const read = await done((await (await start({ file: { name: 'brief.pdf', data: Buffer.from('We sell roofs.').toString('base64') } })).json()).id);
    expect(read.statusCode).toBe(1);
    expect(read.bundle.pages[0].text).toContain('We sell roofs.');
    const { rows } = await t.pool.query('SELECT upload FROM site_references WHERE id = $1', [read.id]);
    expect(rows[0].upload).toBeNull();
  });

  it('keeps to the monthly reads and credits, not counting failed reads as reads, and to the storefront', async () => {
    const usage = await (await t.call('GET', '/v1/references/usage')).json();
    valid('getReferenceUsage', usage);
    // Shop, WordPress, Squarespace, plain site, Figma frame and document were read; the broken site and missing Figma file failed.
    expect(usage).toMatchObject({ available: true, used: 6, limit: 6 });
    expect(usage.creditsUsed).toBeGreaterThan(11);
    expect((await start({ url: 'https://example.com' })).status).toBe(429);
    t.deps.config.references!.readsPerMonth = 50;
    t.deps.config.references!.creditsPerMonth = usage.creditsUsed;
    const res = await start({ url: 'https://example.com' });
    expect(res.status).toBe(429);
    expect((await res.json()).message ?? '').toContain('credits');
    const other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Other') RETURNING id")).rows[0]!.id;
    const { rows } = await t.pool.query("INSERT INTO site_references (product_id, kind, source) VALUES ($1, 'website', 'https://x.example/') RETURNING id", [other]);
    expect((await t.call('GET', `/v1/references?id=${rows[0].id}`)).status).toBe(404);
  });
});

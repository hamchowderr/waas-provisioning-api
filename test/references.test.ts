// Reading references to build sites from (src/references.ts, docs/references.md): a website (with a Shopify shop's
// products), a Figma file and a document, each into the same bundle. Firecrawl, Figma and the shop are fakes.
// Responses are checked against openapi/waas-provisioning-api.yaml.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAjv, spec } from '../src/openapi.ts';
import { figmaLink, parseReferenceInput, pickPages, startReferences, type ReferenceReaders } from '../src/references.ts';
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
const scraped: Array<{ url: string; formats: unknown }> = [];
const figmaCalls: string[] = [];
let shopIsShopify = true;

const readers: ReferenceReaders = {
  firecrawl: {
    scrape: (async (url: string, options: { formats: unknown }) => {
      scraped.push({ url, formats: options.formats });
      if (url.includes('broken')) throw new Error('Request failed with status 500');
      return {
        markdown: `# Page ${url}`,
        images: ['https://cdn.example/a.jpg', 'https://cdn.example/a.jpg'],
        screenshot: 'https://shots.example/1.png',
        metadata: { title: `Title of ${url}`, sourceURL: url },
        branding: {
          brandName: 'Example Co',
          colorScheme: 'light',
          logo: 'https://example.com/logo.svg',
          colors: { primary: '#1D4ED8', background: '#FFFFFF', textPrimary: '#111827' },
          fonts: [{ family: 'Inter' }],
          typography: { fontFamilies: { primary: 'Inter', heading: 'Fraunces' }, fontSizes: { h1: '56px', body: '16px' } },
          spacing: { borderRadius: 8 },
        },
      };
    }) as any,
    map: (async () => ({
      links: ['https://example.com/', 'https://example.com/about', 'https://example.com/services/roofing', 'https://example.com/cart', 'https://other.example/x', 'https://example.com/logo.png'].map((url) => ({ url })),
    })) as any,
    parse: (async (file: { filename: string; data: Buffer }) => ({ markdown: `# ${file.filename}\n\n${file.data.toString()}`, metadata: { title: 'The brief' } })) as any,
  },
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
  shopFetch: (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (!shopIsShopify) return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/collections.json') return Response.json({ collections: [{ title: 'Shoes', handle: 'shoes', description: '<p>All our shoes</p>' }] });
    return Response.json({
      products:
        url.searchParams.get('page') === '1'
          ? [
              {
                title: 'Runner',
                handle: 'runner',
                body_html: '<p>Light &amp; quick.</p>',
                vendor: 'Example',
                product_type: 'Shoes',
                tags: ['new', 'running'],
                images: [{ src: 'https://cdn.shopify.example/runner.jpg' }],
                variants: [{ title: '9', sku: 'RUN-9', price: '98.00', compare_at_price: null, available: true }],
              },
            ]
          : [],
    });
  }) as typeof fetch,
};

const start = (body: unknown) => t.call('POST', '/v1/references', { body });
const get = async (id: string) => (await t.call('GET', `/v1/references?id=${id}`)).json() as Promise<any>;
const done = (id: string) => waitFor(async () => {
  const r = await get(id);
  return r.statusCode !== 0 && r;
});

beforeAll(async () => {
  t = await setup();
  await startReferences(t.boss, t.pool, readers, { pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5, log: { error: () => {} } });
});
afterAll(async () => t?.close());

describe('reference input', () => {
  it('tells a Figma link, a document link and a website apart', () => {
    expect(figmaLink(new URL('https://www.figma.com/design/cBeZphfCqyY75Rlk3VgyW2/KnowBS?node-id=0-1&t=x'))).toEqual({ key: 'cBeZphfCqyY75Rlk3VgyW2', nodeId: '0:1' });
    expect(figmaLink(new URL('https://example.com/design/cBeZphfCqyY75Rlk3VgyW2'))).toBeNull();
    expect(parseReferenceInput({ url: 'example.com' })).toMatchObject({ kind: 'website', source: 'https://example.com/', maxPages: 5 });
    expect(parseReferenceInput({ url: 'https://example.com/menu.PDF' }).kind).toBe('document');
    expect(parseReferenceInput({ file: { name: 'brief.docx', data: Buffer.from('hi').toString('base64') } })).toMatchObject({ kind: 'document', source: 'brief.docx' });
    for (const bad of [{}, { url: 'ftp://example.com' }, { url: 'https://u:p@example.com' }, { url: 'https://example.com', maxPages: 11 }, { file: { name: 'a.exe', data: 'aGk=' } }, { url: 'https://example.com', file: { name: 'a.pdf', data: 'aGk=' } }]) {
      expect(() => parseReferenceInput(bad)).toThrow();
    }
  });

  it('picks short same-site pages, never carts, files or other sites', () => {
    const links = ['https://example.com/', 'https://www.example.com/about/', 'https://example.com/a/b/c', 'https://example.com/cart', 'https://example.com/x.pdf', 'https://evil.example/'];
    expect(pickPages(new URL('https://example.com/'), links, 5)).toEqual(['https://www.example.com/about/', 'https://example.com/a/b/c']);
  });
});

describe('reading references', () => {
  it('answers 503 until reading is set up, and counts nothing', async () => {
    t.deps.config.references = { readsPerMonth: 5 };
    expect((await start({ url: 'https://example.com' })).status).toBe(503);
    const usage = await (await t.call('GET', '/v1/references/usage')).json();
    valid('getReferenceUsage', usage);
    expect(usage).toMatchObject({ available: false, used: 0, limit: 5 });
  });

  it('reads a Shopify shop: pages, design and products', async () => {
    t.deps.config.references = { firecrawlApiKey: 'fc-test', figmaToken: 'figma-test-token', readsPerMonth: 5 };
    const res = await start({ url: 'https://example.com', maxPages: 3 });
    expect(res.status).toBe(200);
    const started = await res.json();
    valid('startReference', started);
    expect(started).toMatchObject({ kind: 'website', statusCode: 0, bundle: null });
    const read = await done(started.id);
    valid('getReference', read);
    expect(read.statusCode).toBe(1);
    const b = read.bundle;
    expect(b.title).toBe('Example Co');
    expect(b.design).toMatchObject({ colors: { primary: '#1D4ED8' }, fonts: { heading: 'Fraunces', body: 'Inter' }, fontSizes: { h1: '56px' }, radius: '8px', logo: 'https://example.com/logo.svg' });
    expect(b.pages.map((p: any) => p.url)).toEqual(['https://example.com/', 'https://example.com/about', 'https://example.com/services/roofing']);
    expect(b.pages[0].images).toEqual(['https://cdn.example/a.jpg']);
    // Only the home page asks for branding.
    expect(scraped.filter((s) => JSON.stringify(s.formats).includes('branding'))).toHaveLength(1);
    expect(b.products).toEqual([
      { title: 'Runner', handle: 'runner', description: 'Light & quick.', vendor: 'Example', type: 'Shoes', tags: ['new', 'running'], price: '98.00', compareAtPrice: null, images: ['https://cdn.shopify.example/runner.jpg'], variants: [{ title: '9', sku: 'RUN-9', price: '98.00', compareAtPrice: null, available: true }] },
    ]);
    expect(b.collections).toEqual([{ title: 'Shoes', handle: 'shoes', description: 'All our shoes' }]);
  });

  it('reads a site that is not a shop without products, and says why a site could not be read', async () => {
    shopIsShopify = false;
    const plain = await done((await (await start({ url: 'https://plain.example', maxPages: 1 })).json()).id);
    expect(plain.bundle.products).toEqual([]);
    const broken = await done((await (await start({ url: 'https://broken.example' })).json()).id);
    valid('getReference', broken);
    expect(broken).toMatchObject({ statusCode: 2, bundle: null });
    expect(broken.error).toContain('broken.example');
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

  it('keeps to the monthly allowance, not counting failed reads, and to the storefront', async () => {
    const usage = await (await t.call('GET', '/v1/references/usage')).json();
    // Shop, plain site and Figma frame and document were read; the broken site and the missing Figma file failed.
    expect(usage).toMatchObject({ available: true, used: 4, limit: 5 });
    t.deps.config.references!.readsPerMonth = 4;
    expect((await start({ url: 'https://example.com' })).status).toBe(429);
    const other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Other') RETURNING id")).rows[0]!.id;
    const { rows } = await t.pool.query("INSERT INTO site_references (product_id, kind, source) VALUES ($1, 'website', 'https://x.example/') RETURNING id", [other]);
    expect((await t.call('GET', `/v1/references?id=${rows[0].id}`)).status).toBe(404);
  });
});

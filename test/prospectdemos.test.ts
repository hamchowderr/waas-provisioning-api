// Branded prospect demos (src/prospectdemos.ts, docs/prospect-demos.md): the admin's list, the job that reads each
// website once with Firecrawl and copies its images, and the public routes the demo page reads. Firecrawl and the image
// downloads are fakes. Responses are validated against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAjv } from '../src/openapi.ts';
import { startProspectDemos, type ProspectReaders } from '../src/prospectdemos.ts';
import { setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');
const valid = (name: string, value: unknown) => {
  const validate = ajv.compile({ $ref: `admin#/components/schemas/${name}` });
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
};

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
const scraped: Array<{ url: string; options: any }> = [];
const downloads: string[] = [];
/** What each fake site shows; a site missing here fails to read. */
const sites: Record<string, { json: unknown; logo: string }> = {
  'https://boba.example/': {
    logo: 'https://cdn.example/boba-logo.png',
    json: {
      name: 'Boba Example',
      tagline: 'Tea, made fresh',
      about: 'A tea shop in San Francisco.',
      phone: '415-555-0100',
      city: 'San Francisco',
      hours: ['Mon-Sun 11am-9pm'],
      items: [
        { name: 'Classic Milk Tea', description: 'Black tea and milk', price: null, image: '/img/classic.jpg' },
        { name: 'Matcha Latte', description: null, price: '$6.50', image: 'https://cdn.example/not-an-image.txt' },
        { name: '' },
      ],
      photos: ['https://cdn.example/shop.jpg', 'javascript:alert(1)'],
      platform: null,
      features: ['shop', 'blog', 'made-up'],
    },
  },
  'https://chamber.example/': { logo: 'https://cdn.example/chamber.svg', json: { name: 'Example Chamber', items: [{ name: 'Leads Lunch', description: 'Second Wednesday, 11:30' }] } },
};
let version = 1;

const firecrawl = {
  scrape: async (url: string, options: any) => {
    scraped.push({ url, options });
    const site = sites[url];
    if (!site) throw new Error('Request failed with status 500');
    return {
      json: site.json,
      links: url.includes('chamber') ? ['https://chamber.example/events/', 'https://chamber.example/join', 'https://chamber.example/about'] : [],
      branding: { brandName: 'From branding', logo: site.logo, colorScheme: 'light', colors: { primary: '#272727', accent: '#83B3BE' }, typography: { fontFamilies: { primary: 'Poppins' } } },
      metadata: { sourceURL: url, creditsUsed: 5, ogImage: `https://cdn.example/og-${version}.jpg`, generator: url.includes('boba') ? 'Wix.com Website Builder' : undefined },
    } as any;
  },
};

const fetchImage: typeof fetch = async (input) => {
  const url = String(input);
  downloads.push(url);
  if (url === 'https://api.fontsource.org/v1/fonts/poppins') {
    const variant = (w: number) => ({ normal: { latin: { url: { woff2: `https://cdn.example/poppins-${w}.woff2` } } } });
    return Response.json({ family: 'Poppins', category: 'sans-serif', weights: [300, 600], variants: { 300: variant(300), 600: variant(600) } });
  }
  if (url.endsWith('.woff2')) return new Response(new Uint8Array([9, version]), { headers: { 'content-type': 'font/woff2' } });
  if (url.endsWith('.txt')) return new Response('text', { headers: { 'content-type': 'text/plain' } });
  if (url.endsWith('.svg')) return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } });
  return new Response(new Uint8Array([1, 2, 3, version]), { headers: { 'content-type': 'image/jpeg; charset=binary' } });
};

const add = (prospects: unknown[]) => t.call('POST', '/admin/prospect-demos', { auth: ADMIN, body: { prospects } });
const get = async (id: string) => (await t.call('GET', `/admin/prospect-demos/${id}`, { auth: ADMIN })).json() as Promise<any>;
const settled = (id: string) => waitFor(async () => ((await get(id)).statusCode !== 0 ? get(id) : null));

beforeAll(async () => {
  t = await setup();
  await startProspectDemos(t.boss, t.pool, t.provisioner, { firecrawl: firecrawl as unknown as NonNullable<ProspectReaders['firecrawl']>, download: fetchImage }, { pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5, log: { error: () => {} } });
});
afterAll(() => t.close());

describe('prospect demos', () => {
  let boba: any;
  let chamber: any;

  it('is for the platform admin only', async () => {
    expect((await t.call('GET', '/admin/prospect-demos')).status).toBe(403);
    expect((await add([{ company: 'X', route: 'nope', siteType: 'website' }])).status).toBe(400);
    expect((await add([{ company: 'X', route: 'seller' }])).status).toBe(400);
    expect((await add([])).status).toBe(400);
  });

  it('adds businesses, skips a website already on the list and reads each website', async () => {
    const res = await add([
      { company: 'Boba Example', website: 'boba.example', route: 'affiliate', siteType: 'online-store', kit: 'parcel', label: 'Point of sale', city: 'San Francisco', priority: 2, notes: 'Our own note' },
      { company: 'Example Chamber', website: 'https://chamber.example', route: 'chamber', siteType: 'everything', kit: 'commons' },
      { company: 'No Site Co', route: 'owner', siteType: 'website' },
      { company: 'Boba again', website: 'https://BOBA.example/', route: 'seller', siteType: 'website' },
    ]);
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.created.map((d: any) => d.company)).toEqual(['Boba Example', 'Example Chamber', 'No Site Co']);
    expect(body.skipped).toEqual([{ company: 'Boba again', reason: 'A prospect with this website is already on the list' }]);
    for (const d of body.created) valid('ProspectDemo', d);
    expect(body.created[2]).toMatchObject({ statusCode: 2, error: 'No website to read' });
    expect(body.created[0].code).toMatch(/^p_[A-Za-z0-9_-]{16}$/);

    boba = await settled(body.created[0].id);
    chamber = await settled(body.created[1].id);
    valid('ProspectDemo', boba);
    expect(boba.statusCode).toBe(1);
    expect(boba.creditsUsed).toBe(5);
    expect(scraped[0]!.options.formats[0]).toBe('branding');
    expect(scraped[0]!.options.formats[1]).toBe('links');
    expect(scraped[0]!.options.formats[2]).toMatchObject({ type: 'json' });
    const base = `http://localhost/demos/prospects/${boba.code}/files`;
    expect(boba.brand).toMatchObject({
      name: 'Boba Example',
      tagline: 'Tea, made fresh',
      colors: { primary: '#272727', accent: '#83B3BE' },
      site: { platform: 'Wix', features: ['shop', 'blog'] },
      fonts: { heading: 'Poppins', body: 'Poppins' },
      logo: `${base}/logo.jpg`,
      photos: [`${base}/photo-1.jpg`, `${base}/photo-2.jpg`],
      // Open-licence fonts are copied, regular and bold, at the nearest weights the font has.
      fontFaces: [
        { family: 'Poppins', category: 'sans-serif', weight: 400, file: `${base}/font-1-400.woff2` },
        { family: 'Poppins', category: 'sans-serif', weight: 700, file: `${base}/font-1-700.woff2` },
      ],
    });
    expect(downloads).toContain('https://cdn.example/poppins-300.woff2');
    expect(downloads).toContain('https://cdn.example/poppins-600.woff2');
    // Prices only where the site printed one; an item without a name is dropped; a picture that isn't an image is left out.
    expect(boba.brand.items).toEqual([
      { name: 'Classic Milk Tea', description: 'Black tea and milk', price: null, image: `${base}/item-1.jpg` },
      { name: 'Matcha Latte', description: null, price: '$6.50', image: null },
    ]);
    expect(downloads).toContain('https://boba.example/img/classic.jpg');
    expect(downloads.some((d) => d.startsWith('javascript:'))).toBe(false);
    expect([...t.provisioner.prospectFiles.keys()].filter((k) => k.startsWith(boba.code)).sort()).toEqual(
      ['logo.jpg', 'photo-1.jpg', 'photo-2.jpg', 'item-1.jpg', 'font-1-400.woff2', 'font-1-700.woff2'].map((n) => `${boba.code}/${n}`).sort(),
    );
    // What the site has, from where its links point when the reader didn't say.
    expect(chamber.brand.site).toEqual({ platform: null, features: ['events', 'members'] });
    expect(chamber.brand.logo).toMatch(/\/logo\.svg$/);
    expect(chamber.brand.items[0]).toEqual({ name: 'Leads Lunch', description: 'Second Wednesday, 11:30', price: null, image: null });
  });

  it('answers the demo page with the settings and files only, by code', async () => {
    const res = await t.call('GET', `/demos/prospects/${boba.code}`, { auth: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    const demo: any = await res.json();
    valid('PublicProspectDemo', demo);
    expect(demo).toMatchObject({ company: 'Boba Example', route: 'affiliate', siteType: 'online-store', kit: 'parcel' });
    expect(JSON.stringify(demo)).not.toContain('Our own note');
    expect(demo).not.toHaveProperty('priority');

    const file = await t.call('GET', `/demos/prospects/${boba.code}/files/logo.jpg`, { auth: null });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    expect(file.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 1]);
    const font = await t.call('GET', `/demos/prospects/${boba.code}/files/font-1-700.woff2`, { auth: null });
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(font.headers.get('access-control-allow-origin')).toBe('*');
    const svg = await t.call('GET', `/demos/prospects/${chamber.code}/files/logo.svg`, { auth: null });
    expect(svg.headers.get('content-security-policy')).toContain("default-src 'none'");

    for (const path of ['/demos/prospects/p_nope', `/demos/prospects/${boba.code}/files/../logo.jpg`, `/demos/prospects/${boba.code}/files/item-9.jpg`]) {
      expect((await t.call('GET', path, { auth: null })).status).toBe(404);
    }
  });

  it('changes a route, refuses a new website, and reads a site again', async () => {
    const res = await t.call('PATCH', `/admin/prospect-demos/${boba.id}`, { auth: ADMIN, body: { route: 'seller', kit: null } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ route: 'seller', kit: null, company: 'Boba Example' });
    expect((await t.call('PATCH', `/admin/prospect-demos/${boba.id}`, { auth: ADMIN, body: { website: 'https://new.example' } })).status).toBe(400);

    version = 2;
    (sites['https://boba.example/']!.json as any).items = [];
    const again = await t.call('POST', `/admin/prospect-demos/${boba.id}/gather`, { auth: ADMIN });
    expect(again.status).toBe(202);
    const read = await settled(boba.id);
    expect(read.creditsUsed).toBe(10);
    expect(read.brand.items).toEqual([]);
    // The item picture no longer used is removed; the rest are replaced.
    expect(t.provisioner.prospectFiles.has(`${boba.code}/item-1.jpg`)).toBe(false);
    expect([...t.provisioner.prospectFiles.get(`${boba.code}/logo.jpg`)!]).toEqual([1, 2, 3, 2]);
  });

  it('says why a website could not be read', async () => {
    const res = await add([{ company: 'Broken', website: 'https://broken.example', route: 'owner', siteType: 'website' }]);
    const broken = await settled(((await res.json()) as any).created[0].id);
    expect(broken).toMatchObject({ statusCode: 2, error: "broken.example couldn't be read: Request failed with status 500", brand: null });
    expect((await t.call('GET', `/demos/prospects/${broken.code}`, { auth: null })).status).toBe(404);
  });

  it('removes a prospect with its files', async () => {
    expect((await t.call('DELETE', `/admin/prospect-demos/${chamber.id}`, { auth: ADMIN })).status).toBe(204);
    expect([...t.provisioner.prospectFiles.keys()].some((k) => k.startsWith(chamber.code))).toBe(false);
    expect((await t.call('GET', `/demos/prospects/${chamber.code}`, { auth: null })).status).toBe(404);
    expect((await t.call('GET', `/admin/prospect-demos/${chamber.id}`, { auth: ADMIN })).status).toBe(404);
    const list: any = await (await t.call('GET', '/admin/prospect-demos', { auth: ADMIN })).json();
    expect(list.map((d: any) => d.company)).toEqual(['Boba Example', 'Broken', 'No Site Co']);
  });
});

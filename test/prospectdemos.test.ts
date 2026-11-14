// The Sales Kit's prospects (src/prospectdemos.ts, docs/prospect-demos.md): a storefront's list, the job that reads
// each website once with Firecrawl, checks it and copies its images, the monthly read allowance, and the public routes
// the demo page reads. Firecrawl, the page timing and the downloads are fakes. Responses are validated against
// openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAjv } from '../src/openapi.ts';
import { claimPlatformProspects, siteTypeFor, startProspectDemos, type ProspectReaders } from '../src/prospectdemos.ts';
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
      rawHtml: url.includes('boba')
        ? '<html><head><title>Boba Example tea shop</title><meta name="viewport" content="width=device-width"><meta name="generator" content="Wix.com Website Builder"></head><body><h1>Tea</h1><a href="tel:4155550100">Call</a> Order online: add to cart <footer>&copy; 2026</footer></body></html>'
        : '<html><head><title>Chamber</title></head><body><p>&copy; 2019</p></body></html>',
      metadata: { sourceURL: url, statusCode: 200, creditsUsed: 5, ogImage: `https://cdn.example/og-${version}.jpg`, generator: url.includes('boba') ? 'Wix.com Website Builder' : undefined },
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

/** Our own timed request for the page: boba answers quickly and sends http to https; chamber turns us away. */
const page: typeof fetch = async (input) => {
  const url = String(input);
  if (url.startsWith('http://')) return new Response(null, { status: 301, headers: { location: url.replace('http://', 'https://') } });
  if (url.includes('chamber')) return new Response('no', { status: 403 });
  return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
};

const demos = () => `/admin/products/${t.productId}/prospects/demos`;
const add = (prospects: unknown[]) => t.call('POST', demos(), { auth: ADMIN, body: { prospects } });
const get = async (id: string) => (await t.call('GET', `${demos()}/${id}`, { auth: ADMIN })).json() as Promise<any>;
const settled = (id: string) => waitFor(async () => ((await get(id)).statusCode !== 0 ? get(id) : null));

beforeAll(async () => {
  t = await setup();
  t.deps.config.prospects = { searchesPerMonth: 10, readsPerMonth: 4 };
  await startProspectDemos(t.boss, t.pool, t.provisioner, { firecrawl: firecrawl as unknown as NonNullable<ProspectReaders['firecrawl']>, download: fetchImage, page }, { pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5, log: { error: () => {} } });
});
afterAll(() => t.close());

describe('prospect demos', () => {
  let boba: any;
  let chamber: any;

  it("is the dashboard's, for the storefront's people", async () => {
    // A store API key is not a person: the Sales Kit is the dashboard's.
    expect((await t.call('GET', demos())).status).toBe(403);
    expect((await t.call('GET', `/admin/products/${t.productId}0/prospects/demos`, { auth: ADMIN })).status).toBe(404);
    expect((await add([{ company: 'X', route: 'nope', siteType: 'website' }])).status).toBe(400);
    expect((await add([{ website: 'x.example' }])).status).toBe(400);
    expect((await add([{ company: 'X', details: 'nope' }])).status).toBe(400);
    expect((await add([])).status).toBe(400);
  });

  it('adds businesses, skips a website already on the list and reads each website', async () => {
    const res = await add([
      { company: 'Boba Example', website: 'boba.example', route: 'affiliate', siteType: 'online-store', kit: 'parcel', label: 'Point of sale', city: 'San Francisco', priority: 2, notes: 'Our own note' },
      // From the prospect finder: no site type, so the read picks it from what their website has.
      { company: 'Example Chamber', website: 'https://chamber.example', placeId: 'place-chamber', details: { phone: '555-0100', email: 'Hello@Chamber.example', socials: [{ network: 'facebook', url: 'https://facebook.com/chamber' }], rating: 9 } },
      { company: 'No Site Co', route: 'owner', siteType: 'website' },
      { company: 'Boba again', website: 'https://BOBA.example/', route: 'seller', siteType: 'website' },
    ]);
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.created.map((d: any) => d.company)).toEqual(['Boba Example', 'Example Chamber', 'No Site Co']);
    expect(body.skipped).toEqual([{ company: 'Boba again', reason: 'This website is on your list already' }]);
    expect(body.reads).toMatchObject({ used: 2, limit: 4 });
    expect(body.created[1]).toMatchObject({ route: 'owner', siteType: 'website', siteTypeAuto: true, placeId: 'place-chamber' });
    // What the finder found is kept, cleaned (a rating out of range is left out).
    expect(body.created[1].details).toMatchObject({ phone: '555-0100', email: 'hello@chamber.example', rating: null, socials: [{ network: 'facebook', url: 'https://facebook.com/chamber' }] });
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
    expect(scraped[0]!.options.formats[2]).toBe('rawHtml');
    expect(scraped[0]!.options.formats[3]).toMatchObject({ type: 'json' });
    expect(boba.demoUrl).toBe(`https://app.anypress.io/demo/${t.productId}?for=${boba.code}`);
    // The website check ran on the same page: a quick, secure, phone-ready site with a way to order.
    expect(boba.report).toMatchObject({ host: 'boba.example', builder: 'Wix' });
    const check = (r: any, id: string) => r.report.checks.find((c: any) => c.id === id)?.status;
    expect([check(boba, 'secure'), check(boba, 'speed'), check(boba, 'mobile'), check(boba, 'contact'), check(boba, 'online'), check(boba, 'fresh')]).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
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
    // What the site has, from where its links point when the reader didn't say; its demo shows a community site.
    expect(chamber.brand.site).toEqual({ platform: null, features: ['events', 'members'] });
    expect(chamber).toMatchObject({ siteType: 'community', siteTypeAuto: true });
    // A site that turns our own request away isn't scored on speed; an old footer and no viewport are.
    expect(chamber.report.checks.map((c: any) => c.id)).not.toContain('speed');
    expect([check(chamber, 'mobile'), check(chamber, 'fresh')]).toEqual(['fail', 'fail']);
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
    expect(demo).toMatchObject({ company: 'Boba Example', productId: t.productId, route: 'affiliate', siteType: 'online-store', kit: 'parcel' });
    expect(demo).not.toHaveProperty('report');
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
    const res = await t.call('PATCH', `${demos()}/${boba.id}`, { auth: ADMIN, body: { route: 'seller', kit: null } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ route: 'seller', kit: null, company: 'Boba Example' });
    expect((await t.call('PATCH', `${demos()}/${boba.id}`, { auth: ADMIN, body: { website: 'https://new.example' } })).status).toBe(400);
    // Picking a site type keeps it from then on.
    expect(await (await t.call('PATCH', `${demos()}/${chamber.id}`, { auth: ADMIN, body: { siteType: 'everything' } })).json()).toMatchObject({ siteType: 'everything', siteTypeAuto: false });

    version = 2;
    (sites['https://boba.example/']!.json as any).items = [];
    const again = await t.call('POST', `${demos()}/${boba.id}/read`, { auth: ADMIN });
    expect(again.status).toBe(202);
    const read = await settled(boba.id);
    expect(read.creditsUsed).toBe(10);
    expect(read.brand.items).toEqual([]);
    // The item picture no longer used is removed; the rest are replaced.
    expect(t.provisioner.prospectFiles.has(`${boba.code}/item-1.jpg`)).toBe(false);
    expect([...t.provisioner.prospectFiles.get(`${boba.code}/logo.jpg`)!]).toEqual([1, 2, 3, 2]);
  });

  it('stops reading when the month\'s reads are used, and says so', async () => {
    // Boba twice and chamber: the fourth read is the last this month.
    const fifth = await add([{ company: 'Fifth', website: 'https://fifth.example' }]);
    expect(((await fifth.json()) as any).reads).toMatchObject({ used: 4, limit: 4 });
    const sixth: any = await (await add([{ company: 'Sixth', website: 'https://sixth.example' }])).json();
    expect(sixth.created[0]).toMatchObject({ statusCode: 2, error: "This month's 4 website reads are used. They start again on the 1st." });
    expect((await t.call('POST', `${demos()}/${sixth.created[0].id}/read`, { auth: ADMIN })).status).toBe(429);
    const usage: any = await (await t.call('GET', `/admin/products/${t.productId}/prospects/usage`, { auth: ADMIN })).json();
    valid('ProspectUsage', usage);
    expect(usage.reads).toMatchObject({ used: 4, limit: 4 });
    await settled(((await (await t.call('GET', demos(), { auth: ADMIN })).json()) as any).prospects.find((p: any) => p.company === 'Fifth').id);
  });

  it('says why a website could not be read', async () => {
    t.deps.config.prospects = { searchesPerMonth: 10, readsPerMonth: 50 };
    const res = await add([{ company: 'Broken', website: 'https://broken.example', route: 'owner', siteType: 'website' }]);
    const broken = await settled(((await res.json()) as any).created[0].id);
    expect(broken).toMatchObject({ statusCode: 2, error: "broken.example couldn't be read: Request failed with status 500", brand: null });
    expect((await t.call('GET', `/demos/prospects/${broken.code}`, { auth: null })).status).toBe(404);
  });

  it("sends the demo link, website score and platform to the seller's HighLevel", async () => {
    const posted: any[] = [];
    t.deps.crmFetch = (async (_url: unknown, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const crm = `/admin/products/${t.productId}/prospects/crm`;
    expect((await t.call('PUT', `${crm}/highlevel`, { auth: ADMIN, body: { webhook: 'https://services.leadconnectorhq.com/hooks/loc/webhook-trigger/abc' } })).status).toBe(200);
    // Matched by the finder's id, or by the website for a business added from a list.
    const res = await t.call('POST', crm, { auth: ADMIN, body: { targets: ['highlevel'], prospects: [{ id: 'place-chamber', name: 'Example Chamber' }, { id: 'list-1', name: 'Boba', website: 'https://www.boba.example/menu' }, { id: 'x', name: 'Unread' }] } });
    expect(res.status).toBe(200);
    const by = (id: string) => posted.find((p) => p.prospectId === id);
    expect(by('place-chamber')).toMatchObject({ demoLink: `https://app.anypress.io/demo/${t.productId}?for=${chamber.code}`, websitePlatform: '' });
    expect(by('place-chamber').websiteScore).toBe(chamber.report.score);
    expect(by('list-1')).toMatchObject({ demoLink: `https://app.anypress.io/demo/${t.productId}?for=${boba.code}`, websiteScore: boba.report.score, websitePlatform: 'Wix' });
    expect(by('x')).toMatchObject({ demoLink: '', websiteScore: '', websitePlatform: '' });
  });

  it("gives AnyPress's own list its old prospects, demos on anypress.io and no read allowance", async () => {
    await t.pool.query("INSERT INTO prospect_demos (code, company, website, route, site_type, status) VALUES ('p_oldoldoldoldoldo1', 'Old One', 'https://old.example/', 'chamber', 'everything', 1)");
    await claimPlatformProspects(t.pool, t.productId);
    t.deps.config.storeTemplateProductId = t.productId;
    try {
      const list: any = await (await t.call('GET', demos(), { auth: ADMIN })).json();
      expect(list.reads.limit).toBeNull();
      expect(list.prospects.find((p: any) => p.company === 'Old One').demoUrl).toBe('https://anypress.io/try?for=p_oldoldoldoldoldo1');
    } finally {
      t.deps.config.storeTemplateProductId = undefined;
    }
  });

  it('picks the closest site type to what their website has', () => {
    expect(siteTypeFor([])).toBe('website');
    expect(siteTypeFor(['blog', 'events'])).toBe('website');
    expect(siteTypeFor(['shop'])).toBe('online-store');
    expect(siteTypeFor(['bookings'])).toBe('bookings');
    expect(siteTypeFor(['events', 'members'])).toBe('community');
    expect(siteTypeFor(['shop', 'bookings'])).toBe('everything');
  });

  it('removes a prospect with its files', async () => {
    expect((await t.call('DELETE', `${demos()}/${chamber.id}`, { auth: ADMIN })).status).toBe(204);
    expect([...t.provisioner.prospectFiles.keys()].some((k) => k.startsWith(chamber.code))).toBe(false);
    expect((await t.call('GET', `/demos/prospects/${chamber.code}`, { auth: null })).status).toBe(404);
    expect((await t.call('GET', `${demos()}/${chamber.id}`, { auth: ADMIN })).status).toBe(404);
    const list: any = await (await t.call('GET', demos(), { auth: ADMIN })).json();
    expect(list.prospects.map((d: any) => d.company)).toEqual(['Boba Example', 'Old One', 'Broken', 'Sixth', 'Fifth', 'No Site Co']);
  });
});

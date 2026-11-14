// Branded demos for businesses AnyPress may contact (docs/prospect-demos.md). The platform admin adds a business (its
// name, website, route and the site type its demo shows); a job reads the website once with Firecrawl (its official
// SDK: the brand's colours, fonts and logo, and what the business offers) and copies the logo and a few photos into
// object storage, since other sites' images often can't be loaded from a demo page and links change. The demo on
// anypress.io/try?for=<code> reads the result from the public routes below: nothing is built on the server, the demo
// runs on WordPress Playground in the visitor's browser like every other /try demo.
import { randomBytes } from 'node:crypto';
import type { Document, Firecrawl } from '@mendable/firecrawl-js';
import { Hono, type Context } from 'hono';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { AppEnv, Deps } from './app.ts';
import type { Pool } from './db.ts';
import { SITE_TYPES } from './demodrafts.ts';
import { badRequest, HttpError } from './errors.ts';
import { isUuid, readJson } from './http.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import { publicFetchUpTo } from './publicfetch.ts';
import { ensureQueue, NOTIFY_POLL_SECONDS } from './queue.ts';
import { designFromBranding } from './referencesite.ts';
import { Status } from './status.ts';

const QUEUE = 'prospect-demos';
/** What the demo shows: a client's shop (seller), one location (reseller), a customer's site (affiliate), their own site. */
const ROUTES = ['seller', 'reseller', 'affiliate', 'chamber', 'owner'] as const;
const KIT = /^[a-z][a-z0-9-]{0,39}$/;
const CODE = /^p_[A-Za-z0-9_-]{16}$/;
const FILE = /^((logo|photo-[1-4]|item-[1-8])\.(png|jpg|webp|gif|svg)|font-[12]-(400|700)\.woff2)$/;
const MAX_IMPORT = 200;
const MAX_FILE = 5 * 1024 ** 2;
const MAX_ITEMS = 8;
const MAX_PHOTOS = 4;
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const FILE_TYPES: Record<string, string> = { ...Object.fromEntries(Object.entries(IMAGE_TYPES).map(([type, ext]) => [ext, type])), woff2: 'font/woff2' };
/** Open-licence fonts by name, with their files (fontsource.org; it has no official client, so this is a plain GET). */
const FONTSOURCE = 'https://api.fontsource.org/v1/fonts/';
const FONT_WEIGHTS = [400, 700] as const;

/** What the job keeps from the website. Images are file names here and links in every answer. */
interface ProspectBrand {
  source: string;
  name: string | null;
  tagline: string | null;
  about: string | null;
  phone: string | null;
  city: string | null;
  address: string | null;
  hours: string[];
  colors: Record<string, string>;
  fonts: { heading: string | null; body: string | null };
  /** What their website is now: the builder it runs on and what it has (shop, bookings, events, members, blog, donations). */
  site?: { platform: string | null; features: (typeof SITE_FEATURES)[number][] };
  /** The heading and body fonts' files, copied when the font is open-licence (Google Fonts and the like); otherwise none. */
  fontFaces?: { family: string; category: string; weight: number; file: string }[];
  colorScheme: 'light' | 'dark' | null;
  logo: string | null;
  photos: string[];
  /** What the business sells or offers. A price only when the website prints one, word for word. */
  items: { name: string; description: string | null; price: string | null; image: string | null }[];
}

const FIELDS = { company: 200, website: 2000, kit: 40, label: 100, city: 100, notes: 4000 } as const;

interface ProspectInput {
  company?: string;
  website?: string | null;
  route?: (typeof ROUTES)[number];
  siteType?: string;
  kit?: string | null;
  label?: string | null;
  city?: string | null;
  priority?: number | null;
  notes?: string | null;
}

function optionalText(body: Record<string, unknown>, name: keyof typeof FIELDS): string | null | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > FIELDS[name]) throw badRequest(`${name} must be text of up to ${FIELDS[name]} characters`);
  return value.trim() || null;
}

function websiteOf(value: string | null | undefined): string | null | undefined {
  if (!value) return value;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw badRequest('website is not a web address');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw badRequest('website must be an http or https address');
  return url.toString();
}

function oneOf<T extends string>(value: unknown, list: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (!list.includes(value as T)) throw badRequest(`${name} must be one of: ${list.join(', ')}`);
  return value as T;
}

function kitOf(body: Record<string, unknown>) {
  const kit = optionalText(body, 'kit');
  if (kit && !KIT.test(kit)) throw badRequest('kit must be a kit slug, such as parcel');
  return kit;
}

function priorityOf(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100) throw badRequest('priority must be a whole number from 0 to 100');
  return value as number;
}

/** Checks one business. `whole` asks for everything a new one needs. */
function parseProspect(raw: unknown, whole: boolean): ProspectInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Each prospect must be an object');
  const body = raw as Record<string, unknown>;
  const input: ProspectInput = {
    company: optionalText(body, 'company') ?? undefined,
    website: websiteOf(optionalText(body, 'website')),
    route: oneOf(body.route, ROUTES, 'route'),
    siteType: oneOf(body.siteType, SITE_TYPES, 'siteType'),
    kit: kitOf(body),
    label: optionalText(body, 'label'),
    city: optionalText(body, 'city'),
    priority: priorityOf(body.priority),
    notes: optionalText(body, 'notes'),
  };
  if (whole && !(input.company && input.route && input.siteType)) throw badRequest('Each prospect needs company, route and siteType');
  return input;
}

type Row = {
  id: string;
  code: string;
  company: string;
  website: string | null;
  route: string;
  site_type: string;
  kit: string | null;
  label: string | null;
  city: string | null;
  priority: number | null;
  notes: string | null;
  status: number;
  brand: ProspectBrand | null;
  error: string | null;
  credits_used: number;
  date_created: Date;
  date_gathered: Date | null;
};

const fileUrl = (base: string, code: string) => (name: string | null) => (name ? `${base}/demos/prospects/${code}/files/${name}` : null);

/** The brand with its file names turned into links anyone can load. */
function brandOut(base: string, code: string, brand: ProspectBrand | null) {
  if (!brand) return null;
  const url = fileUrl(base, code);
  return { ...brand, fontFaces: (brand.fontFaces ?? []).map((f) => ({ ...f, file: url(f.file)! })), logo: url(brand.logo), photos: brand.photos.map((p) => url(p)!), items: brand.items.map((i) => ({ ...i, image: url(i.image) })) };
}

function demoOut(base: string, r: Row) {
  return {
    id: r.id,
    code: r.code,
    company: r.company,
    website: r.website,
    route: r.route,
    siteType: r.site_type,
    kit: r.kit,
    label: r.label,
    city: r.city,
    priority: r.priority,
    notes: r.notes,
    statusCode: r.status,
    error: r.error,
    creditsUsed: r.credits_used,
    brand: brandOut(base, r.code, r.brand),
    createdAt: r.date_created.toISOString(),
    gatheredAt: r.date_gathered ? r.date_gathered.toISOString() : null,
  };
}

async function findDemo(pool: Pool, id: string): Promise<Row> {
  const { rows } = isUuid(id) ? await pool.query<Row>('SELECT * FROM prospect_demos WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new HttpError(404, 'No prospect demo with this id');
  return rows[0];
}

const queueGather = (boss: PgBoss, id: string) => boss.send(QUEUE, { id }, { retryLimit: 0, expireInSeconds: 600 });

/** Saves one new business, or answers null when its website is on the list already. */
async function insertProspect(pool: Pool, p: ProspectInput): Promise<Row | null> {
  const website = p.website ?? null;
  const values = [p.kit, p.label, p.city, p.priority, p.notes].map((v) => v ?? null);
  const { rows } = await pool.query<Row>(
    `INSERT INTO prospect_demos (code, company, website, route, site_type, status, error, kit, label, city, priority, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (lower(website)) WHERE website IS NOT NULL DO NOTHING RETURNING *`,
    [`p_${randomBytes(12).toString('base64url')}`, p.company, website, p.route, p.siteType, website ? Status.Pending : Status.Failed, website ? null : 'No website to read', ...values],
  );
  return rows[0] ?? null;
}

function prospectList(body: unknown): ProspectInput[] {
  const list = (body as { prospects?: unknown } | null)?.prospects;
  if (!Array.isArray(list) || !list.length || list.length > MAX_IMPORT) throw badRequest(`prospects must be a list of 1 to ${MAX_IMPORT} businesses`);
  return list.map((p) => parseProspect(p, true));
}

async function addProspects(deps: Pick<Deps, 'pool' | 'boss'>, body: unknown) {
  const created: Row[] = [];
  const skipped: { company: string; reason: string }[] = [];
  for (const p of prospectList(body)) {
    const row = await insertProspect(deps.pool, p);
    if (!row) skipped.push({ company: p.company!, reason: 'A prospect with this website is already on the list' });
    else created.push(row);
    if (row?.website) await queueGather(deps.boss, row.id);
  }
  return { created, skipped };
}

async function updateProspect(pool: Pool, id: string, body: unknown): Promise<Row> {
  const input = parseProspect(body, false);
  if ('website' in (body as object)) throw badRequest("A prospect's website can't be changed: remove it and add it again");
  const columns: Record<string, unknown> = { company: input.company, route: input.route, site_type: input.siteType, kit: input.kit, label: input.label, city: input.city, priority: input.priority, notes: input.notes };
  const set = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (set.some(([k, v]) => v === null && k === 'company')) throw badRequest('company is required');
  await findDemo(pool, id);
  if (set.length) await pool.query(`UPDATE prospect_demos SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...set.map(([, v]) => v)]);
  return findDemo(pool, id);
}

/** This API's own address, for the links of a demo's images. */
type BaseOf = (c: Context<AppEnv>) => string;

/** GET, POST, PATCH and DELETE /admin/prospect-demos: the platform admin's list. */
export function adminProspectDemoRoutes(deps: Deps, base: BaseOf) {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const { rows } = await deps.pool.query<Row>('SELECT * FROM prospect_demos ORDER BY priority NULLS LAST, company');
    return c.json(rows.map((r) => demoOut(base(c), r)), 200, { 'Cache-Control': 'no-store' });
  });
  app.post('/', async (c) => {
    const { created, skipped } = await addProspects(deps, await readJson(c));
    return c.json({ created: created.map((r) => demoOut(base(c), r)), skipped }, 201);
  });
  app.get('/:id', async (c) => c.json(demoOut(base(c), await findDemo(deps.pool, c.req.param('id'))), 200, { 'Cache-Control': 'no-store' }));
  app.patch('/:id', async (c) => c.json(demoOut(base(c), await updateProspect(deps.pool, c.req.param('id'), await readJson(c))), 200));
  // Reads the website again, for a site that changed or a read that failed.
  app.post('/:id/gather', async (c) => {
    const row = await findDemo(deps.pool, c.req.param('id'));
    if (!row.website) throw badRequest('This prospect has no website to read');
    await deps.pool.query('UPDATE prospect_demos SET status = $2, error = NULL WHERE id = $1', [row.id, Status.Pending]);
    await queueGather(deps.boss, row.id);
    return c.json(demoOut(base(c), await findDemo(deps.pool, row.id)), 202);
  });
  app.delete('/:id', async (c) => {
    const row = await findDemo(deps.pool, c.req.param('id'));
    const { rows } = await deps.pool.query<{ files: string[] }>('DELETE FROM prospect_demos WHERE id = $1 RETURNING files', [row.id]);
    await deps.provisioner.deleteProspectFiles({ code: row.code, names: rows[0]?.files ?? [] });
    return c.body(null, 204);
  });
  return app;
}

const PUBLIC_HEADERS = { 'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex, nofollow' };

/** GET /demos/prospects/:code and its files: what the demo page reads. Public; the code is the only key. */
export function publicProspectDemoRoutes(deps: Pick<Deps, 'pool' | 'provisioner'>, base: BaseOf) {
  const app = new Hono<AppEnv>();
  const notFound = (c: Context<AppEnv>) => c.json({ statusCode: 404, message: 'Not found' }, 404, { ...PUBLIC_HEADERS, 'Cache-Control': 'no-store' });
  app.get('/:code', async (c) => {
    const code = c.req.param('code');
    const { rows } = CODE.test(code) ? await deps.pool.query<Row>('SELECT * FROM prospect_demos WHERE code = $1 AND status = $2', [code, Status.Done]) : { rows: [] };
    const r = rows[0];
    if (!r) return notFound(c);
    const demo = { company: r.company, route: r.route, siteType: r.site_type, kit: r.kit, brand: brandOut(base(c), r.code, r.brand) };
    return c.json(demo, 200, { ...PUBLIC_HEADERS, 'Cache-Control': 'public, max-age=300' });
  });
  app.get('/:code/files/:name', async (c) => {
    const { code, name } = c.req.param();
    const bytes = CODE.test(code) && FILE.test(name) ? await deps.provisioner.readProspectFile({ code, name }) : null;
    if (!bytes) return notFound(c);
    return c.body(new Uint8Array(bytes), 200, {
      ...PUBLIC_HEADERS,
      'Content-Type': FILE_TYPES[name.split('.').pop()!]!,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Cache-Control': 'public, max-age=86400',
    });
  });
  return app;
}

// --- Reading the website -------------------------------------------------------------------------------------------

/** What the job calls out to; tests replace them. */
export interface ProspectReaders {
  firecrawl?: Pick<Firecrawl, 'scrape'>;
  /** Downloads one image or font file; a GET that never reaches a private address. */
  download?: typeof fetch;
}

const PROMPT = [
  "Read this business's website for a demo of a new website made for it.",
  'name: the business name. tagline: its own one-line slogan, if it has one. about: two or three sentences in its own words.',
  'phone, city, address and opening hours as the site shows them.',
  `items: up to ${MAX_ITEMS} things it sells or offers (products, menu items, services, classes, events or member benefits), each with a short description,`,
  'its price exactly as printed on the site (null when the site shows no price; never guess one), and the link of its picture.',
  `photos: up to ${MAX_PHOTOS} links of large photos of the business, its place, people or work (not icons or logos).`,
  'platform: the website builder it runs on when the page shows it (WordPress, Wix, Squarespace, Shopify, Webflow, GoDaddy, Weebly, Duda, Square Online), else null.',
  'features: which of these the website itself has, only when you can see it on the site:',
  'shop (sells products online with a cart), bookings (books appointments or classes online), events (an events list or calendar),',
  'members (membership, member sign-in or a member directory), blog (news or blog posts), donations (takes donations online).',
].join(' ');

const nullableString = { type: ['string', 'null'] };
const SITE_FEATURES = ['shop', 'bookings', 'events', 'members', 'blog', 'donations'] as const;
/** Builders by what their pages say about themselves (the generator tag), in the name the board shows. */
const PLATFORMS: [RegExp, string][] = [
  [/wordpress|woocommerce|elementor|divi/i, 'WordPress'],
  [/wix/i, 'Wix'],
  [/squarespace/i, 'Squarespace'],
  [/shopify/i, 'Shopify'],
  [/webflow/i, 'Webflow'],
  [/godaddy|websites \+ marketing/i, 'GoDaddy'],
  [/weebly|square online/i, 'Square Online'],
  [/duda/i, 'Duda'],
  [/drupal/i, 'Drupal'],
  [/joomla/i, 'Joomla'],
  [/hubspot/i, 'HubSpot'],
];

/** Where a link on the page points tells us what the site has, alongside what the reader saw. */
const FEATURE_LINKS: [RegExp, (typeof SITE_FEATURES)[number]][] = [
  [/\/(shop|store|cart|products?|collections)(\/|$|\?)|square\.site|shopify|etsy\.com/i, 'shop'],
  [/\/(book|booking|appointments?|schedule)(\/|$|\?)|calendly\.com|acuityscheduling|vagaro|booksy|squareup\.com\/appointments|mindbodyonline|cal\.com/i, 'bookings'],
  [/\/(events?|calendar)(\/|$|\?)|eventbrite|growthzoneapp|chambermaster/i, 'events'],
  [/\/(members?|membership|join|directory|login|my-account)(\/|$|\?)/i, 'members'],
  [/\/(blog|news|articles?)(\/|$|\?)/i, 'blog'],
  [/\/(donate|donations?|give)(\/|$|\?)|givebutter|paypal\.com\/donate/i, 'donations'],
];

/** The features the reader saw, plus the ones the page's links show. */
function featuresOf(doc: Document, found: Extracted) {
  const links = (doc.links ?? []).filter((l): l is string => typeof l === 'string');
  return SITE_FEATURES.filter((f) => (found.features ?? []).includes(f) || FEATURE_LINKS.some(([test, name]) => name === f && links.some((l) => test.test(l))));
}

/** What the site runs on: its generator tag first, then what the reader saw on the page. */
function platformOf(doc: Document, found: Extracted): string | null {
  const said = [doc.metadata?.generator, found.platform].flat().filter((v): v is string => typeof v === 'string');
  for (const text of said) for (const [test, name] of PLATFORMS) if (test.test(text)) return name;
  return str(found.platform, 50);
}
const SCHEMA = {
  type: 'object',
  properties: {
    name: nullableString,
    tagline: nullableString,
    about: nullableString,
    phone: nullableString,
    city: nullableString,
    address: nullableString,
    hours: { type: 'array', items: { type: 'string' } },
    items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: nullableString, price: nullableString, image: nullableString }, required: ['name'] } },
    photos: { type: 'array', items: { type: 'string' } },
    platform: nullableString,
    features: { type: 'array', items: { type: 'string', enum: [...SITE_FEATURES] } },
  },
};

interface Extracted {
  name?: string | null;
  tagline?: string | null;
  about?: string | null;
  phone?: string | null;
  city?: string | null;
  address?: string | null;
  hours?: unknown[];
  items?: { name?: unknown; description?: unknown; price?: unknown; image?: unknown }[];
  photos?: unknown[];
  platform?: unknown;
  features?: unknown[];
}

const str = (value: unknown, max = 500) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** A link on the page made absolute, or null for anything but http(s). */
function linkOf(value: unknown, page: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('data:')) return null;
  try {
    const url = new URL(value.trim(), page);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Downloads one file whose type `accept` names an extension for, or answers null. */
async function download(get: typeof fetch, link: string, accept: (type: string) => string | undefined, headers: Record<string, string> = {}) {
  try {
    const res = await get(link, { headers, signal: AbortSignal.timeout(20_000) });
    const type = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const ext = accept(type);
    if (!res.ok || !ext) return null;
    const body = new Uint8Array(await res.arrayBuffer());
    return body.length && body.length <= MAX_FILE ? { body, type, ext } : null;
  } catch {
    return null;
  }
}

/** Copies one image, or answers null when it isn't a picture we can keep. */
async function copyImage(get: typeof fetch, link: string | null, stem: string): Promise<{ name: string; body: Uint8Array; type: string } | null> {
  const file = link ? await download(get, link, (type) => IMAGE_TYPES[type], { Accept: 'image/*' }) : null;
  return file ? { name: `${stem}.${file.ext}`, body: file.body, type: file.type } : null;
}

class UnreadableSite extends Error {}

async function scrape(website: string, readers: ProspectReaders): Promise<Document> {
  if (!readers.firecrawl) throw new UnreadableSite("Reading websites isn't set up on this server yet.");
  try {
    return await readers.firecrawl.scrape(website, { formats: ['branding', 'links', { type: 'json', prompt: PROMPT, schema: SCHEMA }], onlyMainContent: false, proxy: 'auto', blockAds: true, timeout: 60_000 });
  } catch (err) {
    throw new UnreadableSite(`${new URL(website).hostname} couldn't be read: ${(err as Error).message}`);
  }
}

const texts = (list: unknown[] | undefined, max: number, count: number) => (list ?? []).map((h) => str(h, max)).filter((h): h is string => !!h).slice(0, count);

/** What the page said, in the brand's shape, before its images are copied. */
function brandOf(doc: Document, page: string, found: Extracted): ProspectBrand {
  const design = designFromBranding(doc.branding);
  return {
    source: page,
    name: str(found.name, 200) ?? str(doc.branding?.brandName, 200),
    tagline: str(found.tagline, 200),
    about: str(found.about, 1000),
    phone: str(found.phone, 50),
    city: str(found.city, 100),
    address: str(found.address, 300),
    hours: texts(found.hours, 100, 14),
    site: { platform: platformOf(doc, found), features: featuresOf(doc, found) },
    colors: design.colors,
    fonts: { heading: design.fonts.heading, body: design.fonts.body },
    colorScheme: design.colorScheme,
    logo: design.logo,
    photos: [],
    items: [],
  };
}

/** Reads the website once and copies its images. */
async function gather(website: string, readers: ProspectReaders) {
  const doc = await scrape(website, readers);
  const page = (doc.metadata?.sourceURL as string | undefined) ?? website;
  const found = (doc.json ?? {}) as Extracted;
  const brand = brandOf(doc, page, found);
  const get = readers.download ?? publicFetchUpTo(MAX_FILE + 1);
  const files = [...(await copyImages(get, brand, found, [...(found.photos ?? []), doc.metadata?.ogImage])), ...(await copyFonts(get, brand))];
  return { brand, files, credits: doc.metadata?.creditsUsed ?? 5 };
}

/** Copies the logo, photos and item pictures, and puts their file names in the brand. */
async function copyImages(get: typeof fetch, brand: ProspectBrand, found: Extracted, photoList: unknown[]) {
  const page = brand.source;
  const items = (found.items ?? []).filter((i) => str(i?.name)).slice(0, MAX_ITEMS);
  const photoLinks = photoList.map((p) => linkOf(p, page)).filter((p): p is string => !!p);
  const [logo, photos, pictures] = await Promise.all([
    copyImage(get, linkOf(brand.logo, page), 'logo'),
    Promise.all([...new Set(photoLinks)].slice(0, MAX_PHOTOS).map((p, i) => copyImage(get, p, `photo-${i + 1}`))),
    Promise.all(items.map((item, i) => copyImage(get, linkOf(item.image, page), `item-${i + 1}`))),
  ]);
  brand.logo = logo?.name ?? null;
  brand.photos = photos.flatMap((p) => (p ? [p.name] : []));
  brand.items = items.map((item, i) => ({ name: str(item.name, 200)!, description: str(item.description), price: str(item.price, 50), image: pictures[i]?.name ?? null }));
  return [logo, ...photos, ...pictures].filter((f): f is NonNullable<typeof f> => !!f);
}

/** Looks a font up by name; null when it isn't an open-licence font we may copy. */
async function fontsourceFont(get: typeof fetch, family: string) {
  const id = family.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id) return null;
  try {
    const res = await get(`${FONTSOURCE}${id}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const font = (await res.json()) as { family?: string; category?: string; weights?: number[]; variants?: Record<string, Record<string, Record<string, { url?: { woff2?: string } }>>> };
    return font.family?.toLowerCase() === family.toLowerCase().trim() ? font : null;
  } catch {
    return null;
  }
}

/** The nearest weight the font has to the one wanted. */
const nearest = (weights: number[], want: number) => weights.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best), weights[0]!);

/** Copies the regular and bold Latin files of the heading and body fonts, when they are open-licence fonts. */
async function copyFonts(get: typeof fetch, brand: ProspectBrand) {
  const families = [...new Set([brand.fonts.heading, brand.fonts.body].filter((f): f is string => !!f))].slice(0, 2);
  const files: { name: string; body: Uint8Array; type: string }[] = [];
  brand.fontFaces = [];
  for (const [i, family] of families.entries()) {
    const font = await fontsourceFont(get, family);
    if (!font?.weights?.length) continue;
    for (const want of FONT_WEIGHTS) {
      const weight = nearest(font.weights, want);
      const link = font.variants?.[String(weight)]?.normal?.latin?.url?.woff2;
      const name = `font-${i + 1}-${want}.woff2`;
      const file = link ? await download(get, link, (type) => (['font/woff2', 'application/octet-stream', ''].includes(type) ? 'woff2' : undefined)) : null;
      if (!file) continue;
      files.push({ name, body: file.body, type: 'font/woff2' });
      brand.fontFaces.push({ family: font.family!, category: font.category ?? 'sans-serif', weight: want, file: name });
    }
  }
  return files;
}

/** Works the queue: each job reads one prospect's website and keeps what the demo needs. */
export async function startProspectDemos(
  boss: PgBoss,
  pool: Pool,
  provisioner: Provisioner,
  readers: ProspectReaders,
  { pollingIntervalSeconds = 2, notifyPollingIntervalSeconds = NOTIFY_POLL_SECONDS, log = console }: { pollingIntervalSeconds?: number; notifyPollingIntervalSeconds?: number; log?: Pick<Console, 'error'> } = {},
) {
  await ensureQueue(boss, QUEUE, { retryLimit: 0, expireInSeconds: 600, deleteAfterSeconds: 7 * 24 * 3600 });
  await boss.work(QUEUE, { includeMetadata: true, pollingIntervalSeconds, notifyPollingIntervalSeconds, localConcurrency: 4 }, async ([job]: JobWithMetadata<{ id: string }>[]) => {
    if (!job) return;
    const { rows } = await pool.query<Row & { files: string[] }>('SELECT * FROM prospect_demos WHERE id = $1 AND status = $2', [job.data.id, Status.Pending]);
    const row = rows[0];
    if (!row?.website) return;
    try {
      const { brand, files, credits } = await gather(row.website, readers);
      for (const f of files) await provisioner.putProspectFile({ code: row.code, name: f.name, body: f.body, contentType: f.type });
      const names = files.map((f) => f.name);
      await provisioner.deleteProspectFiles({ code: row.code, names: row.files.filter((n) => !names.includes(n)) });
      await pool.query('UPDATE prospect_demos SET status = $2, brand = $3, files = $4, error = NULL, credits_used = credits_used + $5, date_gathered = now() WHERE id = $1', [row.id, Status.Done, JSON.stringify(brand), names, credits]);
    } catch (err) {
      const message = err instanceof UnreadableSite ? err.message : "The website couldn't be read. Try again in a few minutes.";
      if (!(err instanceof UnreadableSite)) log.error(`prospect demo ${row.id} failed:`, err);
      await pool.query('UPDATE prospect_demos SET status = $2, error = $3 WHERE id = $1', [row.id, Status.Failed, message]);
    }
  });
}

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import type { Client, Pool } from './db.ts';
import { badRequest, HttpError } from './errors.ts';
import { isUuid, readJson } from './http.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import type { SiteRequest, SiteResponse } from './sitekeys.ts';

/**
 * Demos people build for themselves on WordPress Playground, in their own browser, from a site type's blueprint
 * (docs/demo-drafts.md). Nothing is made on the server while they build. "Make this my site" saves the demo as a draft:
 * POST /demos/drafts (public, no API key) with what the page read out of the Playground through AnyPress Client's site
 * routes: pages, Site Editor styles, header and footer, menus and business details. Never code, plugins or users.
 * Photos they added go to object storage through the upload links in the answer.
 *
 * The draft's id goes with them to checkout. Only a store created after payment (POST /v1/tenants with demoDraftId)
 * can use it, once: the store is built from its template as usual, then gets the draft's content through the same
 * site routes the site tools use (applyDemoDraft). Unused drafts are removed after DRAFT_DAYS.
 */

/** How long a draft waits for its checkout. */
const DRAFT_DAYS = 14;
/** Drafts saved by everyone in an hour, before the route answers 429. */
export const DRAFTS_PER_HOUR = 300;
/** The store template's site types (templates/anypress-store/roles.json). */
export const SITE_TYPES = ['website', 'bookings', 'online-store', 'community', 'everything', 'store', 'highlevel'] as const;
/** Photos in one draft, and the most each may hold. */
const MAX_IMAGES = 20;
export const MAX_IMAGE_BYTES = 10 * 1024 ** 2;
/** The whole draft as JSON. */
const MAX_DRAFT_CHARS = 2 * 1024 ** 2;
const MAX_PAGES = 30;
const MAX_MENUS = 5;
const UPLOAD_SECONDS = 3600;

/** Where a photo goes in the draft's content, until the store has its own copy. */
export const IMAGE_PLACEHOLDER = 'anypress-demo-image:';
const IMAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.(jpe?g|png|webp|gif)$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const KIT = /^[a-z0-9][a-z0-9/-]{0,99}$/;
const DRAFT_ID = /^demo_[A-Za-z0-9_-]{22}$/;
const BUSINESS_FIELDS = ['what', 'who', 'area', 'hours', 'contact', 'voice', 'notes'] as const;
const CONTENT_FIELDS = ['pages', 'styles', 'header', 'footer', 'menus', 'business'];
const DRAFT_FIELDS = ['siteType', 'kit', 'productId', 'content', 'images'];

interface DemoPage {
  title: string;
  slug: string;
  content: string;
  status: 'publish' | 'draft';
}

interface DemoContent {
  pages: DemoPage[];
  styles?: { settings?: Record<string, unknown>; styles?: Record<string, unknown> };
  header?: string;
  footer?: string;
  menus?: { title: string; content: string }[];
  business?: Partial<Record<(typeof BUSINESS_FIELDS)[number], string>>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw badRequest(`${name} must be text`);
  if (value.length > max) throw badRequest(`${name} is longer than ${max} characters`);
  if (required && !value.trim()) throw badRequest(`${name} is required`);
  return value;
}

const only = (raw: Record<string, unknown>, fields: readonly string[], name: string) => {
  const extra = Object.keys(raw).filter((k) => !fields.includes(k));
  if (extra.length) throw badRequest(`${name} takes only ${fields.join(', ')}, not ${extra.join(', ')}`);
};

function parsePage(p: unknown, i: number): DemoPage {
  const at = `content.pages[${i}]`;
  if (!isObject(p)) throw badRequest(`${at} must be an object`);
  const slug = text(p.slug, `${at}.slug`, 200, true)!;
  if (!SLUG.test(slug)) throw badRequest(`${at}.slug can only hold lowercase letters, digits and -`);
  if (p.status !== undefined && p.status !== 'publish' && p.status !== 'draft') throw badRequest(`${at}.status must be publish or draft`);
  return {
    title: text(p.title, `${at}.title`, 200, true)!,
    slug,
    content: text(p.content, `${at}.content`, 500_000) ?? '',
    status: p.status === 'draft' ? 'draft' : 'publish',
  };
}

function parsePages(raw: unknown): DemoPage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('content.pages must list the demo’s pages');
  if (raw.length > MAX_PAGES) throw badRequest(`A demo has at most ${MAX_PAGES} pages`);
  const pages = raw.map(parsePage);
  if (new Set(pages.map((p) => p.slug)).size !== pages.length) throw badRequest('Each page needs its own slug');
  return pages;
}

function parseStyles(raw: unknown): DemoContent['styles'] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw badRequest('content.styles must be an object');
  const { settings, styles } = raw;
  const bad = (v: unknown) => v !== undefined && !isObject(v);
  if (bad(settings) || bad(styles)) throw badRequest('content.styles holds settings and styles, both objects');
  return { ...(settings !== undefined && { settings }), ...(styles !== undefined && { styles }) } as DemoContent['styles'];
}

function parseMenus(raw: unknown): DemoContent['menus'] {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_MENUS) throw badRequest(`content.menus must be a list of at most ${MAX_MENUS}`);
  return raw.map((m, i) => {
    if (!isObject(m)) throw badRequest(`content.menus[${i}] must be an object`);
    return { title: text(m.title, `content.menus[${i}].title`, 200, true)!, content: text(m.content, `content.menus[${i}].content`, 100_000, true)! };
  });
}

function parseBusiness(raw: unknown): DemoContent['business'] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw badRequest('content.business must be an object');
  only(raw, BUSINESS_FIELDS, 'content.business');
  return Object.fromEntries(BUSINESS_FIELDS.flatMap((k) => (raw[k] === undefined ? [] : [[k, text(raw[k], `content.business.${k}`, 2000)!]])));
}

/** The draft's content, checked: only what the site routes take, each within bounds. */
function parseDemoContent(raw: unknown): DemoContent {
  if (!isObject(raw)) throw badRequest('content must be an object');
  only(raw, CONTENT_FIELDS, 'content');
  return {
    pages: parsePages(raw.pages),
    styles: parseStyles(raw.styles),
    header: text(raw.header, 'content.header', 200_000),
    footer: text(raw.footer, 'content.footer', 200_000),
    menus: parseMenus(raw.menus),
    business: parseBusiness(raw.business),
  };
}

function parseImages(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) throw badRequest(`images must be a list of at most ${MAX_IMAGES} file names`);
  for (const name of raw) {
    if (typeof name !== 'string' || !IMAGE_NAME.test(name)) throw badRequest('Each image is a file name of lowercase letters, digits, . _ and -, ending .jpg, .png, .webp or .gif');
  }
  if (new Set(raw).size !== raw.length) throw badRequest('Each image needs its own name');
  return raw as string[];
}

/** A POST /demos/drafts body, checked. */
async function parseDraftBody(pool: Deps['pool'], body: unknown) {
  if (!isObject(body)) throw badRequest('Send the draft as a JSON object');
  only(body, DRAFT_FIELDS, 'A draft');
  if (JSON.stringify(body).length > MAX_DRAFT_CHARS) throw new HttpError(413, 'This demo is too large to save. Remove some pages and try again.');
  const siteType = body.siteType;
  if (typeof siteType !== 'string' || !(SITE_TYPES as readonly string[]).includes(siteType)) throw badRequest(`siteType must be one of ${SITE_TYPES.join(', ')}`);
  const kit = text(body.kit, 'kit', 100);
  if (kit !== undefined && !KIT.test(kit)) throw badRequest('kit can only hold lowercase letters, digits, - and /');
  return { siteType, kit, productId: await parseProductId(pool, body.productId), content: parseDemoContent(body.content), images: parseImages(body.images) };
}

async function parseProductId(pool: Deps['pool'], raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !isUuid(raw)) throw badRequest('productId must be a storefront id');
  const { rowCount } = await pool.query('SELECT 1 FROM products WHERE id = $1', [raw]);
  if (!rowCount) throw badRequest('productId is not a known storefront');
  return raw;
}

const newDraftId = () => `demo_${randomBytes(16).toString('base64url')}`;

/** POST /demos/drafts and GET /demos/drafts/:id. No sign-in, no API key: a draft can't create, read or change a store. */
export function demoDraftRoutes({ pool, provisioner }: Deps) {
  const app = new Hono<AppEnv>();

  app.post('/drafts', async (c) => {
    if (!provisioner) throw new HttpError(503, 'Demo drafts are not available here');
    const { siteType, kit, productId, content, images } = await parseDraftBody(pool, await readJson(c));

    const recent = await pool.query(`SELECT count(*)::int AS n FROM demo_drafts WHERE created_at > now() - interval '1 hour'`);
    if (recent.rows[0].n >= DRAFTS_PER_HOUR) throw new HttpError(429, 'Too many demos are being saved right now. Please try again in a few minutes.');

    const id = newDraftId();
    const { rows } = await pool.query<{ expires_at: Date }>(
      `INSERT INTO demo_drafts (id, site_type, kit, product_id, content, images, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING expires_at`,
      [id, siteType, kit ?? null, productId, content, images, DRAFT_DAYS],
    );
    const uploads = await Promise.all(
      images.map(async (name) => ({ name, uploadUrl: await provisioner.createDemoImageUpload({ draftId: id, name, expiresInSeconds: UPLOAD_SECONDS }) })),
    );
    return c.json({ id, expiresAt: rows[0]!.expires_at.toISOString(), maxImageBytes: MAX_IMAGE_BYTES, uploads }, 201);
  });

  // What checkout shows about the draft (its site type and kit), and whether it can still be used.
  app.get('/drafts/:id', async (c) => {
    const id = c.req.param('id');
    const draft = DRAFT_ID.test(id) ? await findDraft(pool, id) : undefined;
    if (!draft) throw new HttpError(404, 'This demo is no longer saved. Build it again, then choose Make this my site.');
    return c.json({
      id: draft.id,
      siteType: draft.site_type,
      kit: draft.kit,
      productId: draft.product_id,
      pages: draft.content.pages.map((p) => p.title),
      expiresAt: draft.expires_at.toISOString(),
      used: draft.used_at !== null,
    });
  });

  return app;
}

interface DraftRow {
  id: string;
  site_type: string;
  kit: string | null;
  product_id: string | null;
  content: DemoContent;
  images: string[];
  expires_at: Date;
  used_at: Date | null;
}

async function findDraft(pool: Pool, id: string): Promise<DraftRow | undefined> {
  const { rows } = await pool.query<DraftRow>('SELECT * FROM demo_drafts WHERE id = $1 AND expires_at > now()', [id]);
  return rows[0];
}

/**
 * Ties a draft to the store being created, inside its create transaction: the draft must be saved, unused and not
 * expired, made for this storefront's demo page (or AnyPress's own), and for the store's site type when it has one.
 */
export async function claimDemoDraft(client: Client, draftId: string, tenantId: string, productId: string, siteType: string | undefined): Promise<void> {
  if (!DRAFT_ID.test(draftId)) throw badRequest('demoDraftId is not a demo draft');
  const { rows } = await client.query<DraftRow>('SELECT * FROM demo_drafts WHERE id = $1 AND expires_at > now() FOR UPDATE', [draftId]);
  const draft = rows[0];
  if (!draft) throw badRequest('This demo draft has expired or was never saved');
  if (draft.used_at) throw badRequest('This demo draft has already been used for a store');
  if (draft.product_id && draft.product_id !== productId) throw badRequest('This demo draft was made on another storefront’s demo page');
  if (siteType && !siteType.split(',').map((s) => s.trim()).includes(draft.site_type)) {
    throw badRequest(`This demo draft is a ${draft.site_type} site, not ${siteType}`);
  }
  await client.query('UPDATE demo_drafts SET tenant_id = $2, used_at = now() WHERE id = $1', [draftId, tenantId]);
}

/** Every photo placeholder in `value` (a string, or any JSON) swapped for the store's own copy. */
function withImages<T>(value: T, urls: Map<string, string>): T {
  if (!urls.size) return value;
  const swap = (s: string) => s.replace(/anypress-demo-image:([a-z0-9][a-z0-9._-]{0,80}\.(?:jpe?g|png|webp|gif))/g, (all, name: string) => urls.get(name) ?? all);
  return typeof value === 'string' ? (swap(value) as T) : (JSON.parse(swap(JSON.stringify(value))) as T);
}

type CallSite = (request: SiteRequest) => Promise<SiteResponse>;

async function must(call: CallSite, request: SiteRequest): Promise<unknown> {
  const { status, body } = await call(request);
  if (status < 200 || status >= 300) {
    const message = isObject(body) && typeof body.message === 'string' ? body.message : `status ${status}`;
    throw new Error(`${request.method} ${request.path || '/'}: ${message}`);
  }
  return body;
}

/** Each uploaded photo copied into the store's media library: its name and the store's own link. */
async function copyImages(provisioner: Provisioner, draft: DraftRow, call: CallSite): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const name of draft.images) {
    const size = await provisioner.demoImageSize({ draftId: draft.id, name });
    if (size === null || size > MAX_IMAGE_BYTES) continue; // never uploaded, or too large: its placeholder stays
    const url = await provisioner.demoImageUrl({ draftId: draft.id, name, expiresInSeconds: UPLOAD_SECONDS });
    const added = await must(call, { method: 'POST', path: '/media', body: { url, alt: '' } });
    if (isObject(added) && typeof added.url === 'string') urls.set(name, added.url);
  }
  return urls;
}

async function putPages(call: CallSite, pages: DemoPage[]) {
  const existing = (await must(call, { method: 'GET', path: '/pages' })) as { id: number; slug: string }[];
  for (const page of pages) {
    const match = existing.find((p) => p.slug === page.slug);
    await must(call, match ? { method: 'PUT', path: `/pages/${match.id}`, body: page } : { method: 'POST', path: '/pages', body: page });
  }
}

async function putMenus(call: CallSite, menus: NonNullable<DemoContent['menus']>) {
  if (!menus.length) return;
  const existing = (await must(call, { method: 'GET', path: '/menus' })) as { id: number; title: string }[];
  for (const menu of menus) {
    const match = existing.find((m) => m.title === menu.title);
    if (match) await must(call, { method: 'PUT', path: `/menus/${match.id}`, body: { content: menu.content } });
  }
}

/** The draft's styles, header and footer, pages, menus and business details, in that order. */
async function putContent(call: CallSite, content: DemoContent) {
  if (content.styles) await must(call, { method: 'PATCH', path: '/styles', body: content.styles });
  if (content.header) await must(call, { method: 'PUT', path: '/parts/header', body: { content: content.header } });
  if (content.footer) await must(call, { method: 'PUT', path: '/parts/footer', body: { content: content.footer } });
  await putPages(call, content.pages);
  await putMenus(call, content.menus ?? []);
  if (content.business && Object.keys(content.business).length) await must(call, { method: 'PATCH', path: '/business', body: { about: content.business } });
}

/**
 * Puts a draft's content on the store made with it, through the store's site routes: photos into its media library,
 * then styles, header and footer, pages (the store's page with the same slug, else a new one), menus with the same
 * title, and business details. Called once the store is built; a failure is recorded on the draft and logged, and the
 * store stays as its template made it. Answers whether there was a draft to apply.
 */
export async function applyDemoDraft(pool: Pool, provisioner: Provisioner, tenantId: string, call: CallSite): Promise<boolean> {
  const { rows } = await pool.query<DraftRow>('SELECT * FROM demo_drafts WHERE tenant_id = $1 AND applied_at IS NULL', [tenantId]);
  const draft = rows[0];
  if (!draft) return false;
  try {
    await putContent(call, withImages(draft.content, await copyImages(provisioner, draft, call)));
    await pool.query('UPDATE demo_drafts SET applied_at = now(), apply_error = NULL WHERE id = $1', [draft.id]);
    await provisioner.deleteDemoDraft({ draftId: draft.id, names: draft.images });
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    console.error(`Store ${tenantId}: demo draft ${draft.id} not applied: ${message}`);
    await pool.query('UPDATE demo_drafts SET apply_error = $2 WHERE id = $1', [draft.id, message]);
  }
  return true;
}

/** Removes drafts nobody used before they expired, with their photos. Daily maintenance. */
export async function purgeExpiredDemoDrafts(pool: Pool, provisioner: Provisioner): Promise<number> {
  const { rows } = await pool.query<{ id: string; images: string[] }>('SELECT id, images FROM demo_drafts WHERE expires_at < now() AND tenant_id IS NULL');
  for (const { id, images } of rows) {
    await provisioner.deleteDemoDraft({ draftId: id, names: images });
    await pool.query('DELETE FROM demo_drafts WHERE id = $1', [id]);
  }
  return rows.length;
}

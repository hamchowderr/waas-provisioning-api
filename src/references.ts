import { ensureQueue, NOTIFY_POLL_SECONDS } from './queue.ts';
// Reading a reference a site is to be built from (docs/references.md): a website link, a Shopify shop, a Figma file or a
// document, turned into one bundle the site builder works from, whoever asked (the MCP connector, the website assistant,
// the dashboard, the SDKs or an automation app). Websites and documents are read with Firecrawl (its official SDK); a
// Shopify shop's products come from its public products.json; Figma files from Figma's REST API, which has no official
// client (its types come from @figma/rest-api-spec). Each storefront gets REFERENCE_READS_PER_MONTH reads a calendar
// month (UTC); a read that fails isn't counted. Reading runs as a job on its own queue and takes up to a few minutes.
import type { BrandingProfile, Document, Firecrawl } from '@mendable/firecrawl-js';
import type { GetFileNodesResponse, GetFileResponse, GetImageFillsResponse, GetImagesResponse } from '@figma/rest-api-spec';
import type { Hono } from 'hono';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { AppEnv } from './app.ts';
import type { Pool } from './db.ts';
import { HttpError } from './errors.ts';
import { isUuid } from './http.ts';
import { publicFetchUpTo } from './publicfetch.ts';
import { Status } from './status.ts';

export const REFERENCES_QUEUE = 'references';

export type ReferenceKind = 'website' | 'figma' | 'document';

export interface ReferenceConfig {
  firecrawlApiKey?: string;
  /** A Figma personal access token (scope file_content:read) of a Dev or Full seat, for Figma's higher rate limits. */
  figmaToken?: string;
  readsPerMonth: number;
}

export function loadReferenceConfig(env: NodeJS.ProcessEnv): ReferenceConfig {
  const raw = env.REFERENCE_READS_PER_MONTH?.trim();
  const readsPerMonth = raw ? Number(raw) : 50;
  if (!Number.isInteger(readsPerMonth) || readsPerMonth < 0) throw new Error('REFERENCE_READS_PER_MONTH must be a whole number');
  return { firecrawlApiKey: env.FIRECRAWL_API_KEY?.trim() || undefined, figmaToken: env.FIGMA_TOKEN?.trim() || undefined, readsPerMonth };
}

/** What the readers call out to; tests replace them. */
export interface ReferenceReaders {
  firecrawl?: Pick<Firecrawl, 'map' | 'scrape' | 'parse'>;
  figmaToken?: string;
  /** Figma's API. */
  figmaFetch?: typeof fetch;
  /** Shops' public products.json and collections.json: a GET that never reaches a private address. */
  shopFetch?: typeof fetch;
}

/** The bundle a reference is read into. Every reader fills the same shape; what a kind can't tell is left empty. */
export interface ReferenceBundle {
  kind: ReferenceKind;
  source: string;
  title: string | null;
  design: ReferenceDesign;
  pages: ReferencePage[];
  products: ReferenceProduct[];
  collections: { title: string; handle: string; description: string }[];
  /** Plain notes for the site builder: what was left out, links that expire, what to do with someone else's copy. */
  notes: string[];
}

export interface ReferenceDesign {
  /** Named colours, #rrggbb where the source gives one: primary, secondary, accent, background, text, and so on. */
  colors: Record<string, string>;
  fonts: { heading: string | null; body: string | null; all: string[] };
  /** Font sizes by role (h1, h2, body), as the source gives them. */
  fontSizes: Record<string, string>;
  radius: string | null;
  colorScheme: 'light' | 'dark' | null;
  logo: string | null;
}

export interface ReferencePage {
  /** The page's address, or the Figma frame's name. */
  url: string;
  title: string | null;
  /** The page's text as Markdown. */
  text: string;
  /** For a Figma frame: its top-level layers in order, each with its text. */
  sections: { name: string; text: string[] }[];
  /** A picture of the whole page. Expires: copy it into the store's media (add_image) if it is kept. */
  screenshot: string | null;
  images: string[];
}

export interface ReferenceProduct {
  title: string;
  handle: string;
  description: string;
  vendor: string | null;
  type: string | null;
  tags: string[];
  price: string | null;
  compareAtPrice: string | null;
  images: string[];
  variants: { title: string; sku: string | null; price: string | null; compareAtPrice: string | null; available: boolean }[];
}

export interface ReferenceUsage {
  /** False until the platform has a Firecrawl key: only Figma links (with a Figma token) can be read. */
  available: boolean;
  used: number;
  limit: number;
  resetsAt: string;
}

const MAX_PAGE_TEXT = 20_000;
const MAX_UPLOAD = 10 * 1024 * 1024;
const DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  html: 'text/html',
};

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

export async function referenceUsage(pool: Pool, config: ReferenceConfig, productId: string, now = new Date()): Promise<ReferenceUsage> {
  const { rows } = await pool.query<{ used: number }>(
    'SELECT count(*)::int AS used FROM site_references WHERE product_id = $1 AND date_created >= $2 AND status <> $3',
    [productId, monthStart(now), Status.Failed],
  );
  return { available: !!config.firecrawlApiKey, used: rows[0]!.used, limit: config.readsPerMonth, resetsAt: nextMonth(now) };
}

/** A Figma file's key and the node a link points at (node-id 12-34 in a link is 12:34 in the API), or null. */
export function figmaLink(url: URL): { key: string; nodeId: string | null } | null {
  if (url.hostname !== 'figma.com' && !url.hostname.endsWith('.figma.com')) return null;
  const match = /^\/(?:file|design|proto|board)\/([A-Za-z0-9]{10,})/.exec(url.pathname);
  if (!match) return null;
  const node = url.searchParams.get('node-id')?.replace('-', ':') ?? null;
  return { key: match[1]!, nodeId: node && /^\d+:\d+$/.test(node) ? node : null };
}

function documentType(name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext ? (DOCUMENT_TYPES[ext] ?? null) : null;
}

export interface ReferenceInput {
  url?: string;
  file?: { name: string; data: string; contentType?: string };
  maxPages?: number;
}

/** Checks a request and works out its kind. Throws a 400 HttpError for anything it can't read. */
export function parseReferenceInput(body: unknown): { kind: ReferenceKind; source: string; maxPages: number; upload?: { data: Buffer; type: string } } {
  const input = (body ?? {}) as ReferenceInput;
  const maxPages = input.maxPages ?? 5;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new HttpError(400, 'maxPages must be a whole number from 1 to 10');
  if (input.file !== undefined) {
    if (input.url !== undefined) throw new HttpError(400, 'Send a url or a file, not both');
    const { name, data, contentType } = input.file ?? ({} as NonNullable<ReferenceInput['file']>);
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new HttpError(400, 'file.name is required');
    if (typeof data !== 'string' || !data) throw new HttpError(400, 'file.data is required (the file, base64-encoded)');
    const type = (typeof contentType === 'string' && Object.values(DOCUMENT_TYPES).includes(contentType) ? contentType : null) ?? documentType(name);
    if (!type) throw new HttpError(400, 'Upload a PDF, Word, Excel, OpenDocument, RTF or HTML file');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length) throw new HttpError(400, 'file.data is not base64');
    if (bytes.length > MAX_UPLOAD) throw new HttpError(400, 'Files can be up to 10 MB');
    return { kind: 'document', source: name.trim(), maxPages, upload: { data: bytes, type } };
  }
  if (typeof input.url !== 'string' || !input.url.trim()) throw new HttpError(400, 'Send a url (a website, Shopify shop, Figma file or document link) or a file');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.url.trim()) ? input.url.trim() : `https://${input.url.trim()}`);
  } catch {
    throw new HttpError(400, 'url is not a web address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'url must be an http or https address');
  if (url.username || url.password) throw new HttpError(400, 'url must not hold a user name or password');
  const source = url.toString();
  if (source.length > 2000) throw new HttpError(400, 'url is too long');
  if (figmaLink(url)) return { kind: 'figma', source, maxPages };
  if (documentType(url.pathname)) return { kind: 'document', source, maxPages };
  return { kind: 'website', source, maxPages };
}

/** Starts reading a reference: checks the allowance and queues the read. */
export async function startReference(pool: Pool, boss: PgBoss, config: ReferenceConfig, productId: string, body: unknown, now = new Date()) {
  const input = parseReferenceInput(body);
  if (input.kind === 'figma' ? !config.figmaToken : !config.firecrawlApiKey) {
    throw new HttpError(503, input.kind === 'figma' ? "Reading Figma files isn't set up on this server yet." : "Reading references isn't set up on this server yet.");
  }
  const usage = await referenceUsage(pool, config, productId, now);
  if (usage.used >= usage.limit) throw new HttpError(429, `You've used this month's ${usage.limit} reference reads. They start again on the 1st.`);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO site_references (product_id, kind, source, max_pages, upload, upload_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [productId, input.kind, input.source, input.maxPages, input.upload?.data ?? null, input.upload?.type ?? null],
  );
  const id = rows[0]!.id;
  await boss.send(REFERENCES_QUEUE, { referenceId: id }, { retryLimit: 1, retryDelay: 30, expireInSeconds: 900 });
  return getReference(pool, productId, id);
}

export async function getReference(pool: Pool, productId: string, id: string) {
  if (!isUuid(id)) throw new HttpError(404, 'No reference with this id');
  const { rows } = await pool.query(
    'SELECT id, kind, source, status, bundle, error, date_created, date_finished FROM site_references WHERE id = $1 AND product_id = $2',
    [id, productId],
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, 'No reference with this id');
  return {
    id: r.id as string,
    kind: r.kind as ReferenceKind,
    source: r.source as string,
    statusCode: r.status as number,
    error: (r.error as string | null) ?? null,
    bundle: (r.bundle as ReferenceBundle | null) ?? null,
    createdAt: (r.date_created as Date).toISOString(),
    finishedAt: r.date_finished ? (r.date_finished as Date).toISOString() : null,
  };
}

/** POST /v1/references and GET /v1/references?id= for any caller of a storefront (openapi: TenantSite). */
export function referenceRoutes(app: Hono<AppEnv>, deps: { pool: Pool; boss: PgBoss; config: { references?: ReferenceConfig } }) {
  const config = () => deps.config.references ?? { readsPerMonth: 0 };
  app.post('/v1/references', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new HttpError(400, 'The body must be JSON');
    });
    return c.json(await startReference(deps.pool, deps.boss, config(), c.get('productId'), body), 200);
  });
  app.get('/v1/references/usage', async (c) => c.json(await referenceUsage(deps.pool, config(), c.get('productId')), 200, { 'Cache-Control': 'no-store' }));
  app.get('/v1/references', async (c) => c.json(await getReference(deps.pool, c.get('productId'), c.req.query('id') ?? ''), 200, { 'Cache-Control': 'no-store' }));
}

/** Works the queue: each job reads one reference and stores its bundle, or why it couldn't be read. */
export async function startReferences(boss: PgBoss, pool: Pool, readers: ReferenceReaders, { pollingIntervalSeconds = 2, notifyPollingIntervalSeconds = NOTIFY_POLL_SECONDS, log = console }: { pollingIntervalSeconds?: number; notifyPollingIntervalSeconds?: number; log?: Pick<Console, 'error'> } = {}) {
  await ensureQueue(boss, REFERENCES_QUEUE, { retryLimit: 1, retryDelay: 30, expireInSeconds: 900, deleteAfterSeconds: 7 * 24 * 3600 });
  await boss.work(REFERENCES_QUEUE, { includeMetadata: true, pollingIntervalSeconds, notifyPollingIntervalSeconds }, async ([job]: JobWithMetadata<{ referenceId: string }>[]) => {
    if (!job) return;
    const { rows } = await pool.query('SELECT id, kind, source, max_pages, upload, upload_type FROM site_references WHERE id = $1 AND status = $2', [job.data.referenceId, Status.Pending]);
    const ref = rows[0];
    if (!ref) return;
    try {
      const bundle = await readReference({ kind: ref.kind, source: ref.source, maxPages: ref.max_pages, upload: ref.upload ? { data: ref.upload, type: ref.upload_type } : undefined }, readers);
      await pool.query('UPDATE site_references SET status = $2, bundle = $3, upload = NULL, date_finished = now() WHERE id = $1', [ref.id, Status.Done, JSON.stringify(bundle)]);
    } catch (err) {
      if (!(err instanceof UnreadableReference) && job.retryCount < job.retryLimit) throw err;
      const message = err instanceof UnreadableReference ? err.message : "The reference couldn't be read. Try again in a few minutes.";
      if (!(err instanceof UnreadableReference)) log.error(`reference ${ref.id} (${ref.kind}) failed:`, err);
      await pool.query('UPDATE site_references SET status = $2, error = $3, upload = NULL, date_finished = now() WHERE id = $1', [ref.id, Status.Failed, message]);
    }
  });
}

/** A reference that can't be read for a reason the person can act on; its message is shown to them as is. */
export class UnreadableReference extends Error {}

export async function readReference(
  ref: { kind: ReferenceKind; source: string; maxPages: number; upload?: { data: Buffer; type: string } },
  readers: ReferenceReaders,
): Promise<ReferenceBundle> {
  if (ref.kind === 'figma') return readFigma(ref.source, ref.maxPages, readers);
  if (ref.kind === 'document') return readDocument(ref, readers);
  return readWebsite(ref.source, ref.maxPages, readers);
}

const emptyDesign = (): ReferenceDesign => ({ colors: {}, fonts: { heading: null, body: null, all: [] }, fontSizes: {}, radius: null, colorScheme: null, logo: null });
const clip = (text: string | undefined) => (text ?? '').slice(0, MAX_PAGE_TEXT);
const COPY_NOTE = "Someone else's site or file: take its layout and style, and write the store's own text.";

function firecrawlOf(readers: ReferenceReaders) {
  if (!readers.firecrawl) throw new UnreadableReference("Reading references isn't set up on this server yet.");
  return readers.firecrawl;
}

function designFromBranding(b: BrandingProfile | undefined): ReferenceDesign {
  const design = emptyDesign();
  if (!b) return design;
  for (const [name, value] of Object.entries(b.colors ?? {})) if (typeof value === 'string' && value) design.colors[name] = value;
  const families = b.typography?.fontFamilies ?? {};
  design.fonts.heading = families.heading ?? families.primary ?? null;
  design.fonts.body = families.primary ?? families.body ?? null;
  design.fonts.all = [...new Set([...(b.fonts ?? []).map((f) => f.family), design.fonts.heading, design.fonts.body].filter((f): f is string => !!f))];
  for (const [name, value] of Object.entries(b.typography?.fontSizes ?? {})) if (typeof value === 'string' && value) design.fontSizes[name] = value;
  const radius = (b.spacing as { borderRadius?: unknown } | undefined)?.borderRadius;
  design.radius = typeof radius === 'number' ? `${radius}px` : typeof radius === 'string' ? radius : null;
  design.colorScheme = b.colorScheme ?? null;
  design.logo = b.logo ?? null;
  return design;
}

function pageOf(url: string, doc: Document): ReferencePage {
  return {
    url: doc.metadata?.sourceURL ?? doc.metadata?.url ?? url,
    title: (doc.metadata?.title as string | undefined) ?? null,
    text: clip(doc.markdown),
    sections: [],
    screenshot: doc.screenshot ?? null,
    images: [...new Set(doc.images ?? [])].slice(0, 40),
  };
}

/** The pages worth reading besides the home page: same site, shortest paths first (about, services, contact). */
export function pickPages(home: URL, links: string[], count: number): string[] {
  const seen = new Set([home.origin + home.pathname.replace(/\/$/, '')]);
  const picked: string[] = [];
  const candidates = links
    .map((l) => {
      try {
        return new URL(l);
      } catch {
        return null;
      }
    })
    .filter((u): u is URL => !!u && u.hostname.replace(/^www\./, '') === home.hostname.replace(/^www\./, ''))
    .filter((u) => !/\.(jpe?g|png|gif|webp|svg|pdf|xml|zip)$/i.test(u.pathname) && !/\/(cart|checkout|account|login|wp-admin|feed|tag|author)\b/i.test(u.pathname))
    .sort((a, b) => a.pathname.split('/').filter(Boolean).length - b.pathname.split('/').filter(Boolean).length || a.pathname.length - b.pathname.length);
  for (const u of candidates) {
    const key = u.origin + u.pathname.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(u.origin + u.pathname);
    if (picked.length >= count) break;
  }
  return picked;
}

async function readWebsite(source: string, maxPages: number, readers: ReferenceReaders): Promise<ReferenceBundle> {
  const fc = firecrawlOf(readers);
  const home = new URL(source);
  const shop = await readShopify(home, readers.shopFetch ?? publicFetchUpTo(8 * 1024 * 1024));
  let first: Document;
  try {
    first = await fc.scrape(source, { formats: ['markdown', 'images', 'branding', { type: 'screenshot', fullPage: true }], onlyMainContent: false, timeout: 60_000 });
  } catch (err) {
    throw new UnreadableReference(`${home.hostname} couldn't be read: ${(err as Error).message}`);
  }
  const others = maxPages > 1 ? pickPages(home, ((await fc.map(source, { limit: 100 }).catch(() => ({ links: [] }))).links ?? []).map((l) => l.url), maxPages - 1) : [];
  const more = await Promise.all(
    others.map((url) =>
      fc
        .scrape(url, { formats: ['markdown', 'images', { type: 'screenshot', fullPage: true }], onlyMainContent: true, timeout: 60_000 })
        .then((doc) => pageOf(url, doc))
        .catch(() => null),
    ),
  );
  const pages = [pageOf(source, first), ...more.filter((p): p is ReferencePage => !!p)];
  const notes = [COPY_NOTE, 'Screenshots and image links expire within a day: copy any image the site keeps into its media first.'];
  if (shop) notes.push(`A Shopify shop: ${shop.products.length} products${shop.truncated ? ' (the first 1,000)' : ''} read from its public product list.`);
  return {
    kind: 'website',
    source,
    title: first.branding?.brandName ?? (first.metadata?.title as string | undefined) ?? home.hostname,
    design: designFromBranding(first.branding),
    pages,
    products: shop?.products ?? [],
    collections: shop?.collections ?? [],
    notes,
  };
}

/**
 * A Shopify shop's products and collections from its public /products.json and /collections.json, or null when the site
 * isn't a Shopify shop (or its shop is password-protected). 250 products a page, at most four pages.
 */
export async function readShopify(home: URL, get: typeof fetch): Promise<{ products: ReferenceProduct[]; collections: ReferenceBundle['collections']; truncated: boolean } | null> {
  const json = async (path: string) => {
    try {
      const res = await get(`${home.origin}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
      return (await res.json()) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const products: ReferenceProduct[] = [];
  let truncated = false;
  for (let page = 1; page <= 4; page++) {
    const data = await json(`/products.json?limit=250&page=${page}`);
    if (!data || !Array.isArray(data.products)) {
      if (page === 1) return null;
      break;
    }
    for (const p of data.products) products.push(shopifyProduct(p));
    if (data.products.length < 250) break;
    if (page === 4) truncated = true;
  }
  const c = await json('/collections.json?limit=250');
  const collections = Array.isArray(c?.collections)
    ? c.collections.map((x: Record<string, any>) => ({ title: String(x.title ?? ''), handle: String(x.handle ?? ''), description: stripHtml(String(x.description ?? '')) }))
    : [];
  return { products, collections, truncated };
}

const stripHtml = (html: string) =>
  html
    .replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function shopifyProduct(p: Record<string, any>): ReferenceProduct {
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  return {
    title: String(p.title ?? ''),
    handle: String(p.handle ?? ''),
    description: stripHtml(String(p.body_html ?? '')).slice(0, 5000),
    vendor: str(p.vendor),
    type: str(p.product_type),
    tags: Array.isArray(p.tags) ? p.tags.map(String) : typeof p.tags === 'string' && p.tags ? p.tags.split(',').map((t: string) => t.trim()) : [],
    price: str(variants[0]?.price),
    compareAtPrice: str(variants[0]?.compare_at_price),
    images: (Array.isArray(p.images) ? p.images : []).map((i: Record<string, any>) => String(i.src ?? '')).filter(Boolean),
    variants: variants.map((v: Record<string, any>) => ({ title: String(v.title ?? ''), sku: str(v.sku), price: str(v.price), compareAtPrice: str(v.compare_at_price), available: v.available !== false })),
  };
}

async function readDocument(ref: { source: string; upload?: { data: Buffer; type: string } }, readers: ReferenceReaders): Promise<ReferenceBundle> {
  const fc = firecrawlOf(readers);
  let doc: Document;
  try {
    doc = ref.upload
      ? await fc.parse({ data: ref.upload.data, filename: ref.source, contentType: ref.upload.type }, { formats: ['markdown'] })
      : await fc.scrape(ref.source, { formats: ['markdown', 'images'], timeout: 90_000 });
  } catch (err) {
    throw new UnreadableReference(`The document couldn't be read: ${(err as Error).message}`);
  }
  return {
    kind: 'document',
    source: ref.source,
    title: (doc.metadata?.title as string | undefined) ?? ref.source.split('/').pop() ?? null,
    design: emptyDesign(),
    pages: [{ ...pageOf(ref.source, doc), url: ref.source }],
    products: [],
    collections: [],
    notes: ['A document: it gives the text and facts, not the look. Pick the design from the theme.'],
  };
}

// Figma: the file (or the linked node), then pictures of its frames and the links of its image fills. Three calls,
// so a View seat's monthly allowance isn't spent on one file.
type FigmaNode = { id: string; name: string; type: string; visible?: boolean; children?: FigmaNode[]; characters?: string; style?: { fontFamily?: string; fontSize?: number; fontWeight?: number }; fills?: unknown; cornerRadius?: number; backgroundColor?: { r: number; g: number; b: number; a: number } };

const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
const FRAME_TYPES = new Set(['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

async function figmaGet<T>(path: string, readers: ReferenceReaders): Promise<T> {
  if (!readers.figmaToken) throw new UnreadableReference("Reading Figma files isn't set up on this server yet.");
  const res = await (readers.figmaFetch ?? fetch)(`https://api.figma.com${path}`, { headers: { 'X-Figma-Token': readers.figmaToken }, signal: AbortSignal.timeout(60_000) });
  if (res.status === 403 || res.status === 404) {
    throw new UnreadableReference('Figma would not open this file. Share it with the AnyPress Figma account (can view), or check the link.');
  }
  if (res.status === 429) throw new UnreadableReference('Figma is limiting how often files can be read. Try again later.');
  if (!res.ok) throw new Error(`Figma answered ${res.status} for ${path.split('?')[0]}`);
  return (await res.json()) as T;
}

/** Text, colours, fonts and radii found under a node, in reading order. */
function walkFigma(node: FigmaNode, out: { texts: string[]; colors: Map<string, number>; textColors: Map<string, number>; fonts: Map<string, { count: number; maxSize: number }>; radii: number[]; images: Set<string> }) {
  if (node.visible === false) return;
  const fills = Array.isArray(node.fills) ? (node.fills as Array<{ type: string; visible?: boolean; color?: { r: number; g: number; b: number }; imageRef?: string }>) : [];
  for (const f of fills) {
    if (f.visible === false) continue;
    if (f.type === 'SOLID' && f.color) {
      const map = node.type === 'TEXT' ? out.textColors : out.colors;
      map.set(hex(f.color), (map.get(hex(f.color)) ?? 0) + 1);
    }
    if (f.type === 'IMAGE' && f.imageRef) out.images.add(f.imageRef);
  }
  if (node.type === 'TEXT' && node.characters?.trim()) {
    out.texts.push(node.characters.trim());
    const family = node.style?.fontFamily;
    if (family) {
      const f = out.fonts.get(family) ?? { count: 0, maxSize: 0 };
      f.count += node.characters.length;
      f.maxSize = Math.max(f.maxSize, node.style?.fontSize ?? 0);
      out.fonts.set(family, f);
    }
  }
  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) out.radii.push(node.cornerRadius);
  for (const child of node.children ?? []) walkFigma(child, out);
}

const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
const neutral = (c: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!) < 24;
};

async function readFigma(source: string, maxPages: number, readers: ReferenceReaders): Promise<ReferenceBundle> {
  const link = figmaLink(new URL(source))!;
  let name: string;
  let root: FigmaNode;
  if (link.nodeId) {
    const data = await figmaGet<GetFileNodesResponse>(`/v1/files/${link.key}/nodes?ids=${encodeURIComponent(link.nodeId)}`, readers);
    const node = data.nodes[link.nodeId]?.document as FigmaNode | undefined;
    if (!node) throw new UnreadableReference('The linked frame is not in this Figma file any more.');
    name = data.name;
    root = node;
  } else {
    const data = await figmaGet<GetFileResponse>(`/v1/files/${link.key}`, readers);
    name = data.name;
    root = (data.document.children[0] as FigmaNode | undefined) ?? { id: '0:1', name: 'Page 1', type: 'CANVAS' };
  }
  // A page (canvas) or section holds the frames; a linked frame is the one page.
  const frames = FRAME_TYPES.has(root.type) && root.type !== 'SECTION' ? [root] : (root.children ?? []).filter((n) => FRAME_TYPES.has(n.type) && n.visible !== false).slice(0, maxPages);
  if (!frames.length) throw new UnreadableReference('This Figma page has no frames to read. Link a frame or a page with frames.');

  const totals = { texts: [] as string[], colors: new Map<string, number>(), textColors: new Map<string, number>(), fonts: new Map<string, { count: number; maxSize: number }>(), radii: [] as number[], images: new Set<string>() };
  const pages: ReferencePage[] = frames.map((frame) => {
    // The frame's own fill is the page background: it outweighs any one section's.
    const own = { ...totals, colors: new Map<string, number>() };
    walkFigma({ ...frame, children: [] }, own);
    if (frame.backgroundColor && frame.backgroundColor.a > 0) own.colors.set(hex(frame.backgroundColor), 1);
    for (const color of own.colors.keys()) totals.colors.set(color, (totals.colors.get(color) ?? 0) + 5);
    const sections = (frame.children ?? [])
      .filter((n) => n.visible !== false)
      .map((n) => {
        const part = { ...totals, texts: [] as string[] };
        walkFigma(n, part);
        return { name: n.name, text: part.texts };
      });
    return { url: frame.name, title: frame.name, text: sections.map((s) => [`## ${s.name}`, ...s.text].join('\n\n')).join('\n\n').slice(0, MAX_PAGE_TEXT), sections, screenshot: null, images: [] };
  });

  const [shots, fills] = await Promise.all([
    figmaGet<GetImagesResponse>(`/v1/images/${link.key}?ids=${encodeURIComponent(frames.map((f) => f.id).join(','))}&format=png&scale=1`, readers).catch(() => null),
    totals.images.size ? figmaGet<GetImageFillsResponse>(`/v1/files/${link.key}/images`, readers).catch(() => null) : Promise.resolve(null),
  ]);
  frames.forEach((f, i) => (pages[i]!.screenshot = shots?.images?.[f.id] ?? null));
  const imageLinks = fills ? [...totals.images].map((ref) => fills.meta.images[ref]).filter((u): u is string => !!u) : [];
  if (pages[0]) pages[0].images = imageLinks.slice(0, 60);

  const fills_ = top(totals.colors);
  const texts = top(totals.textColors);
  const accents = [...new Set([...fills_, ...texts])].filter((c) => !neutral(c));
  const colors: Record<string, string> = {};
  if (fills_[0]) colors.background = fills_[0];
  if (texts[0]) colors.textPrimary = texts[0];
  if (accents[0]) colors.primary = accents[0];
  if (accents[1]) colors.secondary = accents[1];
  if (accents[2]) colors.accent = accents[2];
  fills_.filter((c) => !Object.values(colors).includes(c)).slice(0, 5).forEach((c, i) => (colors[`extra${i + 1}`] = c));
  const fontList = [...totals.fonts.entries()].sort((a, b) => b[1].count - a[1].count);
  const heading = [...totals.fonts.entries()].sort((a, b) => b[1].maxSize - a[1].maxSize)[0]?.[0] ?? null;
  const radius = totals.radii.length ? `${totals.radii.sort((a, b) => a - b)[Math.floor(totals.radii.length / 2)]}px` : null;

  return {
    kind: 'figma',
    source,
    title: name,
    design: { colors, fonts: { heading, body: fontList[0]?.[0] ?? null, all: fontList.map(([f]) => f) }, fontSizes: {}, radius, colorScheme: colors.background ? (neutral(colors.background) && parseInt(colors.background.slice(1, 3), 16) < 96 ? 'dark' : 'light') : null, logo: null },
    pages,
    products: [],
    collections: [],
    notes: [
      'Colour roles are guessed from how often each colour is used: check them against the screenshots.',
      'Frame pictures expire within 30 days and image links within 14: copy any the site keeps into its media first.',
      ...(frames.length < (root.children ?? []).filter((n) => FRAME_TYPES.has(n.type)).length ? [`Only the first ${frames.length} frames were read.`] : []),
    ],
  };
}

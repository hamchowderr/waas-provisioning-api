// Reading a reference a site is to be built from (docs/references.md): a website link, a Shopify shop, a Figma file or a
// document, turned into one bundle the site builder works from, whoever asked (the MCP connector, the website assistant,
// the dashboard, the SDKs or an automation app). Websites are read in src/referencesite.ts (the platform's own data
// first, then every page with Firecrawl); documents with Firecrawl (its official SDK); Figma files from Figma's REST
// API, which has no official client (its types come from @figma/rest-api-spec). Each storefront gets
// REFERENCE_READS_PER_MONTH reads and REFERENCE_CREDITS_PER_MONTH Firecrawl credits a calendar month (UTC); a read that
// fails isn't counted as a read, but the credits it spent are. Reading runs as a job on its own queue.
import type { Document, Firecrawl } from '@mendable/firecrawl-js';
import type { GetFileNodesResponse, GetFileResponse, GetImageFillsResponse, GetImagesResponse } from '@figma/rest-api-spec';
import type { Hono } from 'hono';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { AppEnv } from './app.ts';
import type { Pool } from './db.ts';
import { HttpError } from './errors.ts';
import { isUuid } from './http.ts';
import { publicFetchUpTo } from './publicfetch.ts';
import { ensureQueue, NOTIFY_POLL_SECONDS } from './queue.ts';
import { clip, emptyDesign, pageOf, readWebsite, UnreadableReference, type ReferenceBundle, type ReferenceKind, type ReferencePage, type SiteFirecrawl, type Spend } from './referencesite.ts';
import { Status } from './status.ts';

const REFERENCES_QUEUE = 'references';
/** A read may run this long: a crawl and a batch of 20 minutes each, and the platform's own data. */
const READ_SECONDS = 3600;

export interface ReferenceConfig {
  firecrawlApiKey?: string;
  /** A Figma personal access token (scope file_content:read) of a Dev or Full seat, for Figma's higher rate limits. */
  figmaToken?: string;
  readsPerMonth: number;
  /** Firecrawl credits a storefront may spend a month: about one a page. */
  creditsPerMonth?: number;
  /** The most pages one read takes in, and what a read takes when it doesn't say. */
  maxPagesPerRead?: number;
}

function wholeNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number`);
  return value;
}

export function loadReferenceConfig(env: NodeJS.ProcessEnv): ReferenceConfig {
  return {
    firecrawlApiKey: env.FIRECRAWL_API_KEY?.trim() || undefined,
    figmaToken: env.FIGMA_TOKEN?.trim() || undefined,
    readsPerMonth: wholeNumber(env, 'REFERENCE_READS_PER_MONTH', 50),
    creditsPerMonth: wholeNumber(env, 'REFERENCE_CREDITS_PER_MONTH', 5000),
    maxPagesPerRead: Math.max(1, wholeNumber(env, 'REFERENCE_MAX_PAGES', 500)),
  };
}

/** What the readers call out to; tests replace them. */
export interface ReferenceReaders {
  firecrawl?: SiteFirecrawl & Pick<Firecrawl, 'parse'>;
  figmaToken?: string;
  /** Figma's API. */
  figmaFetch?: typeof fetch;
  /** Websites' own pages and data (WordPress REST, Shopify and Squarespace JSON): a GET that never reaches a private address. */
  siteFetch?: typeof fetch;
  /** How often a crawl is checked on. */
  pollMs?: number;
}

interface ReferenceUsage {
  /** False until the platform has a Firecrawl key: only Figma links (with a Figma token) can be read. */
  available: boolean;
  used: number;
  limit: number;
  creditsUsed: number;
  creditLimit: number;
  maxPages: number;
  resetsAt: string;
}

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

async function referenceUsage(pool: Pool, config: ReferenceConfig, productId: string, now = new Date()): Promise<ReferenceUsage> {
  const { rows } = await pool.query<{ used: number; credits: number }>(
    'SELECT count(*) FILTER (WHERE status <> $3)::int AS used, coalesce(sum(credits_used), 0)::int AS credits FROM site_references WHERE product_id = $1 AND date_created >= $2',
    [productId, monthStart(now), Status.Failed],
  );
  return {
    available: !!config.firecrawlApiKey,
    used: rows[0]!.used,
    limit: config.readsPerMonth,
    creditsUsed: rows[0]!.credits,
    creditLimit: config.creditsPerMonth ?? 5000,
    maxPages: config.maxPagesPerRead ?? 500,
    resetsAt: nextMonth(now),
  };
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

interface ReferenceInput {
  url?: string;
  file?: { name: string; data: string; contentType?: string };
  maxPages?: number;
}

/** Checks a request and works out its kind. Throws a 400 HttpError for anything it can't read. */
export function parseReferenceInput(body: unknown, pageLimit = 500): { kind: ReferenceKind; source: string; maxPages: number; upload?: { data: Buffer; type: string } } {
  const input = (body ?? {}) as ReferenceInput;
  const maxPages = input.maxPages ?? pageLimit;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > pageLimit) throw new HttpError(400, `maxPages must be a whole number from 1 to ${pageLimit}`);
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
async function startReference(pool: Pool, boss: PgBoss, config: ReferenceConfig, productId: string, body: unknown, now = new Date()) {
  const input = parseReferenceInput(body, config.maxPagesPerRead ?? 500);
  if (input.kind === 'figma' ? !config.figmaToken : !config.firecrawlApiKey) {
    throw new HttpError(503, input.kind === 'figma' ? "Reading Figma files isn't set up on this server yet." : "Reading references isn't set up on this server yet.");
  }
  const usage = await referenceUsage(pool, config, productId, now);
  if (usage.used >= usage.limit) throw new HttpError(429, `You've used this month's ${usage.limit} reference reads. They start again on the 1st.`);
  if (input.kind !== 'figma' && usage.creditsUsed >= usage.creditLimit) throw new HttpError(429, `You've used this month's ${usage.creditLimit} reading credits. They start again on the 1st.`);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO site_references (product_id, kind, source, max_pages, upload, upload_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [productId, input.kind, input.source, input.maxPages, input.upload?.data ?? null, input.upload?.type ?? null],
  );
  const id = rows[0]!.id;
  // Never retried: a second try would spend the credits again. A read that fails can be started again.
  await boss.send(REFERENCES_QUEUE, { referenceId: id }, { retryLimit: 0, expireInSeconds: READ_SECONDS });
  return getReference(pool, productId, id);
}

/** Which part of a big bundle to answer with: `limit` entries of each list (pages, items, products, coverage) from `offset`. */
interface BundleWindow {
  offset: number;
  limit: number | null;
}

function windowOf(query: { offset?: string; limit?: string }): BundleWindow {
  const offset = query.offset ? Number(query.offset) : 0;
  const limit = query.limit ? Number(query.limit) : null;
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'offset must be a whole number');
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new HttpError(400, 'limit must be a whole number from 1');
  return { offset, limit };
}

function windowed(bundle: ReferenceBundle | null, { offset, limit }: BundleWindow) {
  if (!bundle) return { bundle: null, totals: null };
  const legacy = bundle as Partial<ReferenceBundle>;
  const items = legacy.items ?? [];
  const urls = legacy.coverage?.urls ?? [];
  const totals = { pages: bundle.pages.length, items: items.length, products: bundle.products.length, urls: urls.length };
  const cut = <T>(list: T[]) => list.slice(offset, limit === null ? undefined : offset + limit);
  return {
    totals,
    bundle: {
      ...bundle,
      platform: legacy.platform ?? null,
      pages: cut(bundle.pages).map((p) => ({ ...p, mobileScreenshot: p.mobileScreenshot ?? null, links: p.links ?? [] })),
      items: cut(items),
      products: cut(bundle.products).map((p) => ({ ...p, url: p.url ?? null })),
      coverage: legacy.coverage ? { ...legacy.coverage, sitemaps: legacy.coverage.sitemaps ?? [], fromSitemap: legacy.coverage.fromSitemap ?? 0, urls: cut(urls) } : null,
    },
  };
}

async function getReference(pool: Pool, productId: string, id: string, window: BundleWindow = { offset: 0, limit: null }) {
  if (!isUuid(id)) throw new HttpError(404, 'No reference with this id');
  const { rows } = await pool.query(
    'SELECT id, kind, source, status, bundle, error, credits_used, date_created, date_finished FROM site_references WHERE id = $1 AND product_id = $2',
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
    creditsUsed: r.credits_used as number,
    ...windowed((r.bundle as ReferenceBundle | null) ?? null, window),
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
  app.get('/v1/references', async (c) =>
    c.json(await getReference(deps.pool, c.get('productId'), c.req.query('id') ?? '', windowOf({ offset: c.req.query('offset'), limit: c.req.query('limit') })), 200, { 'Cache-Control': 'no-store' }),
  );
}

/** Works the queue: each job reads one reference and stores its bundle, or why it couldn't be read. */
export async function startReferences(
  boss: PgBoss,
  pool: Pool,
  readers: ReferenceReaders,
  { pollingIntervalSeconds = 2, notifyPollingIntervalSeconds = NOTIFY_POLL_SECONDS, log = console, config = () => ({ readsPerMonth: 0 }) }: { pollingIntervalSeconds?: number; notifyPollingIntervalSeconds?: number; log?: Pick<Console, 'error'>; config?: () => ReferenceConfig } = {},
) {
  await ensureQueue(boss, REFERENCES_QUEUE, { retryLimit: 0, expireInSeconds: READ_SECONDS, deleteAfterSeconds: 7 * 24 * 3600 });
  await boss.work(REFERENCES_QUEUE, { includeMetadata: true, pollingIntervalSeconds, notifyPollingIntervalSeconds }, async ([job]: JobWithMetadata<{ referenceId: string }>[]) => {
    if (!job) return;
    const { rows } = await pool.query('SELECT id, product_id, kind, source, max_pages, upload, upload_type FROM site_references WHERE id = $1 AND status = $2', [job.data.referenceId, Status.Pending]);
    const ref = rows[0];
    if (!ref) return;
    const spend: Spend = { credits: 0 };
    try {
      const usage = await referenceUsage(pool, config(), ref.product_id);
      const credits = Math.max(0, usage.creditLimit - usage.creditsUsed);
      const bundle = await readReference({ kind: ref.kind, source: ref.source, maxPages: ref.max_pages, credits, upload: ref.upload ? { data: ref.upload, type: ref.upload_type } : undefined }, readers, spend);
      await pool.query('UPDATE site_references SET status = $2, bundle = $3, credits_used = $4, upload = NULL, date_finished = now() WHERE id = $1', [ref.id, Status.Done, JSON.stringify(bundle), spend.credits]);
    } catch (err) {
      const message = err instanceof UnreadableReference ? err.message : "The reference couldn't be read. Try again in a few minutes.";
      if (!(err instanceof UnreadableReference)) log.error(`reference ${ref.id} (${ref.kind}) failed:`, err);
      await pool.query('UPDATE site_references SET status = $2, error = $3, credits_used = $4, upload = NULL, date_finished = now() WHERE id = $1', [ref.id, Status.Failed, message, spend.credits]);
    }
  });
}

async function readReference(
  ref: { kind: ReferenceKind; source: string; maxPages: number; credits: number; upload?: { data: Buffer; type: string } },
  readers: ReferenceReaders,
  spend: Spend,
): Promise<ReferenceBundle> {
  if (ref.kind === 'figma') return readFigma(ref.source, ref.maxPages, readers);
  if (ref.kind === 'document') return readDocument(ref, readers, spend);
  const firecrawl = firecrawlOf(readers);
  return readWebsite(ref.source, { maxPages: ref.maxPages, credits: ref.credits }, { firecrawl, get: readers.siteFetch ?? publicFetchUpTo(8 * 1024 * 1024), pollMs: readers.pollMs }, spend);
}

function firecrawlOf(readers: ReferenceReaders) {
  if (!readers.firecrawl) throw new UnreadableReference("Reading references isn't set up on this server yet.");
  return readers.firecrawl;
}

async function readDocument(ref: { source: string; upload?: { data: Buffer; type: string } }, readers: ReferenceReaders, spend: Spend): Promise<ReferenceBundle> {
  const fc = firecrawlOf(readers);
  let doc: Document;
  try {
    doc = ref.upload
      ? await fc.parse({ data: ref.upload.data, filename: ref.source, contentType: ref.upload.type }, { formats: ['markdown'] })
      : await fc.scrape(ref.source, { formats: ['markdown', 'images'], timeout: 90_000 });
  } catch (err) {
    throw new UnreadableReference(`The document couldn't be read: ${(err as Error).message}`);
  }
  spend.credits += doc.metadata?.creditsUsed ?? 1;
  return {
    kind: 'document',
    source: ref.source,
    title: (doc.metadata?.title as string | undefined) ?? ref.source.split('/').pop() ?? null,
    platform: null,
    design: emptyDesign(),
    pages: [{ ...pageOf(ref.source, doc), url: ref.source }],
    items: [],
    products: [],
    collections: [],
    coverage: null,
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
    return { url: frame.name, title: frame.name, text: clip(sections.map((s) => [`## ${s.name}`, ...s.text].join('\n\n')).join('\n\n')), sections, screenshot: null, mobileScreenshot: null, images: [], links: [] };
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
    platform: null,
    design: { colors, fonts: { heading, body: fontList[0]?.[0] ?? null, all: fontList.map(([f]) => f) }, fontSizes: {}, radius, colorScheme: colors.background ? (neutral(colors.background) && parseInt(colors.background.slice(1, 3), 16) < 96 ? 'dark' : 'light') : null, logo: null },
    pages,
    items: [],
    products: [],
    collections: [],
    coverage: null,
    notes: [
      'Colour roles are guessed from how often each colour is used: check them against the screenshots.',
      'Frame pictures expire within 30 days and image links within 14: copy any the site keeps into its media first.',
      ...(frames.length < (root.children ?? []).filter((n) => FRAME_TYPES.has(n.type)).length ? [`Only the first ${frames.length} frames were read.`] : []),
    ],
  };
}

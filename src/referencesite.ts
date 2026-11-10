// Reading a website as a reference (docs/references.md): every page, and the platform's own data first. The site's
// platform is worked out from its home page; WordPress (its REST API), Shopify (products.json and collections.json)
// and Squarespace (?format=json) hand over their posts, products and other items as data, free and complete, so
// Firecrawl only reads what that data can't give: each page's look (a full-page screenshot), its text and images,
// and one sample of each kind of item for its layout. Firecrawl (its official SDK): one scrape of the home page with
// the brand and a phone picture, a map of every address it can find, a crawl of the site with the items already read
// left out, then a batch read of whatever the map found that the crawl didn't reach. Every address found ends up in
// the coverage list as read, failed or skipped, with the reason.
import type { BrandingProfile, CrawlErrorsResponse, Document, Firecrawl, ProductProfile, ScrapeOptions } from '@mendable/firecrawl-js';

/** A reference that can't be read for a reason the person can act on; its message is shown to them as is. */
export class UnreadableReference extends Error {}

export type ReferenceKind = 'website' | 'figma' | 'document';
type Platform = 'wordpress' | 'shopify' | 'squarespace' | 'wix' | 'webflow' | 'other';
type Via = 'firecrawl' | 'wordpress' | 'shopify' | 'squarespace';

/** The bundle a reference is read into. Every reader fills the same shape; what a kind can't tell is left empty. */
export interface ReferenceBundle {
  kind: ReferenceKind;
  source: string;
  title: string | null;
  /** The website's platform, null for Figma files and documents. */
  platform: Platform | null;
  design: ReferenceDesign;
  pages: ReferencePage[];
  /** Posts, events and other repeated items, read from the platform's own data. */
  items: ReferenceItem[];
  products: ReferenceProduct[];
  collections: { title: string; handle: string; description: string }[];
  /** For a website: every address found and what became of it. */
  coverage: Coverage | null;
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
  /** The home page at phone width. */
  mobileScreenshot: string | null;
  images: string[];
  /** The home page's links (its menus); empty on other pages. */
  links: string[];
}

interface ReferenceItem {
  /** What the platform calls it: post, event, portfolio, blog and so on. */
  kind: string;
  url: string;
  title: string;
  text: string;
  date: string | null;
  images: string[];
}

export interface ReferenceProduct {
  url: string | null;
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

interface CoverageEntry {
  url: string;
  /** page, product, post (or another item kind), listing, file. */
  kind: string;
  status: 'read' | 'failed' | 'skipped';
  /** Where it was read from: Firecrawl or the platform's own data. */
  via: Via | null;
  reason: string | null;
}

interface Coverage {
  found: number;
  read: number;
  failed: number;
  skipped: number;
  creditsUsed: number;
  urls: CoverageEntry[];
}

/** The Firecrawl calls a website read makes. */
export type SiteFirecrawl = Pick<Firecrawl, 'scrape' | 'map' | 'startCrawl' | 'getCrawlStatus' | 'getCrawlErrors' | 'cancelCrawl' | 'startBatchScrape' | 'getBatchScrapeStatus' | 'getBatchScrapeErrors' | 'cancelBatchScrape'>;

export interface SiteReaders {
  firecrawl: SiteFirecrawl;
  /** The site's own pages and data: a GET that never reaches a private address and follows no redirects. */
  get: typeof fetch;
  /** How often a crawl or batch is checked on; tests make it short. */
  pollMs?: number;
}

/** Firecrawl credits spent so far, kept even when the read fails. */
export interface Spend {
  credits: number;
}

const MAX_PAGE_TEXT = 20_000;
const MAX_ITEM_TEXT = 5_000;
const MAX_ITEMS = 3_000;
const MAX_MAP = 5_000;
/** A crawl, then a batch, may each run this long before what has been read so far is kept. */
const JOB_MS = 20 * 60_000;
const COPY_NOTE = "Someone else's site or file: take its layout and style, and write the store's own text.";

/** Each page: its text, images, a full-page picture, and a product when the page has one (no extra credit). */
const PAGE_OPTIONS: ScrapeOptions = {
  formats: ['markdown', 'images', 'product', { type: 'screenshot', fullPage: true }],
  // The page's own content; the menus, header and footer come from the home page, read whole.
  onlyMainContent: true,
  // Basic proxies first, a stronger one only when a page blocks them: no extra credits either way.
  proxy: 'auto',
  blockAds: true,
  removeBase64Images: true,
  timeout: 60_000,
  // maxAge stays at Firecrawl's default (2 days): a copy that recent is as good as a fresh one for a rebuild, and faster.
};

export const clip = (text: string | undefined, max = MAX_PAGE_TEXT) => (text ?? '').slice(0, max);
export const emptyDesign = (): ReferenceDesign => ({ colors: {}, fonts: { heading: null, body: null, all: [] }, fontSizes: {}, radius: null, colorScheme: null, logo: null });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stripHtml = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const imagesIn = (html: string) => [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1]!).filter((src) => /^https?:/.test(src));

function colorsOf(b: BrandingProfile): Record<string, string> {
  return Object.fromEntries(Object.entries(b.colors ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1]));
}

function fontsOf(b: BrandingProfile): ReferenceDesign['fonts'] {
  const families = b.typography?.fontFamilies ?? {};
  const heading = families.heading ?? families.primary ?? null;
  const body = families.primary ?? families.body ?? null;
  return { heading, body, all: [...new Set([...(b.fonts ?? []).map((f) => f.family), heading, body].filter((f): f is string => !!f))] };
}

function radiusOf(b: BrandingProfile): string | null {
  const radius = (b.spacing as { borderRadius?: unknown } | undefined)?.borderRadius;
  if (typeof radius === 'number') return `${radius}px`;
  return typeof radius === 'string' ? radius : null;
}

function designFromBranding(b: BrandingProfile | undefined): ReferenceDesign {
  if (!b) return emptyDesign();
  const fontSizes = Object.fromEntries(Object.entries(b.typography?.fontSizes ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1]));
  return { colors: colorsOf(b), fonts: fontsOf(b), fontSizes, radius: radiusOf(b), colorScheme: b.colorScheme ?? null, logo: b.logo ?? null };
}

export function pageOf(url: string, doc: Document): ReferencePage {
  return {
    url: doc.metadata?.sourceURL ?? doc.metadata?.url ?? url,
    title: (doc.metadata?.title as string | undefined) ?? null,
    text: clip(doc.markdown),
    sections: [],
    screenshot: doc.screenshot ?? null,
    mobileScreenshot: null,
    images: [...new Set(doc.images ?? [])].slice(0, 60),
    links: [],
  };
}

// --- Which addresses are worth a read ---------------------------------------------------------------------------

/** Addresses never read, each with why. Patterns match the lower-cased path, here and in Firecrawl's excludePaths. */
const SKIP: Array<{ pattern: string; kind: string; reason: string }> = [
  { pattern: '\\.(jpe?g|png|gif|webp|avif|svg|ico|mp4|mov|webm|mp3|zip|xml|txt|json|css|js)$', kind: 'file', reason: 'a file, not a page' },
  { pattern: '\\.(pdf|docx?|xlsx?|pptx?)$', kind: 'file', reason: 'a document: read it as its own reference if the site keeps it' },
  { pattern: '(^|/)(cart|basket|checkout|my-account|account|login|log-in|signin|sign-in|register|logout|wp-admin|wp-login\\.php|wp-json|xmlrpc\\.php)(/|$)', kind: 'listing', reason: 'a cart, account or sign-in page the store makes itself' },
  { pattern: '(^|/)(feed|rss|atom)(/|$)|\\.atom$', kind: 'file', reason: 'a feed' },
  { pattern: '(^|/)(tag|tags|author|search)(/|$)|/page/[0-9]+/?$', kind: 'listing', reason: 'a tag, author, search or next-page listing the store makes itself' },
];
const SKIP_RE = SKIP.map((s) => ({ ...s, re: new RegExp(s.pattern) }));

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');

/** The key an address is counted under: host without www, path without a trailing slash, no query. */
function keyOf(url: string, home: URL): string | null {
  let u: URL;
  try {
    u = new URL(url, home);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || bareHost(u.hostname) !== bareHost(home.hostname)) return null;
  return bareHost(u.hostname) + (u.pathname.replace(/\/+$/, '') || '/');
}

/** Every address found on the site and what became of it. */
class Ledger {
  readonly entries = new Map<string, CoverageEntry & { pending: boolean }>();
  constructor(private readonly home: URL) {}

  /** Records an address as found; files and generated pages are skipped at once. Answers its key, or null for another site. */
  found(url: string, kind = 'page'): string | null {
    const key = keyOf(url, this.home);
    if (!key) return null;
    if (this.entries.has(key)) return key;
    const clean = new URL(url, this.home);
    clean.search = '';
    clean.hash = '';
    const skip = SKIP_RE.find((s) => s.re.test(clean.pathname.toLowerCase()));
    this.entries.set(key, skip ? { url: clean.toString(), kind: skip.kind, status: 'skipped', via: null, reason: skip.reason, pending: false } : { url: clean.toString(), kind, status: 'skipped', via: null, reason: null, pending: true });
    return key;
  }

  private set(url: string, change: Partial<CoverageEntry>, kind?: string) {
    const key = this.found(url, kind);
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry) return;
    Object.assign(entry, change, { pending: false });
  }

  read(url: string, via: Via, kind?: string) {
    this.set(url, { status: 'read', via, reason: null, ...(kind ? { kind } : {}) }, kind);
  }

  failed(url: string, reason: string) {
    const key = keyOf(url, this.home);
    if (key && this.entries.get(key)?.status === 'read') return;
    this.set(url, { status: 'failed', via: 'firecrawl', reason });
  }

  skip(url: string, reason: string) {
    this.set(url, { status: 'skipped', reason });
  }

  key(url: string) {
    return keyOf(url, this.home);
  }

  isRead(url: string) {
    const key = keyOf(url, this.home);
    return !!key && this.entries.get(key)?.status === 'read';
  }

  /** Addresses found but not yet read, failed or skipped. */
  /** Pages Firecrawl itself failed on (a timeout, its own error), worth one more try; not pages the site refused. */
  retryable(): string[] {
    return [...this.entries.values()].filter((e) => e.status === 'failed' && !/^the site answered|^another site/.test(e.reason ?? '')).map((e) => e.url);
  }

  pending(): string[] {
    return [...this.entries.values()].filter((e) => e.pending).map((e) => e.url);
  }

  coverage(creditsUsed: number): Coverage {
    const urls = [...this.entries.values()].map(({ pending, ...e }) => (pending ? { ...e, reason: e.reason ?? 'not reached' } : e));
    const count = (status: CoverageEntry['status']) => urls.filter((u) => u.status === status).length;
    return { found: urls.length, read: count('read'), failed: count('failed'), skipped: count('skipped'), creditsUsed, urls };
  }
}

// --- The platform and its own data ------------------------------------------------------------------------------

/** A GET that follows up to four redirects, each through the same guarded fetch; answers the response and where it ended. */
async function follow(get: typeof fetch, url: string, accept: string): Promise<{ res: Response; url: string } | null> {
  let next = url;
  for (let hop = 0; hop < 5; hop++) {
    try {
      const res = await get(next, { headers: { accept, 'user-agent': 'AnyPress reference reader' }, signal: AbortSignal.timeout(20_000) });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        next = new URL(location, next).toString();
        continue;
      }
      return { res, url: next };
    } catch {
      return null;
    }
  }
  return null;
}

async function getJson<T = any>(get: typeof fetch, url: string): Promise<{ data: T; headers: Headers } | null> {
  const res = (await follow(get, url, 'application/json'))?.res;
  if (!res?.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
  try {
    return { data: (await res.json()) as T, headers: res.headers };
  } catch {
    return null;
  }
}

const SIGNS: Array<[Platform, RegExp]> = [
  ['shopify', /cdn\.shopify\.com|shopify\.theme|x-shopid|myshopify\.com/i],
  ['wordpress', /api\.w\.org|\/wp-content\/|\/wp-includes\/|generator" content="wordpress/i],
  ['squarespace', /static1\.squarespace\.com|squarespace-cdn\.com|server: squarespace/i],
  ['wix', /static\.wixstatic\.com|x-wix-request-id|generator" content="wix/i],
  ['webflow', /data-wf-site|website-files\.com|generator" content="webflow/i],
];

/** The platform behind the home page, from its headers and HTML (or what Firecrawl saw when the site blocks us). */
function platformOf(signals: string): Platform {
  return SIGNS.find(([, re]) => re.test(signals))?.[0] ?? 'other';
}

/** The home page's headers and HTML, where it redirects to, and the WordPress REST API's address when it gives one. */
async function probe(home: URL, get: typeof fetch): Promise<{ signals: string; wpApi: string | null; home: URL }> {
  const got = await follow(get, home.toString(), 'text/html');
  if (!got?.res.ok) return { signals: '', wpApi: null, home };
  const { res } = got;
  const html = await res.text().catch(() => '');
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
  const link = /<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/.exec(res.headers.get('link') ?? '')?.[1] ?? /<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]+href=["']([^"']+)["']/i.exec(html)?.[1] ?? null;
  // Only a redirect within the same site (http to https, www or not) moves the start.
  const landed = new URL(got.url);
  return { signals: `${headers}\n${html}`, wpApi: link, home: bareHost(landed.hostname) === bareHost(home.hostname) ? new URL(landed.origin + landed.pathname) : home };
}

interface NativeRead {
  via: Via;
  items: ReferenceItem[];
  products: ReferenceProduct[];
  collections: ReferenceBundle['collections'];
  /** Pages the platform lists, read or not: so a page no link points to is still found. */
  pageUrls: string[];
  /** Other addresses its data already covers, such as a shop's collection pages. */
  listed: { url: string; kind: string }[];
  notes: string[];
}

/** A route of the WordPress REST API, whether the site has pretty links (/wp-json/) or not (?rest_route=). */
function wpUrl(root: string, route: string, params: Record<string, string | number>): string {
  const u = new URL(root);
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  if (u.searchParams.has('rest_route')) {
    u.searchParams.set('rest_route', `/${route}`);
    for (const [k, v] of query) u.searchParams.set(k, v);
    return u.toString();
  }
  return `${root.replace(/\/?$/, '/')}${route}?${query}`;
}

/** Every entry of a WordPress collection, 100 a page, at most 20 pages. */
async function wpAll(get: typeof fetch, root: string, route: string, params: Record<string, string | number>): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await getJson<any[]>(get, wpUrl(root, route, { ...params, per_page: 100, page }));
    if (!res || !Array.isArray(res.data)) break;
    out.push(...res.data);
    if (page >= Number(res.headers.get('x-wp-totalpages') ?? 1) || out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** Post types that are site machinery, not content. */
const WP_INTERNAL = /^(attachment|nav_menu_item|wp_.*|jp_.*|jetpack_.*|feedback|product|product_variation|shop_.*|elementor_.*|e-landing-page|fluent-products)$/;

function wpItem(kind: string, e: Record<string, any>): ReferenceItem {
  const html = String(e.content?.rendered ?? '');
  const featured = e._embedded?.['wp:featuredmedia']?.[0]?.source_url;
  return {
    kind,
    url: String(e.link ?? ''),
    title: stripHtml(String(e.title?.rendered ?? '')),
    text: clip(stripHtml(html), MAX_ITEM_TEXT),
    date: e.date ? String(e.date) : null,
    images: [...new Set([...(featured ? [String(featured)] : []), ...imagesIn(html)])].slice(0, 20),
  };
}

type WpType = { rest_base?: string; rest_namespace?: string };
const wpContentType = (slug: string, type: WpType) => !WP_INTERNAL.test(slug) && !!type.rest_base && !type.rest_base.includes('(');

async function readWordPress(root: string, get: typeof fetch): Promise<NativeRead | null> {
  const types = await getJson<Record<string, WpType>>(get, wpUrl(root, 'wp/v2/types', {}));
  if (!types) return null;
  const read: NativeRead = { via: 'wordpress', items: [], products: [], collections: [], pageUrls: [], listed: [], notes: [] };
  for (const [slug, type] of Object.entries(types.data).filter(([slug, type]) => wpContentType(slug, type))) {
    if (read.items.length >= MAX_ITEMS) break;
    const entries = await wpAll(get, root, `${type.rest_namespace ?? 'wp/v2'}/${type.rest_base}`, { _fields: 'link,title,content,date,_links,_embedded', _embed: 'wp:featuredmedia' });
    if (slug === 'page') read.pageUrls.push(...entries.map((e) => String(e.link ?? '')).filter(Boolean));
    else read.items.push(...entries.map((e) => wpItem(slug, e)));
  }
  read.products = (await wpAll(get, root, 'wc/store/v1/products', {})).map(wooProduct);
  read.notes.push('A WordPress site: its pages, posts and other entries were listed from its REST API. If it is your own site, Move a site in brings over everything instead (content, media, plugins and settings).');
  return read;
}

function wooProduct(p: Record<string, any>): ReferenceProduct {
  const minor = Number(p.prices?.currency_minor_unit ?? 2);
  const money = (v: unknown) => (v === undefined || v === null || v === '' ? null : (Number(v) / 10 ** minor).toFixed(minor));
  const price = money(p.prices?.price);
  const compareAt = p.on_sale ? money(p.prices?.regular_price) : null;
  const variants = Array.isArray(p.variations) && p.variations.length
    ? p.variations.map((v: Record<string, any>) => ({ title: (v.attributes ?? []).map((a: Record<string, any>) => a.value).join(' / '), sku: null, price, compareAtPrice: compareAt, available: p.is_in_stock !== false }))
    : [{ title: 'Default', sku: p.sku ? String(p.sku) : null, price, compareAtPrice: compareAt, available: p.is_in_stock !== false }];
  return {
    url: p.permalink ? String(p.permalink) : null,
    title: stripHtml(String(p.name ?? '')),
    handle: String(p.slug ?? ''),
    description: clip(stripHtml(String(p.description || p.short_description || '')), MAX_ITEM_TEXT),
    vendor: null,
    type: p.categories?.[0]?.name ? String(p.categories[0].name) : null,
    tags: (p.tags ?? []).map((t: Record<string, any>) => String(t.name)),
    price,
    compareAtPrice: compareAt,
    images: (p.images ?? []).map((i: Record<string, any>) => String(i.src ?? '')).filter(Boolean),
    variants,
  };
}

/** A Shopify shop's products and collections from its public products.json and collections.json: 250 a page, at most 20 pages. */
async function readShopify(home: URL, get: typeof fetch): Promise<NativeRead | null> {
  const products: ReferenceProduct[] = [];
  let truncated = false;
  for (let page = 1; page <= 20; page++) {
    const res = await getJson(get, `${home.origin}/products.json?limit=250&page=${page}`);
    if (!res || !Array.isArray(res.data.products)) {
      if (page === 1) return null;
      break;
    }
    for (const p of res.data.products) products.push(shopifyProduct(home, p));
    if (res.data.products.length < 250) break;
    if (page === 20) truncated = true;
  }
  const collections = await shopifyCollections(home, get);
  return {
    via: 'shopify',
    items: [],
    products,
    collections,
    pageUrls: [],
    listed: collections.map((c) => ({ url: `${home.origin}/collections/${c.handle}`, kind: 'collection' })),
    notes: [`A Shopify shop: ${products.length} products${truncated ? ' (the first 5,000)' : ''} and ${collections.length} collections read from its public product list.`],
  };
}

/** Every collection from collections.json, 250 a page, at most 20 pages. */
async function shopifyCollections(home: URL, get: typeof fetch): Promise<ReferenceBundle['collections']> {
  const out: ReferenceBundle['collections'] = [];
  for (let page = 1; page <= 20; page++) {
    const list: unknown = (await getJson(get, `${home.origin}/collections.json?limit=250&page=${page}`))?.data?.collections;
    if (!Array.isArray(list)) break;
    out.push(...list.map((x: Record<string, any>) => ({ title: String(x.title ?? ''), handle: String(x.handle ?? ''), description: stripHtml(String(x.description ?? '')) })));
    if (list.length < 250) break;
  }
  return out;
}

function shopifyProduct(home: URL, p: Record<string, any>): ReferenceProduct {
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  return {
    url: p.handle ? `${home.origin}/products/${p.handle}` : null,
    title: String(p.title ?? ''),
    handle: String(p.handle ?? ''),
    description: clip(stripHtml(String(p.body_html ?? '')), MAX_ITEM_TEXT),
    vendor: str(p.vendor),
    type: str(p.product_type),
    tags: Array.isArray(p.tags) ? p.tags.map(String) : typeof p.tags === 'string' && p.tags ? p.tags.split(',').map((t: string) => t.trim()) : [],
    price: str(variants[0]?.price),
    compareAtPrice: str(variants[0]?.compare_at_price),
    images: (Array.isArray(p.images) ? p.images : []).map((i: Record<string, any>) => String(i.src ?? '')).filter(Boolean),
    variants: variants.map((v: Record<string, any>) => ({ title: String(v.title ?? ''), sku: str(v.sku), price: str(v.price), compareAtPrice: str(v.compare_at_price), available: v.available !== false })),
  };
}

/** Folders the map found addresses under (/blog/first-post is under blog): each may be a collection. */
function squarespaceFolders(home: URL, links: string[]): string[] {
  const folders = new Set<string>();
  for (const link of links) {
    const parts = new URL(link, home).pathname.split('/').filter(Boolean);
    if (parts.length > 1) folders.add(parts[0]!);
  }
  return [...folders].slice(0, 20);
}

/** The next page of a collection's ?format=json, or null on the last. */
function nextSquarespacePage(home: URL, data: Record<string, any>): string | null {
  const more: string | undefined = data.pagination?.nextPage ? data.pagination.nextPageUrl : undefined;
  if (!more) return null;
  return `${new URL(more, home).toString()}${more.includes('?') ? '&' : '?'}format=json`;
}

/** One page of a collection into `read`: its items and products, and the collection itself on the first page. Answers whether it had any. */
function takeSquarespacePage(home: URL, folder: string, data: Record<string, any>, first: boolean, read: NativeRead): boolean {
  const items: unknown = data.items ?? [...(data.upcoming ?? []), ...(data.past ?? [])];
  if (!Array.isArray(items) || !items.length) return false;
  const collection = data.collection ?? {};
  if (first) read.collections.push({ title: String(collection.title ?? folder), handle: folder, description: stripHtml(String(collection.description ?? '')) });
  for (const item of items as Record<string, any>[]) {
    if (Array.isArray(item.variants) && item.variants.length) read.products.push(squarespaceProduct(home, item));
    else read.items.push(squarespaceItem(home, String(collection.typeName ?? folder), item));
  }
  return true;
}

/** One collection's items, 20 pages at most, into `read`. */
async function readSquarespaceCollection(home: URL, folder: string, get: typeof fetch, read: NativeRead) {
  let next: string | null = `${home.origin}/${folder}?format=json`;
  for (let page = 0; next && page < 20 && read.items.length + read.products.length < MAX_ITEMS; page++) {
    const data: Record<string, any> | undefined = (await getJson(get, next))?.data;
    if (!data || !takeSquarespacePage(home, folder, data, page === 0, read)) return;
    next = nextSquarespacePage(home, data);
  }
}

/** Squarespace collections (blogs, events, shops, portfolios) from ?format=json: each folder the map found is asked once. */
async function readSquarespace(home: URL, links: string[], get: typeof fetch): Promise<NativeRead> {
  const read: NativeRead = { via: 'squarespace', items: [], products: [], collections: [], pageUrls: [], listed: [], notes: [] };
  for (const folder of squarespaceFolders(home, links)) await readSquarespaceCollection(home, folder, get, read);
  read.notes.push(`A Squarespace site: ${read.items.length} items and ${read.products.length} products read from its collections' own data.`);
  return read;
}

function squarespaceItem(home: URL, kind: string, item: Record<string, any>): ReferenceItem {
  const html = String(item.body ?? item.excerpt ?? '');
  return {
    kind,
    url: new URL(String(item.fullUrl ?? ''), home).toString(),
    title: String(item.title ?? ''),
    text: clip(stripHtml(html), MAX_ITEM_TEXT),
    date: item.publishOn ? new Date(Number(item.publishOn)).toISOString() : null,
    images: [...new Set([...(item.assetUrl ? [String(item.assetUrl)] : []), ...imagesIn(html)])].slice(0, 20),
  };
}

function squarespaceProduct(home: URL, item: Record<string, any>): ReferenceProduct {
  const money = (v: Record<string, any> | undefined, cents: unknown) => (v?.value ? String(v.value) : typeof cents === 'number' ? (cents / 100).toFixed(2) : null);
  const variants = (item.variants as Record<string, any>[]).map((v) => ({
    title: Object.values(v.attributes ?? {}).join(' / ') || 'Default',
    sku: v.sku ? String(v.sku) : null,
    price: money(v.priceMoney, v.price),
    compareAtPrice: v.onSale ? money(v.priceMoney, v.price) : null,
    available: v.unlimited === true || Number(v.qtyInStock ?? v.stock?.quantity ?? 1) > 0 || v.stock?.unlimited === true,
  }));
  const sale = (item.variants as Record<string, any>[])[0];
  return {
    url: new URL(String(item.fullUrl ?? ''), home).toString(),
    title: String(item.title ?? ''),
    handle: String(item.urlId ?? ''),
    description: clip(stripHtml(String(item.body ?? item.excerpt ?? '')), MAX_ITEM_TEXT),
    vendor: null,
    type: null,
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    price: sale?.onSale ? money(sale.salePriceMoney, sale.salePrice) : (variants[0]?.price ?? null),
    compareAtPrice: sale?.onSale ? (variants[0]?.price ?? null) : null,
    images: (Array.isArray(item.items) ? item.items : []).map((i: Record<string, any>) => String(i.assetUrl ?? '')).filter(Boolean),
    variants,
  };
}

/** A product Firecrawl found on a page (from the page's structured data), for platforms that don't list theirs. */
function productOf(p: ProductProfile): ReferenceProduct {
  const amount = (v: { amount: number } | undefined) => (v ? String(v.amount) : null);
  const first = p.variants[0];
  return {
    url: p.url,
    title: p.title,
    handle: new URL(p.url).pathname.split('/').filter(Boolean).pop() ?? '',
    description: clip(p.description, MAX_ITEM_TEXT),
    vendor: p.brand ?? null,
    type: p.category ?? null,
    tags: [],
    price: amount(first?.price),
    compareAtPrice: amount(first?.sale?.originalPrice),
    images: [...new Set(p.variants.flatMap((v) => (v.images ?? []).map((i) => i.url)))],
    variants: p.variants.map((v) => ({ title: v.title ?? (Object.values(v.values ?? {}).join(' / ') || 'Default'), sku: v.sku ?? null, price: amount(v.price), compareAtPrice: amount(v.sale?.originalPrice), available: v.availability.inStock })),
  };
}

async function readNative(platform: Platform, home: URL, wpApi: string | null, links: string[], get: typeof fetch): Promise<NativeRead | null> {
  if (platform === 'wordpress') return readWordPress(wpApi ?? `${home.origin}/wp-json/`, get);
  if (platform === 'squarespace') return readSquarespace(home, links, get);
  // A shop can hide its platform behind a proxy; products.json answers either way.
  if (platform === 'shopify' || platform === 'other') return readShopify(home, get);
  return null;
}

// --- Firecrawl --------------------------------------------------------------------------------------------------

type JobResult = { docs: Document[]; errors: CrawlErrorsResponse; credits: number; timedOut: boolean };

/** Waits for a crawl or batch, keeping what was read when it runs past JOB_MS. */
async function waitForJob(
  status: () => Promise<{ status: string; data: Document[]; creditsUsed?: number }>,
  errors: () => Promise<CrawlErrorsResponse>,
  cancel: () => Promise<unknown>,
  pollMs: number,
): Promise<JobResult> {
  const deadline = Date.now() + JOB_MS;
  for (;;) {
    const job = await status();
    const timedOut = job.status === 'scraping' && Date.now() > deadline;
    if (job.status !== 'scraping' || timedOut) {
      if (timedOut) await cancel().catch(() => undefined);
      const errs = await errors().catch(() => ({ errors: [], robotsBlocked: [] }));
      return { docs: job.data ?? [], errors: errs, credits: job.creditsUsed ?? (job.data ?? []).length, timedOut };
    }
    await sleep(pollMs);
  }
}

/** A path pattern for Firecrawl's excludePaths that matches exactly this address's path. */
const exactPath = (url: string) => `^${new URL(url).pathname.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`;

interface SiteRead {
  pages: ReferencePage[];
  products: ReferenceProduct[];
}

/** Takes in what a crawl or batch read: pages into the bundle, every address into the ledger. */
function takeIn(result: JobResult, ledger: Ledger, out: SiteRead, sampleKinds: Map<string, string>) {
  for (const doc of result.docs) {
    const url = doc.metadata?.sourceURL ?? doc.metadata?.url;
    if (!url) continue;
    const code = doc.metadata?.statusCode ?? 200;
    if (code >= 400) {
      ledger.failed(url, `the site answered ${code}`);
      continue;
    }
    const key = ledger.key(url);
    ledger.read(url, 'firecrawl', key ? sampleKinds.get(key) : undefined);
    out.pages.push(pageOf(url, doc));
    if (doc.product) out.products.push(productOf(doc.product));
  }
  for (const e of result.errors.errors) ledger.failed(e.url, e.code === 'EXTERNAL_LINK' ? 'another site' : e.error);
  for (const url of result.errors.robotsBlocked) ledger.skip(url, "the site's robots.txt asks readers to stay out");
}

/** The home page whole (menus, brand, products), and at phone width. Answers the page and what Firecrawl saw. */
async function readHome(fc: SiteFirecrawl, source: string, home: URL, spend: Spend): Promise<{ first: Document; page: ReferencePage }> {
  let first: Document;
  try {
    first = await fc.scrape(source, { formats: ['markdown', 'links', 'images', 'branding', 'product', { type: 'screenshot', fullPage: true }], onlyMainContent: false, proxy: 'auto', blockAds: true, removeBase64Images: true, timeout: 60_000 });
  } catch (err) {
    throw new UnreadableReference(`${home.hostname} couldn't be read: ${(err as Error).message}`);
  } finally {
    spend.credits += 1;
  }
  const phone = await fc.scrape(source, { formats: [{ type: 'screenshot', fullPage: true }], mobile: true, proxy: 'auto', blockAds: true, timeout: 60_000 }).catch(() => null);
  spend.credits += 1;
  return { first, page: { ...pageOf(source, first), mobileScreenshot: phone?.screenshot ?? null, links: [...new Set(first.links ?? [])].slice(0, 300) } };
}

/**
 * Marks what the platform handed over as read, keeping one of each kind for Firecrawl to read for its look. Answers
 * the samples (by address key) and the paths the crawl leaves out.
 */
function takeNative(native: NativeRead | null, platform: Platform, ledger: Ledger): { samples: Map<string, string>; excluded: string[] } {
  const samples = new Map<string, string>();
  const excluded: string[] = [];
  if (!native) return { samples, excluded };
  const entries = [...native.items.map((i) => ({ url: i.url, kind: i.kind })), ...native.products.flatMap((p) => (p.url ? [{ url: p.url, kind: 'product' }] : [])), ...native.listed];
  const sampled = new Set<string>();
  for (const { url, kind } of entries) {
    const key = url ? ledger.found(url, kind) : null;
    if (!key) continue;
    if (!sampled.has(kind)) {
      sampled.add(kind);
      samples.set(key, kind);
      continue;
    }
    ledger.read(url, native.via, kind);
    excluded.push(exactPath(url));
  }
  if (platform === 'shopify') excluded.push('^/products/.+', '^/collections/[^/]+/products/.+', '^/collections/[^/]+/?$');
  return { samples, excluded };
}

interface Run {
  fc: SiteFirecrawl;
  pollMs: number;
  ledger: Ledger;
  out: SiteRead;
  samples: Map<string, string>;
  spend: Spend;
  timedOut: boolean;
}

/** Crawls the site from its home page: the sitemap and every link, the platform's items left out. */
async function crawlSite(run: Run, source: string, limit: number, excluded: string[]) {
  const { fc } = run;
  const { id } = await fc.startCrawl(source, {
    limit,
    sitemap: 'include',
    crawlEntireDomain: true,
    allowSubdomains: false,
    ignoreQueryParameters: true,
    deduplicateSimilarURLs: true,
    // Firecrawl takes at most 1,000 patterns; past that the crawl's limit still caps the cost.
    excludePaths: [...SKIP.map((s) => s.pattern), ...excluded].slice(0, 1000),
    scrapeOptions: PAGE_OPTIONS,
  });
  const crawl = await waitForJob(() => fc.getCrawlStatus(id), () => fc.getCrawlErrors(id), () => fc.cancelCrawl(id), run.pollMs);
  run.spend.credits += crawl.credits;
  run.timedOut ||= crawl.timedOut;
  takeIn({ ...crawl, docs: crawl.docs.filter((d) => !run.ledger.isRead(d.metadata?.sourceURL ?? '')) }, run.ledger, run.out, run.samples);
}

/** Reads the addresses given in one batch. */
async function batchRead(run: Run, urls: string[]) {
  const { fc } = run;
  const { id } = await fc.startBatchScrape(urls, { options: PAGE_OPTIONS, ignoreInvalidURLs: true });
  const batch = await waitForJob(() => fc.getBatchScrapeStatus(id), () => fc.getBatchScrapeErrors(id), () => fc.cancelBatchScrape(id), run.pollMs);
  run.spend.credits += batch.credits;
  run.timedOut ||= batch.timedOut;
  takeIn(batch, run.ledger, run.out, run.samples);
}

/** Why pages were left unread, or null when nothing stopped the read. */
function capOf(run: Run, limits: { maxPages: number; credits: number }): string | null {
  if (limits.maxPages - run.out.pages.length <= 0) return `the ${limits.maxPages}-page limit of this read`;
  if (limits.credits - run.spend.credits <= 0) return "this month's reading credits";
  return run.timedOut ? 'the time a read may take' : null;
}

function siteNotes(native: NativeRead | null, coverage: Coverage, unread: number, cap: string | null): string[] {
  const notes = [COPY_NOTE, 'Screenshots expire within a day and image links can change: copy any image the site keeps into its media first.', ...(native?.notes ?? [])];
  notes.push(`${coverage.found} addresses found: ${coverage.read} read, ${coverage.failed} failed, ${coverage.skipped} skipped. Each one and why is in coverage.urls.`);
  if (unread && cap) notes.push(`${unread} pages were not read because ${cap} was reached. Read again with a higher maxPages to take them in.`);
  return notes;
}

/** The platform's own products, or else those Firecrawl found on the pages. */
function productsOf(native: NativeRead | null, out: SiteRead, first: Document): ReferenceProduct[] {
  if (native?.products.length) return native.products;
  return dedupeProducts([...(first.product ? [productOf(first.product)] : []), ...out.products]);
}

/**
 * Reads a website: every page Firecrawl can find, up to `maxPages` and the `credits` left, with the platform's own
 * data first. Spends 3 credits before the pages (home page, its phone picture, the map), then about 1 a page.
 */
export async function readWebsite(requested: string, limits: { maxPages: number; credits: number }, readers: SiteReaders, spend: Spend): Promise<ReferenceBundle> {
  const fc = readers.firecrawl;
  const site = await probe(new URL(requested), readers.get);
  const home = site.home;
  const source = home.toString();
  const { first, page } = await readHome(fc, source, home, spend);
  const mapped = await fc.map(source, { limit: MAX_MAP, sitemap: 'include', includeSubdomains: false, ignoreQueryParameters: true }).catch(() => ({ links: [] }));
  spend.credits += 1;
  const links = (mapped.links ?? []).map((l) => l.url);

  const platform = platformOf(site.signals || JSON.stringify({ meta: first.metadata, images: first.images, links: first.links }));
  const native = await readNative(platform, home, site.wpApi, links, readers.get);
  const ledger = new Ledger(home);
  ledger.read(page.url, 'firecrawl');
  for (const l of [...links, ...(native?.pageUrls ?? [])]) ledger.found(l);
  const { samples, excluded } = takeNative(native, platform, ledger);

  const run: Run = { fc, pollMs: readers.pollMs ?? 5_000, ledger, out: { pages: [page], products: [] }, samples, spend, timedOut: false };
  const budget = () => Math.min(limits.maxPages - run.out.pages.length, limits.credits - spend.credits);
  if (budget() > 0) await crawlSite(run, source, budget(), excluded);
  // What the map or the platform listed that the crawl didn't reach (pages no link points to, the samples).
  const left = ledger.pending().slice(0, Math.max(0, budget()));
  if (left.length) await batchRead(run, left);
  // Pages Firecrawl failed on get one more try.
  const retry = ledger.retryable().slice(0, Math.max(0, budget()));
  if (retry.length) await batchRead(run, retry);

  const unread = ledger.pending();
  const cap = capOf(run, limits);
  for (const url of unread) ledger.skip(url, cap ? `not read: ${cap} was reached` : 'not reached');
  const coverage = ledger.coverage(spend.credits);
  return {
    kind: 'website',
    source,
    title: first.branding?.brandName ?? (first.metadata?.title as string | undefined) ?? home.hostname,
    platform,
    design: designFromBranding(first.branding),
    pages: run.out.pages,
    items: native?.items ?? [],
    products: productsOf(native, run.out, first),
    collections: native?.collections ?? [],
    coverage,
    notes: siteNotes(native, coverage, unread.length, cap),
  };
}

function dedupeProducts(products: ReferenceProduct[]): ReferenceProduct[] {
  const seen = new Set<string>();
  return products.filter((p) => {
    const key = p.url ?? p.handle;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

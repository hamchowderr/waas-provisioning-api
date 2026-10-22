import { createHash } from 'node:crypto';

/**
 * The wordpress.org plugin directory: the same search and plugin details wp-admin's Add Plugins screen
 * uses (api.wordpress.org/plugins/info/1.2), and the plugin zips from downloads.wordpress.org.
 * Plugin choices (src/pluginchoices.ts) search it and pin what they add to one version and its SHA-256.
 */

/** A plugin as the dashboard shows it: its icon and name first. */
export interface WpOrgPlugin {
  slug: string;
  name: string;
  version: string;
  icon: string | null;
  author: string;
  shortDescription: string;
  /** 0 to 100. */
  rating: number;
  numRatings: number;
  activeInstalls: number;
  lastUpdated: string | null;
  /** The newest WordPress it was tested with, and the oldest WordPress and PHP it needs. */
  testedUpTo: string | null;
  requiresWordPress: string | null;
  requiresPhp: string | null;
  homepage: string | null;
}

export interface WpOrgSearch {
  page: number;
  pages: number;
  results: number;
  plugins: WpOrgPlugin[];
}

export interface WpOrg {
  search(query: string, page: number): Promise<WpOrgSearch>;
  /** Null when the directory has no such plugin (or it was closed). */
  plugin(slug: string): Promise<(WpOrgPlugin & { versions: string[] }) | null>;
  /** The plugin's zip at that version, with its SHA-256. */
  download(slug: string, version: string): Promise<{ body: Uint8Array; sha256: string }>;
}

export const PLUGIN_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const PLUGIN_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
/** Larger zips are refused; the biggest wordpress.org plugins stores would use are under 40 MB. */
export const MAX_PLUGIN_ZIP = 64 * 1024 * 1024;

const API = 'https://api.wordpress.org/plugins/info/1.2/';
const PAGE_SIZE = 24;
const SEARCH_TTL = 10 * 60_000;
const PLUGIN_TTL = 60 * 60_000;
const CACHE_SIZE = 500;

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const orNull = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** wordpress.org sends author as a link and names with HTML entities. */
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/** "2026-09-01 4:47pm GMT" -> ISO date, or null. */
function updated(value: unknown): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})(am|pm) GMT$/.exec(text(value));
  if (!m) return null;
  const hour = (Number(m[2]) % 12) + (m[4] === 'pm' ? 12 : 0);
  return new Date(`${m[1]}T${String(hour).padStart(2, '0')}:${m[3]}:00Z`).toISOString();
}

/** The icon wp-admin would show: the SVG, else the largest PNG; https only. */
function icon(icons: unknown): string | null {
  if (!icons || typeof icons !== 'object') return null;
  const i = icons as Record<string, unknown>;
  const url = orNull(i.svg) ?? orNull(i['2x']) ?? orNull(i['1x']) ?? orNull(i.default);
  return url && url.startsWith('https://') ? url : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toPlugin(p: any): WpOrgPlugin {
  return {
    slug: text(p.slug),
    name: plain(text(p.name)),
    version: text(p.version),
    icon: icon(p.icons),
    author: plain(text(p.author)),
    shortDescription: plain(text(p.short_description)),
    rating: Number(p.rating) || 0,
    numRatings: Number(p.num_ratings) || 0,
    activeInstalls: Number(p.active_installs) || 0,
    lastUpdated: updated(p.last_updated),
    testedUpTo: orNull(p.tested),
    requiresWordPress: orNull(p.requires),
    requiresPhp: orNull(p.requires_php),
    homepage: orNull(p.homepage),
  };
}

/** A small cache with a lifetime per entry; the oldest entry goes once it is full. */
class Cache<T> {
  private entries = new Map<string, { at: number; value: T }>();
  constructor(private readonly ttl: number) {}
  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttl) return hit.value;
    this.entries.delete(key);
    return undefined;
  }
  set(key: string, value: T) {
    if (this.entries.size >= CACHE_SIZE) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { at: Date.now(), value });
  }
}

/** The wordpress.org directory over HTTPS, with searches cached for 10 minutes and plugin details for an hour. */
export function wordpressOrg(fetchFn: typeof fetch = fetch): WpOrg {
  const searches = new Cache<WpOrgSearch>(SEARCH_TTL);
  const plugins = new Cache<(WpOrgPlugin & { versions: string[] }) | null>(PLUGIN_TTL);

  async function call(params: Record<string, string>) {
    const res = await fetchFn(`${API}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`wordpress.org answered HTTP ${res.status}`);
    return res.json();
  }

  return {
    async search(query, page) {
      const key = `${query.toLowerCase()}\n${page}`;
      const cached = searches.get(key);
      if (cached) return cached;
      const body = await call({
        action: 'query_plugins',
        'request[search]': query,
        'request[page]': String(page),
        'request[per_page]': String(PAGE_SIZE),
        'request[fields][description]': '0',
        'request[fields][sections]': '0',
        'request[fields][icons]': '1',
      });
      const result: WpOrgSearch = {
        page,
        pages: Number(body?.info?.pages) || 0,
        results: Number(body?.info?.results) || 0,
        plugins: Array.isArray(body?.plugins) ? body.plugins.map(toPlugin).filter((p: WpOrgPlugin) => PLUGIN_SLUG.test(p.slug)) : [],
      };
      searches.set(key, result);
      return result;
    },

    async plugin(slug) {
      const cached = plugins.get(slug);
      if (cached !== undefined) return cached;
      const body = await call({
        action: 'plugin_information',
        'request[slug]': slug,
        'request[fields][versions]': '1',
        'request[fields][icons]': '1',
        'request[fields][sections]': '0',
        'request[fields][description]': '0',
      });
      // A closed or unknown plugin comes back as 404, or as an error object.
      const result = body && !body.error && body.slug === slug ? { ...toPlugin(body), versions: Object.keys(body.versions ?? {}).filter((v) => v !== 'trunk') } : null;
      plugins.set(slug, result);
      return result;
    },

    async download(slug, version) {
      const res = await fetchFn(`https://downloads.wordpress.org/plugin/${slug}.${version}.zip`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`Downloading ${slug} ${version} from wordpress.org failed: HTTP ${res.status}`);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_PLUGIN_ZIP) throw new Error(`${slug} ${version} is larger than 64 MB`);
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.length > MAX_PLUGIN_ZIP) throw new Error(`${slug} ${version} is larger than 64 MB`);
      if (body[0] !== 0x50 || body[1] !== 0x4b) throw new Error(`${slug} ${version} from wordpress.org is not a zip`);
      return { body, sha256: createHash('sha256').update(body).digest('hex') };
    },
  };
}

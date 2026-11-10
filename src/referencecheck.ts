// Checking a store built from a reference against it, page by page (docs/references.md): every page of the reference
// is matched to the store's page (by address, then title), and each pair is compared on what can be counted without
// a person looking: the page exists and is published, its sections (headings) and images are there, the links it
// had lead to pages the store has, and its words: carried over when the reference is the owner's own site, and not
// copied when it is someone else's. Free: it reads the store through its site API, never Firecrawl. The look itself
// is for a person or an agent to judge: each result gives the reference's screenshot and the store page's link.
import type { ReferenceBundle, ReferencePage } from './referencesite.ts';
import type { SiteRequest, SiteResponse } from './sitekeys.ts';

type SiteCall = (request: SiteRequest) => Promise<SiteResponse>;

interface StorePage {
  id: number;
  title: string;
  slug: string;
  status: string;
  link: string;
}

type Verdict = 'pass' | 'warn' | 'fail';

interface Finding {
  level: Exclude<Verdict, 'pass'>;
  message: string;
}

export interface PageCheck {
  referenceUrl: string;
  referenceTitle: string | null;
  referenceScreenshot: string | null;
  storePage: { id: number; title: string; status: string; link: string } | null;
  status: Verdict;
  counts: { headings: [number, number]; images: [number, number] } | null;
  findings: Finding[];
}

export interface ReferenceCheck {
  summary: { pages: number; pass: number; warn: number; fail: number };
  pages: PageCheck[];
  /** Pages the store has that no reference page matched (new pages, or a reference page matched by another name). */
  extraStorePages: { id: number; title: string; link: string }[];
  notes: string[];
}

/** A page's text in plain words, lower case, for comparing. */
const words = (text: string) => text.toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').match(/[\p{L}\p{N}']+/gu) ?? [];
const norm = (text: string) => words(text).join(' ');

/** Runs of five words: what two texts share of these is how much of one is in the other. */
function shingles(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(' '));
  return out;
}

const share = (of: Set<string>, within: Set<string>) => (of.size ? [...of].filter((s) => within.has(s)).length / of.size : 0);

/** The store page's markup as text, headings, images and links. */
function readMarkup(markup: string) {
  const headings = [...markup.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((m) => stripTags(m[1]!)).filter(Boolean);
  const images = new Set([...markup.matchAll(/<img[^>]+src="([^"]+)"/gi), ...markup.matchAll(/"url":"([^"]+\.(?:jpe?g|png|webp|gif|avif|svg))"/gi)].map((m) => m[1]!)).size;
  return { text: stripTags(markup.replace(/<!--[\s\S]*?-->/g, ' ')), headings, images };
}

const stripTags = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** The reference page's text, headings and internal links, from its Markdown (or a Figma frame's sections). */
function readReference(page: ReferencePage, home: URL) {
  const md = page.text || page.sections.map((s) => [s.name, ...s.text].join('\n')).join('\n');
  const headings = page.text ? [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]!.replace(/[*_`[\]]|\(.*?\)/g, '').trim()).filter(Boolean) : page.sections.map((s) => s.name);
  const linked = [...(page.links ?? []), ...[...md.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!)];
  const internal = new Set<string>();
  for (const l of linked) {
    const path = pathOf(l, home);
    if (path && path !== '/' && !/\.[a-z0-9]{2,4}$/i.test(path)) internal.add(path);
  }
  return { text: md.replace(/!\[[^\]]*\]\([^)]*\)|\]\([^)]*\)|[#*_`>[\]]/g, ' '), headings, images: page.images.length, internal: [...internal] };
}

/** An address's path on the reference site, or null for another site. */
function pathOf(url: string, home: URL): string | null {
  try {
    const u = new URL(url, home);
    if (u.hostname.replace(/^www\./, '') !== home.hostname.replace(/^www\./, '')) return null;
    return u.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

const lastSlug = (path: string) => path.split('/').filter(Boolean).at(-1) ?? '';

/** The store page that stands for a reference page: the home page for the home page, then by slug, then by title. */
function matchPage(page: ReferencePage, home: URL, store: StorePage[], homeId: number | null): StorePage | null {
  const path = pathOf(page.url, home);
  if (path === '/') return store.find((p) => p.id === homeId) ?? store.find((p) => p.slug === 'home') ?? null;
  const slug = path ? lastSlug(path).toLowerCase() : '';
  const title = norm(page.title ?? page.url);
  return store.find((p) => slug && p.slug.toLowerCase() === slug) ?? store.find((p) => norm(p.title) === title) ?? store.find((p) => title && norm(p.title) && title.includes(norm(p.title))) ?? null;
}

const verdict = (findings: Finding[]): Verdict => (findings.some((f) => f.level === 'fail') ? 'fail' : findings.length ? 'warn' : 'pass');

type RefPage = ReturnType<typeof readReference>;
type BuiltPage = ReturnType<typeof readMarkup>;

const listOf = (list: string[], show: (x: string) => string = (x) => x) => `${list.slice(0, 10).map(show).join(', ')}${list.length > 10 ? ` and ${list.length - 10} more` : ''}`;

/** Sections, images and linked pages the reference page had that the store page lacks. */
function compareStructure(ref: RefPage, built: BuiltPage, storeSlugs: Set<string>): Finding[] {
  const findings: Finding[] = [];
  if (ref.headings.length >= 2 && built.headings.length < Math.ceil(ref.headings.length / 2)) {
    findings.push({ level: 'warn', message: `It has ${built.headings.length} headings; the reference has ${ref.headings.length}: sections may be missing.` });
  }
  if (ref.images > 0 && built.images < Math.ceil(ref.images / 2)) findings.push({ level: 'warn', message: `It has ${built.images} images; the reference has ${ref.images}.` });
  const missingLinks = ref.internal.filter((p) => !storeSlugs.has(lastSlug(p).toLowerCase()));
  if (missingLinks.length) findings.push({ level: 'warn', message: `The reference links to pages the store has no page for: ${listOf(missingLinks)}.` });
  return findings;
}

/** The owner's own words carried over, or someone else's not copied. */
function compareText(ref: RefPage, built: BuiltPage, ownContent: boolean): Finding[] {
  const findings: Finding[] = [];
  const refShingles = shingles(ref.text);
  const builtShingles = shingles(built.text);
  if (!ownContent) {
    const copied = share(builtShingles, refShingles);
    if (builtShingles.size >= 5 && copied > 0.3) findings.push({ level: 'fail', message: `About ${Math.round(copied * 100)}% of the page's text is copied from the reference, which is someone else's site: write the store's own.` });
    return findings;
  }
  const builtText = norm(built.text);
  const lost = ref.headings.filter((h) => norm(h) && !builtText.includes(norm(h)));
  if (lost.length) findings.push({ level: 'fail', message: `Headings not carried over: ${listOf(lost, (h) => `"${h}"`)}.` });
  const kept = share(refShingles, builtShingles);
  if (refShingles.size >= 5 && kept < 0.6) findings.push({ level: 'warn', message: `About ${Math.round(kept * 100)}% of the reference's text is on the page.` });
  return findings;
}

async function storeJson<T>(site: SiteCall, path: string): Promise<T> {
  const answer = await site({ method: 'GET', path });
  if (answer.status >= 400) throw new Error(`the store answered ${answer.status} for ${path || 'the site'}`);
  return answer.body as T;
}

/** Runs `work` over `list`, `n` at a time, in order. */
async function inTurns<T, R>(list: T[], n: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await work(list[i]!);
    }
  }));
  return out;
}

async function checkPage(page: ReferencePage, home: URL, store: StorePage[], homeId: number | null, ownContent: boolean, site: SiteCall): Promise<PageCheck & { matched: number | null }> {
  const base = { referenceUrl: page.url, referenceTitle: page.title, referenceScreenshot: page.screenshot };
  const match = matchPage(page, home, store, homeId);
  if (!match) {
    return { ...base, storePage: null, status: 'fail', counts: null, findings: [{ level: 'fail', message: `The store has no page for this one${page.title ? ` ("${page.title}")` : ''}.` }], matched: null };
  }
  const full = await storeJson<{ content: string }>(site, `/pages/${match.id}`);
  const ref = readReference(page, home);
  const built = readMarkup(full.content ?? '');
  const findings = [...compareStructure(ref, built, new Set(store.map((p) => p.slug.toLowerCase()))), ...compareText(ref, built, ownContent)];
  if (match.status !== 'publish') findings.unshift({ level: 'warn', message: `The store's page is still ${match.status}.` });
  return {
    ...base,
    storePage: { id: match.id, title: match.title, status: match.status, link: match.link },
    status: verdict(findings),
    counts: { headings: [ref.headings.length, built.headings.length], images: [ref.images, built.images] },
    findings,
    matched: match.id,
  };
}

/**
 * Compares a store with the reference it was built from, page by page. `ownContent`: the reference is the owner's
 * own site, so its words must be carried over; otherwise the store must not copy them.
 */
export async function checkAgainstReference(bundle: ReferenceBundle, site: SiteCall, options: { ownContent: boolean; offset: number; limit: number }): Promise<ReferenceCheck> {
  const info = await storeJson<{ homePage: number | null }>(site, '');
  const store = await storeJson<StorePage[]>(site, '/pages');
  const home = new URL(bundle.kind === 'website' ? bundle.source : 'https://reference.invalid/');
  const pages = bundle.pages.slice(options.offset, options.offset + options.limit);
  const results = await inTurns(pages, 4, (page) => checkPage(page, home, store, info.homePage ?? null, options.ownContent, site));
  const matched = new Set(results.map((r) => r.matched));
  const count = (v: Verdict) => results.filter((r) => r.status === v).length;
  const notes: string[] = [];
  if (bundle.pages.length > options.offset + options.limit) notes.push(`${bundle.pages.length - options.offset - options.limit} more reference pages: check them with offset ${options.offset + options.limit}.`);
  if (bundle.items.length || bundle.products.length) notes.push(`The reference also has ${bundle.items.length} posts or other items and ${bundle.products.length} products; this check covers pages only.`);
  notes.push('Counts and text are checked here; the look is not. Compare each referenceScreenshot with the store page (the anypress-ui-check skill) before calling a page done.');
  return {
    summary: { pages: results.length, pass: count('pass'), warn: count('warn'), fail: count('fail') },
    pages: results.map(({ matched: _m, ...r }) => r),
    extraStorePages: options.offset === 0 ? store.filter((p) => !matched.has(p.id)).map((p) => ({ id: p.id, title: p.title, link: p.link })) : [],
    notes,
  };
}

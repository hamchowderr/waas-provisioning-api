// The website check (Sales Kit): a quick look at a prospect's current website, written for a business owner, that a
// seller sends as a free report. It runs inside the prospect read (src/prospectdemos.ts) on the page Firecrawl
// fetched, so one read gives the check, the brand and the demo. `analyze` is pure (HTML in, checks out).

export type CheckStatus = 'pass' | 'warn' | 'fail';

export type Check = {
  id: string;
  title: string;
  status: CheckStatus;
  /** One plain sentence on what was found and why it matters, for the prospect. */
  detail: string;
  weight: number;
};

export type Fetched = {
  /** The address asked for, and where it ended up after redirects. */
  requested: string;
  finalUrl: string;
  /** Whether a plain http:// address sends visitors on to https://. Null when not tested. */
  redirectsToHttps: boolean | null;
  status: number;
  /** How long our own request for the page took; null when the site wouldn't answer us (speed isn't scored then). */
  ms: number | null;
  bytes: number;
  html: string;
};

export type Report = {
  url: string;
  host: string;
  checkedAt: string;
  /** 0 to 100. */
  score: number;
  builder: string | null;
  checks: Check[];
};

const attr = (tag: string, name: string) =>
  new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
    .exec(tag)
    ?.slice(2)
    .find((v) => v !== undefined) ?? null;

function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase();
    if (name === key) return attr(tag, 'content')?.trim() ?? '';
  }
  return null;
}

const text = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&copy;|&#169;/gi, '©')
    .replace(/\s+/g, ' ');

/** The site builder the page says it was made with, when it says. */
function builderOf(html: string): string | null {
  const generator = metaContent(html, 'generator');
  if (generator) {
    const known = /(WordPress|Wix|Squarespace|Weebly|Joomla|Drupal|Shopify|GoDaddy|Webflow|Duda|HubSpot|Ghost)/i.exec(generator);
    return known ? known[1]!.replace(/^./, (c) => c.toUpperCase()) : generator.split(/[\s;]/)[0]!;
  }
  if (/wp-content\//i.test(html)) return 'WordPress';
  if (/static\.wixstatic\.com|wix\.com/i.test(html)) return 'Wix';
  if (/squarespace\.com|static1\.squarespace/i.test(html)) return 'Squarespace';
  if (/cdn\.shopify\.com/i.test(html)) return 'Shopify';
  if (/img1\.wsimg\.com|godaddy/i.test(html)) return 'GoDaddy';
  if (/webflow\.com/i.test(html)) return 'Webflow';
  return null;
}

/** The newest year after a © on the page, or null. */
function copyrightYear(html: string): number | null {
  const years = [...text(html).matchAll(/(?:©|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1]));
  return years.length ? Math.max(...years) : null;
}

const ACT_ONLINE =
  /\b(book (now|online|an appointment)|schedule|appointment|reserve|add to cart|shop now|checkout|buy now|donate|give online|giving|register|enrol|enroll|join now|sign up)\b/i;

type CheckInput = { page: Fetched; html: string; url: URL; now: Date };
type CheckFn = (input: CheckInput) => Check | null;

const tier = <T>(levels: Array<[boolean, T]>, otherwise: T): T => levels.find(([hit]) => hit)?.[1] ?? otherwise;

const secure: CheckFn = ({ page, url }) => {
  const level = tier<0 | 1 | 2>([[url.protocol !== 'https:', 0], [page.redirectsToHttps === false, 1]], 2);
  return {
    id: 'secure',
    title: 'Secure connection',
    weight: 3,
    status: (['fail', 'warn', 'pass'] as const)[level],
    detail: [
      'The site doesn\'t use a secure connection, so browsers mark it "Not secure" and visitors may leave.',
      "The secure address works, but the plain address doesn't send visitors to it.",
      'The site uses a secure connection (https).',
    ][level]!,
  };
};

const speed: CheckFn = ({ page }) => {
  if (page.ms === null) return null;
  const seconds = page.ms / 1000;
  const mb = page.bytes / 1_000_000;
  const size = mb >= 0.05 ? ` and is ${mb.toFixed(1)} MB` : '';
  const quick = seconds < 1.5;
  return {
    id: 'speed',
    title: 'Loads quickly',
    weight: 3,
    status: tier<CheckStatus>([[quick && mb < 2, 'pass'], [seconds < 4, 'warn']], 'fail'),
    detail: `The page took ${seconds.toFixed(1)} seconds to arrive${size}. ${quick ? "That's quick." : 'Slow pages lose visitors, most of all on phones.'}`,
  };
};

const mobile: CheckFn = ({ html }) => {
  const fits = /width\s*=\s*device-width/i.test(metaContent(html, 'viewport') ?? '');
  return {
    id: 'mobile',
    title: 'Works on phones',
    weight: 3,
    status: fits ? 'pass' : 'fail',
    detail: fits ? 'The site is set up to fit phone screens.' : "The site isn't set up for phones, so visitors on a phone have to pinch and zoom.",
  };
};

function searchDetail(title: string, description: string): string {
  if (!title) return 'The page has no title, which is what Google shows as the headline in search results.';
  if (!description) return `The title is "${title.slice(0, 70)}", but there's no description for Google to show under it.`;
  if (title.length < 10 || description.length < 50) return 'The title or the description Google shows is very short.';
  return 'The page has a clear title and description for Google to show.';
}

const search: CheckFn = ({ html }) => {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const description = metaContent(html, 'description') ?? '';
  const titled = title.length >= 10;
  return {
    id: 'search',
    title: 'Ready for Google',
    weight: 2,
    status: tier<CheckStatus>([[titled && description.length >= 50, 'pass'], [titled || description !== '', 'warn']], 'fail'),
    detail: searchDetail(title, description),
  };
};

/** A check that passes when the page has something, and warns or fails when it doesn't. */
const has =
  (id: string, title: string, weight: number, missing: CheckStatus, test: (html: string) => boolean, yes: string, no: string): CheckFn =>
  ({ html }) => {
    const ok = test(html);
    return { id, title, weight, status: ok ? 'pass' : missing, detail: ok ? yes : no };
  };

const heading = has(
  'heading',
  'Clear main heading',
  1,
  'warn',
  (html) => /<h1\b/i.test(html),
  "The page has a main heading that says what it's about.",
  'The page has no main heading, which helps visitors and Google see what the business does.',
);

const sharing = has(
  'sharing',
  'Looks good when shared',
  1,
  'warn',
  (html) => Boolean(metaContent(html, 'og:image')),
  'Links to the site show a picture when shared on Facebook or in a text.',
  'Links shared on Facebook or in a text show no picture.',
);

const fresh: CheckFn = ({ html, now }) => {
  const year = copyrightYear(html);
  const age = year === null ? null : now.getFullYear() - year;
  const [status, detail] = tier<[CheckStatus, string]>(
    [
      [age === null, ['warn', "We couldn't tell when the site was last updated."]],
      [(age ?? 0) <= 1, ['pass', 'The site looks recently updated.']],
      [(age ?? 0) <= 3, ['warn', '']],
    ],
    ['fail', ''],
  );
  return {
    id: 'fresh',
    title: 'Kept up to date',
    weight: 2,
    status,
    detail: detail || `The footer still says ${year}, so the site looks like it hasn't been updated in ${age} years.`,
  };
};

const contact = has(
  'contact',
  'Easy to contact',
  2,
  'fail',
  (html) => /href\s*=\s*["']?(tel:|mailto:)/i.test(html) || /<form\b/i.test(html),
  'Visitors can tap to call, email or send a message.',
  "There's no tap-to-call number, email link or contact form on the page.",
);

const online = has(
  'online',
  'Customers can act online',
  2,
  'warn',
  (html) => ACT_ONLINE.test(text(html)),
  'Visitors can book, buy, give or sign up online.',
  "Visitors can't book, buy, give or sign up from the page, so they have to call or leave.",
);

const images: CheckFn = ({ html }) => {
  const tags = html.match(/<img\b[^>]*>/gi) ?? [];
  if (tags.length < 3) return null;
  const described = tags.filter((tag) => (attr(tag, 'alt') ?? '').trim().length > 0).length;
  const share = described / tags.length;
  const good = share >= 0.8;
  return {
    id: 'images',
    title: 'Pictures are described',
    weight: 1,
    status: tier<CheckStatus>([[good, 'pass'], [share >= 0.4, 'warn']], 'fail'),
    detail: good
      ? 'Pictures have descriptions for screen readers and Google.'
      : `${tags.length - described} of ${tags.length} pictures have no description, which hurts accessibility and search.`,
  };
};

const CHECKS: CheckFn[] = [secure, speed, mobile, search, heading, sharing, fresh, contact, online, images];
const CREDIT: Record<CheckStatus, number> = { pass: 1, warn: 0.5, fail: 0 };

export function analyze(page: Fetched, now = new Date()): Report {
  const input = { page, html: page.html, url: new URL(page.finalUrl), now };
  const checks = CHECKS.map((check) => check(input)).filter((c): c is Check => c !== null);
  const total = checks.reduce((n, c) => n + c.weight, 0);
  const got = checks.reduce((n, c) => n + c.weight * CREDIT[c.status], 0);
  return {
    url: page.finalUrl,
    host: input.url.hostname.replace(/^www\./, ''),
    checkedAt: now.toISOString(),
    score: Math.round((got / total) * 100),
    builder: builderOf(page.html),
    checks,
  };
}

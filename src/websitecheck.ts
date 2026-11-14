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

export function analyze(page: Fetched, now = new Date()): Report {
  const html = page.html;
  const url = new URL(page.finalUrl);
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const https = url.protocol === 'https:';
  add({
    id: 'secure',
    title: 'Secure connection',
    weight: 3,
    status: !https ? 'fail' : page.redirectsToHttps === false ? 'warn' : 'pass',
    detail: !https
      ? 'The site doesn\'t use a secure connection, so browsers mark it "Not secure" and visitors may leave.'
      : page.redirectsToHttps === false
        ? "The secure address works, but the plain address doesn't send visitors to it."
        : 'The site uses a secure connection (https).',
  });

  const seconds = (page.ms ?? 0) / 1000;
  const mb = page.bytes / 1_000_000;
  if (page.ms !== null)
    add({
      id: 'speed',
      title: 'Loads quickly',
      weight: 3,
      status: seconds < 1.5 && mb < 2 ? 'pass' : seconds < 4 ? 'warn' : 'fail',
      detail: `The page took ${seconds.toFixed(1)} seconds to arrive${mb >= 0.05 ? ` and is ${mb.toFixed(1)} MB` : ''}. ${
        seconds < 1.5 ? "That's quick." : 'Slow pages lose visitors, most of all on phones.'
      }`,
    });

  const viewport = metaContent(html, 'viewport');
  add({
    id: 'mobile',
    title: 'Works on phones',
    weight: 3,
    status: viewport && /width\s*=\s*device-width/i.test(viewport) ? 'pass' : 'fail',
    detail:
      viewport && /width\s*=\s*device-width/i.test(viewport)
        ? 'The site is set up to fit phone screens.'
        : "The site isn't set up for phones, so visitors on a phone have to pinch and zoom.",
  });

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const description = metaContent(html, 'description') ?? '';
  add({
    id: 'search',
    title: 'Ready for Google',
    weight: 2,
    status: title.length >= 10 && description.length >= 50 ? 'pass' : title.length >= 10 || description ? 'warn' : 'fail',
    detail: !title
      ? 'The page has no title, which is what Google shows as the headline in search results.'
      : !description
        ? `The title is "${title.slice(0, 70)}", but there's no description for Google to show under it.`
        : title.length < 10 || description.length < 50
          ? 'The title or the description Google shows is very short.'
          : 'The page has a clear title and description for Google to show.',
  });

  const h1 = /<h1\b/i.test(html);
  add({
    id: 'heading',
    title: 'Clear main heading',
    weight: 1,
    status: h1 ? 'pass' : 'warn',
    detail: h1
      ? "The page has a main heading that says what it's about."
      : 'The page has no main heading, which helps visitors and Google see what the business does.',
  });

  const ogImage = metaContent(html, 'og:image');
  add({
    id: 'sharing',
    title: 'Looks good when shared',
    weight: 1,
    status: ogImage ? 'pass' : 'warn',
    detail: ogImage ? 'Links to the site show a picture when shared on Facebook or in a text.' : 'Links shared on Facebook or in a text show no picture.',
  });

  const year = copyrightYear(html);
  const age = year ? now.getFullYear() - year : null;
  add({
    id: 'fresh',
    title: 'Kept up to date',
    weight: 2,
    status: age === null ? 'warn' : age <= 1 ? 'pass' : age <= 3 ? 'warn' : 'fail',
    detail:
      age === null
        ? "We couldn't tell when the site was last updated."
        : age <= 1
          ? 'The site looks recently updated.'
          : `The footer still says ${year}, so the site looks like it hasn't been updated in ${age} years.`,
  });

  const contact = /href\s*=\s*["']?(tel:|mailto:)/i.test(html) || /<form\b/i.test(html);
  add({
    id: 'contact',
    title: 'Easy to contact',
    weight: 2,
    status: contact ? 'pass' : 'fail',
    detail: contact ? 'Visitors can tap to call, email or send a message.' : "There's no tap-to-call number, email link or contact form on the page.",
  });

  const act = ACT_ONLINE.test(text(html));
  add({
    id: 'online',
    title: 'Customers can act online',
    weight: 2,
    status: act ? 'pass' : 'warn',
    detail: act ? 'Visitors can book, buy, give or sign up online.' : "Visitors can't book, buy, give or sign up from the page, so they have to call or leave.",
  });

  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  const described = images.filter((tag) => (attr(tag, 'alt') ?? '').trim().length > 0).length;
  if (images.length >= 3) {
    const share = described / images.length;
    add({
      id: 'images',
      title: 'Pictures are described',
      weight: 1,
      status: share >= 0.8 ? 'pass' : share >= 0.4 ? 'warn' : 'fail',
      detail:
        share >= 0.8
          ? 'Pictures have descriptions for screen readers and Google.'
          : `${images.length - described} of ${images.length} pictures have no description, which hurts accessibility and search.`,
    });
  }

  const total = checks.reduce((n, c) => n + c.weight, 0);
  const got = checks.reduce((n, c) => n + c.weight * (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  return {
    url: page.finalUrl,
    host: url.hostname.replace(/^www\./, ''),
    checkedAt: now.toISOString(),
    score: Math.round((got / total) * 100),
    builder: builderOf(html),
    checks,
  };
}

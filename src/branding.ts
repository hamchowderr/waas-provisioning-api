import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import type { AuthMail } from './authmail.ts';
import { activeDashboardDomain, dashboardHostProduct } from './dashboarddomains.ts';
import { badRequest, HttpError } from './errors.ts';
import { isUuid, readJson, scopedProduct } from './http.ts';
import { publicBase } from './oauth.ts';
import { channelKey, parseManifest, type ReleaseStore } from './releases.ts';
import { getStorefront } from './storefronts.ts';

/**
 * Dashboard branding (docs/branding.md): the name, logo, icon, main color and support address a
 * storefront's or reseller's team sees in the dashboard instead of the platform's. A storefront that
 * leaves a field empty gets its reseller's, so a reseller sets its look once and each of its brands
 * (storefronts) can change what differs. Logos and icons are public: the sign-in page shows them.
 */

type BrandOwner = { productId: string } | { resellerId: string };

export interface Brand {
  name: string | null;
  color: string | null;
  supportEmail: string | null;
  /** Where customers buy: the "Start your website" button on the brand's demo page. */
  shopUrl: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
}

const IMAGES = {
  logo: { max: 256 * 1024, label: 'The logo', types: ['image/png', 'image/jpeg', 'image/webp'] },
  icon: { max: 64 * 1024, label: 'The icon', types: ['image/png', 'image/jpeg', 'image/webp', 'image/x-icon'] },
} as const;
type ImageKind = keyof typeof IMAGES;

const COLOR = /^#[0-9a-f]{6}$/;

/** Demo page zips: anypress-theme-v1.2.3.zip and anypress-blocks-v1.2.3.zip, from those repositories' releases. */
const DEMO_ZIP = /^anypress-(theme|blocks)-(v\d{1,3}\.\d{1,3}\.\d{1,3})\.zip$/;
const DEMO_ZIP_ASSET = { theme: 'anypress.zip', blocks: 'anypress-blocks.zip' } as const;
const DEMO_ZIP_MAX = 20 * 1024 * 1024;
const demoZips = new Map<string, Promise<Buffer | null>>();

/**
 * A release zip of the AnyPress theme or AnyPress Blocks, kept in memory once fetched (a release never changes). A
 * plain download of a public file: GitHub's SDK has no call for it. Null for any other name, or when GitHub has no such
 * release.
 */
export function demoZip(file: string, download: typeof fetch = fetch): Promise<Buffer | null> {
  const match = DEMO_ZIP.exec(file);
  if (!match) return Promise.resolve(null);
  const [, repo, tag] = match as unknown as [string, keyof typeof DEMO_ZIP_ASSET, string];
  return cachedZip(file, () => Promise.resolve(`https://github.com/hamchowderr/anypress-${repo}/releases/download/${tag}/${DEMO_ZIP_ASSET[repo]}`), download);
}

/**
 * A zip from `url()`, kept in memory under `key` once fetched: no larger than DEMO_ZIP_MAX and, when `sha256` is given,
 * with that checksum. A failed fetch is forgotten, so the next request tries again.
 */
function cachedZip(key: string, url: () => Promise<string>, download: typeof fetch, sha256?: string): Promise<Buffer | null> {
  let zip = demoZips.get(key);
  if (!zip) {
    zip = url()
      .then((u) => download(u, { signal: AbortSignal.timeout(20_000) }))
      .then(async (r) => {
        if (!r.ok) return null;
        const bytes = Buffer.from(await r.arrayBuffer());
        if (bytes.length > DEMO_ZIP_MAX) return null;
        return !sha256 || createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : null;
      })
      .catch(() => null)
      .then((bytes) => {
        if (!bytes) demoZips.delete(key);
        return bytes;
      });
    demoZips.set(key, zip);
  }
  return zip;
}

/**
 * AnyPress Client's latest stable release zip, kept in memory per version once fetched. Null when there is no release
 * or it can't be read.
 */
export async function latestClientZip(releases: ReleaseStore, download: typeof fetch = fetch): Promise<Buffer | null> {
  const manifest = parseManifest(await releases.getJson(channelKey('anypress-client', 'stable')), 'anypress-client');
  if (!manifest) return null;
  return cachedZip(`anypress-client-${manifest.version}`, () => releases.presignGet(manifest.zip, 300), download, manifest.sha256);
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/;

/** The image type its first bytes show, whatever the request said. SVG is refused: it can carry script. */
function sniff(bytes: Uint8Array): string | null {
  const at = (i: number, ...b: number[]) => b.every((v, j) => bytes[i + j] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  return null;
}

const ownerColumn = (o: BrandOwner) => ('resellerId' in o ? { column: 'reseller_id', id: o.resellerId } : { column: 'product_id', id: o.productId });

interface Row {
  id: string;
  name: string | null;
  color: string | null;
  support_email: string | null;
  shop_url: string | null;
  has_logo: boolean;
  has_icon: boolean;
  updated_at: Date;
}

const columns = (t = '') =>
  `${t}id, ${t}name, ${t}color, ${t}support_email, ${t}shop_url, ${t}logo IS NOT NULL AS has_logo, ${t}icon IS NOT NULL AS has_icon, ${t}updated_at`;

function imageUrl(base: string, row: Row | undefined, kind: ImageKind, has: boolean) {
  return row && has ? `${base}/branding/${row.id}/${kind}?v=${row.updated_at.getTime()}` : null;
}

function view(base: string, row: Row | undefined): Brand {
  return {
    name: row?.name ?? null,
    color: row?.color ?? null,
    supportEmail: row?.support_email ?? null,
    shopUrl: row?.shop_url ?? null,
    logoUrl: imageUrl(base, row, 'logo', row?.has_logo ?? false),
    iconUrl: imageUrl(base, row, 'icon', row?.has_icon ?? false),
  };
}

async function ownBrand(pool: Deps['pool'], owner: BrandOwner) {
  const { column, id } = ownerColumn(owner);
  const { rows } = await pool.query<Row>(`SELECT ${columns()} FROM dashboard_brands WHERE ${column} = $1`, [id]);
  return rows[0];
}

/**
 * What a storefront's dashboard shows: each field from the storefront's own branding, else its
 * reseller's (the reseller's name for stores' "unavailable" page counts as its name). Null when
 * neither set anything, and the dashboard shows the platform's own look.
 */
export async function effectiveBrand(pool: Deps['pool'], base: string, productId: string): Promise<Brand | null> {
  const { rows } = await pool.query<Row & { owner: 'product' | 'reseller'; reseller_brand: string | null }>(
    `SELECT ${columns('b.')}, CASE WHEN b.product_id IS NULL THEN 'reseller' ELSE 'product' END AS owner, NULL AS reseller_brand
       FROM dashboard_brands b JOIN products p ON b.product_id = p.id OR b.reseller_id = p.reseller_id WHERE p.id = $1
     UNION ALL
     SELECT NULL, NULL, NULL, NULL, NULL, false, false, now(), 'reseller', r.brand_name
       FROM products p JOIN resellers r ON r.id = p.reseller_id WHERE p.id = $1 AND r.brand_name IS NOT NULL`,
    [productId],
  );
  const own = rows.find((r) => r.owner === 'product' && r.id);
  const reseller = rows.find((r) => r.owner === 'reseller' && r.id);
  const fallbackName = rows.find((r) => r.reseller_brand)?.reseller_brand ?? null;
  const a = view(base, own);
  const b = view(base, reseller);
  const brand: Brand = {
    name: a.name ?? b.name ?? fallbackName,
    color: a.color ?? b.color,
    supportEmail: a.supportEmail ?? b.supportEmail,
    shopUrl: a.shopUrl ?? b.shopUrl,
    logoUrl: a.logoUrl ?? b.logoUrl,
    iconUrl: a.iconUrl ?? b.iconUrl,
  };
  return Object.values(brand).some((v) => v !== null) ? brand : null;
}

/**
 * Each product's small picture for the dashboard's storefront switcher: its icon, else its logo, each falling
 * back to its reseller's like effectiveBrand. One query for the whole list; products without either are left out.
 */
export async function productMarks(pool: Deps['pool'], base: string, productIds: string[]): Promise<Map<string, string>> {
  if (!productIds.length) return new Map();
  const { rows } = await pool.query<{ product_id: string; own: Row | null; reseller: Row | null }>(
    `SELECT p.id AS product_id,
            (SELECT row_to_json(x) FROM (SELECT ${columns()} FROM dashboard_brands WHERE product_id = p.id) x) AS own,
            (SELECT row_to_json(x) FROM (SELECT ${columns()} FROM dashboard_brands WHERE reseller_id = p.reseller_id) x) AS reseller
       FROM products p WHERE p.id = ANY($1::uuid[])`,
    [productIds],
  );
  const marks = new Map<string, string>();
  for (const r of rows) {
    // row_to_json turns the timestamp into text.
    const at = (row: Row | null) => (row ? { ...row, updated_at: new Date(row.updated_at) } : undefined);
    const a = view(base, at(r.own));
    const b = view(base, at(r.reseller));
    const url = a.iconUrl ?? a.logoUrl ?? b.iconUrl ?? b.logoUrl;
    if (url) marks.set(r.product_id, url);
  }
  return marks;
}

/**
 * Sign-in and invitation email for a storefront's team, in its look: sent in its brand's name (or,
 * with its own dashboard address, its own name), with a small "Powered by" line. The platform's own
 * email when it has neither.
 */
export async function brandedMail(pool: Deps['pool'], mail: AuthMail, productId: string): Promise<AuthMail> {
  const [brand, address, product] = await Promise.all([
    effectiveBrand(pool, '', productId),
    activeDashboardDomain(pool, productId),
    pool.query('SELECT name FROM products WHERE id = $1', [productId]),
  ]);
  const name = brand?.name ?? (address ? (product.rows[0]?.name as string | undefined) : undefined);
  // The seller's own support address, if any; the platform's logo and support sender aren't theirs to show.
  return name
    ? { ...mail, from: mail.plainFrom ?? mail.from, brand: name, poweredBy: mail.brand, supportEmail: brand?.supportEmail ?? undefined, logoUrl: undefined }
    : mail;
}

interface Fields {
  name?: string | null;
  color?: string | null;
  supportEmail?: string | null;
  shopUrl?: string | null;
}

function parseFields(body: unknown): Fields {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v);
  const out: Fields = {};
  if (b.name !== undefined) {
    const name = text(b.name);
    if (name === null || name === '') out.name = null;
    else if (typeof name === 'string' && name.length <= 60) out.name = name;
    else throw badRequest('name must be at most 60 characters, or null');
  }
  if (b.color !== undefined) {
    const color = text(b.color);
    if (color === null || color === '') out.color = null;
    else if (typeof color === 'string' && COLOR.test(color.toLowerCase())) out.color = color.toLowerCase();
    else throw badRequest('color must be a hex color like #1d4ed8, or null');
  }
  if (b.supportEmail !== undefined) {
    const email = text(b.supportEmail);
    if (email === null || email === '') out.supportEmail = null;
    else if (typeof email === 'string' && email.length <= 254 && EMAIL.test(email)) out.supportEmail = email.toLowerCase();
    else throw badRequest('supportEmail must be an email address, or null');
  }
  if (b.shopUrl !== undefined) {
    const url = text(b.shopUrl);
    if (url === null || url === '') out.shopUrl = null;
    else if (typeof url === 'string' && url.length <= 500 && URL_RE.test(url)) out.shopUrl = url;
    else throw badRequest('shopUrl must be an http or https link of at most 500 characters, or null');
  }
  return out;
}

/** Writes some of the owner's branding, making its row on first use. */
async function save(pool: Deps['pool'], owner: BrandOwner, set: Record<string, unknown>) {
  const { column, id } = ownerColumn(owner);
  const given = Object.entries(set).filter(([, v]) => v !== undefined);
  const cols = given.map(([k]) => k);
  const values = given.map(([, v]) => v);
  await pool.query(
    `INSERT INTO dashboard_brands (${column}${cols.map((k) => `, ${k}`).join('')}) VALUES ($1${cols.map((_, i) => `, $${i + 2}`).join('')})
     ON CONFLICT (${column}) DO UPDATE SET updated_at = now()${cols.map((k) => `, ${k} = EXCLUDED.${k}`).join('')}`,
    [id, ...values],
  );
}

/**
 * GET/PUT <prefix>/branding, PUT/DELETE <prefix>/branding/logo and /icon, for the owner `find` names.
 * Mounted in the admin API for /products/:productId (also /account, its own storefront) and
 * /resellers/:id (platform admin only).
 */
export function brandingRoutes(deps: Deps) {
  const { pool } = deps;
  const app = new Hono<AppEnv>();
  const base = (c: Context<AppEnv>) => publicBase(c, deps.config.publicUrl);

  async function product(c: Context): Promise<BrandOwner> {
    const id = c.req.param('productId')!;
    const scope = scopedProduct(c);
    const { rowCount } = isUuid(id) && (!scope || scope === id) ? await pool.query('SELECT 1 FROM products WHERE id = $1', [id]) : { rowCount: 0 };
    if (!rowCount) throw new HttpError(404, `Product ${id} not found`);
    return { productId: id };
  }

  async function reseller(c: Context): Promise<BrandOwner> {
    const id = c.req.param('id')!;
    const { rowCount } = isUuid(id) && !scopedProduct(c) ? await pool.query('SELECT 1 FROM resellers WHERE id = $1', [id]) : { rowCount: 0 };
    if (!rowCount) throw new HttpError(404, `Reseller ${id} not found`);
    return { resellerId: id };
  }

  /** The owner's own branding, and for a storefront what its dashboard shows once its reseller's fills the gaps. */
  async function answer(c: Context<AppEnv>, owner: BrandOwner) {
    const own = view(base(c), await ownBrand(pool, owner));
    const shown = 'productId' in owner ? await effectiveBrand(pool, base(c), owner.productId) : own;
    return c.json({ ...own, shown: shown ?? view(base(c), undefined) });
  }

  function routes(prefix: string, find: (c: Context) => Promise<BrandOwner>) {
    app.get(`${prefix}/branding`, async (c) => answer(c, await find(c)));

    // Sets some of name, color, supportEmail and shopUrl; null or "" clears one.
    app.put(`${prefix}/branding`, async (c) => {
      const owner = await find(c);
      const fields = parseFields(await readJson(c));
      await save(pool, owner, { name: fields.name, color: fields.color, support_email: fields.supportEmail, shop_url: fields.shopUrl });
      return answer(c, owner);
    });

    for (const kind of Object.keys(IMAGES) as ImageKind[]) {
      // The image itself is the request body: PNG, JPEG or WebP (an icon may also be .ico).
      app.put(`${prefix}/branding/${kind}`, async (c) => {
        const owner = await find(c);
        const spec = IMAGES[kind];
        const declared = Number(c.req.header('Content-Length') ?? 0);
        if (declared > spec.max) throw badRequest(`${spec.label} must be at most ${spec.max / 1024} KB`);
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        if (!bytes.length) throw badRequest(`Send ${spec.label.toLowerCase()} as the request body`);
        if (bytes.length > spec.max) throw badRequest(`${spec.label} must be at most ${spec.max / 1024} KB`);
        const type = sniff(bytes);
        if (!type || !(spec.types as readonly string[]).includes(type)) {
          throw badRequest(`${spec.label} must be a PNG, JPEG or WebP image${kind === 'icon' ? ', or an .ico file' : ''}`);
        }
        await save(pool, owner, { [kind]: Buffer.from(bytes), [`${kind}_type`]: type });
        return answer(c, owner);
      });

      app.delete(`${prefix}/branding/${kind}`, async (c) => {
        const owner = await find(c);
        const { column, id } = ownerColumn(owner);
        await pool.query(`UPDATE dashboard_brands SET ${kind} = NULL, ${kind}_type = NULL, updated_at = now() WHERE ${column} = $1`, [id]);
        return answer(c, owner);
      });
    }
  }

  routes('/products/:productId', product);
  routes('/resellers/:id', reseller);
  return app;
}

interface DemoBrand {
  /** The name the page shows: the brand's, else the storefront's or reseller's own. */
  name: string;
  brand: Brand | null;
  /** Where "Start your website" goes: the brand's shop link, else the ready-made storefront's address, else the reseller's link. */
  shopUrl: string | null;
}

/** The look of a storefront's (product id) or reseller's (reseller id) demo page; null for neither. */
async function demoBrand(deps: Pick<Deps, 'pool' | 'config'>, base: string, id: string): Promise<DemoBrand | null> {
  const { pool } = deps;
  const product = await pool.query<{ name: string; brand_url: string | null }>(
    'SELECT p.name, r.brand_url FROM products p LEFT JOIN resellers r ON r.id = p.reseller_id WHERE p.id = $1',
    [id],
  );
  if (product.rows[0]) {
    const brand = await effectiveBrand(pool, base, id);
    const storefront = brand?.shopUrl ? null : await getStorefront(deps, id);
    const shopUrl = brand?.shopUrl ?? (storefront?.domainName ? `https://${storefront.domainName}` : null) ?? product.rows[0].brand_url;
    return { name: brand?.name ?? product.rows[0].name, brand, shopUrl };
  }
  const reseller = await pool.query<{ name: string; brand_name: string | null; brand_url: string | null }>(
    'SELECT name, brand_name, brand_url FROM resellers WHERE id = $1',
    [id],
  );
  if (!reseller.rows[0]) return null;
  const own = view(base, await ownBrand(pool, { resellerId: id }));
  const brand = Object.values(own).some((v) => v !== null) ? own : null;
  const r = reseller.rows[0];
  return { name: brand?.name ?? r.brand_name ?? r.name, brand, shopUrl: brand?.shopUrl ?? r.brand_url };
}

/**
 * GET /branding/:id/logo and /icon: the images, public, so the sign-in page can show them. And
 * GET /branding/host/:host: the look of the sign-in page on a seller's own dashboard address
 * (src/dashboarddomains.ts), before anyone has signed in; 404 for any other address.
 */
export function publicBrandingRoutes(deps: Pick<Deps, 'pool' | 'config' | 'releases'>) {
  const app = new Hono<AppEnv>();
  app.get('/host/:host', async (c) => {
    const productId = await dashboardHostProduct(deps.pool, c.req.param('host'));
    if (!productId) return c.json({ statusCode: 404, message: 'This address is not a dashboard address' }, 404);
    const { rows } = await deps.pool.query('SELECT name FROM products WHERE id = $1', [productId]);
    const brand = await effectiveBrand(deps.pool, publicBase(c, deps.config.publicUrl), productId);
    return c.json({ productId, productName: rows[0]?.name ?? null, brand }, 200, { 'Cache-Control': 'public, max-age=60' });
  });
  // A seller's or reseller's demo page (docs/branding.md, "Demo page"): its name, look and where its customers buy.
  app.get('/demo/:id', async (c) => {
    const id = c.req.param('id');
    const demo = isUuid(id) ? await demoBrand(deps, publicBase(c, deps.config.publicUrl), id) : null;
    if (!demo) return c.json({ statusCode: 404, message: 'Not found' }, 404);
    return c.json(demo, 200, { 'Cache-Control': 'public, max-age=60' });
  });
  // The theme and AnyPress Blocks zips the demo pages install on WordPress Playground (docs/branding.md, "Demo page").
  // GitHub's release downloads don't let other sites read them, so Playground's site gets them here.
  // AnyPress Client's latest stable release, for the site-type blueprints (templates/anypress-store/playground): its
  // releases are in the update channel, not GitHub downloads. Cached briefly, so a new release reaches Playground soon.
  app.get('/demo-files/anypress-client.zip', async (c) => {
    const zip = deps.releases ? await latestClientZip(deps.releases) : null;
    if (!zip) return c.json({ statusCode: 404, message: 'Not found' }, 404, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return c.body(new Uint8Array(zip), 200, {
      'Content-Type': 'application/zip',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'public, max-age=300',
    });
  });
  app.get('/demo-files/:file', async (c) => {
    const zip = await demoZip(c.req.param('file'));
    // Not kept by any cache: a release published later, or a download that failed once, must work on the next try.
    if (!zip) return c.json({ statusCode: 404, message: 'Not found' }, 404, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return c.body(new Uint8Array(zip), 200, {
      'Content-Type': 'application/zip',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      // A release never changes, and the name carries its version.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
  app.get('/:id/:kind{logo|icon}', async (c) => {
    const id = c.req.param('id');
    const kind = c.req.param('kind') as ImageKind;
    const { rows } = isUuid(id)
      ? await deps.pool.query(`SELECT ${kind} AS bytes, ${kind}_type AS type FROM dashboard_brands WHERE id = $1 AND ${kind} IS NOT NULL`, [id])
      : { rows: [] };
    if (!rows[0]) return c.json({ statusCode: 404, message: 'Not found' }, 404);
    return c.body(new Uint8Array(rows[0].bytes as Buffer), 200, {
      'Content-Type': rows[0].type,
      // The URL carries ?v=<last change>, so a new image is a new URL.
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
  });
  return app;
}

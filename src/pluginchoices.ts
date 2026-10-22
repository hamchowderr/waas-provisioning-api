import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import { badRequest, HttpError } from './errors.ts';
import { readJson } from './http.ts';
import type { VersionPlugin } from './provisioner/provisioner.ts';
import { PLUGIN_SLUG, PLUGIN_VERSION, wordpressOrg } from './wporg.ts';

/**
 * Plugin choices (docs/plugin-choices.md): wordpress.org plugins a storefront adds to its stores, or
 * switches off, on top of its template. A reseller's choices apply to all its storefronts; a storefront's
 * own choice of the same plugin wins. They are applied while each new version builds (src/jobs.ts), since
 * moving a store to a version replaces its plugins with the version's.
 */

/** Whose choices: a product's (its id) or a reseller's shared ones. */
export type ChoiceOwner = string | { resellerId: string };

/** At most this many plugins added per storefront or reseller. */
export const MAX_ADDED = 25;

/**
 * Plugins stores can't have, by what clashes with the hosting: it already caches pages, backs stores up,
 * sends their email through the platform's relay (which counts it against the plan), and replaces their
 * code with each version's.
 */
const BLOCKED: [string, string[]][] = [
  ['Page caching is part of the hosting.', ['w3-total-cache', 'wp-super-cache', 'wp-fastest-cache', 'litespeed-cache', 'breeze', 'sg-cachepress', 'comet-cache', 'cache-enabler', 'hummingbird-performance', 'wp-optimize', 'powered-cache', 'swift-performance-lite']],
  ['Backups and moving sites are part of the hosting.', ['updraftplus', 'backwpup', 'duplicator', 'all-in-one-wp-migration', 'wpvivid-backuprestore', 'backup-backup', 'migrate-guru', 'blogvault-real-time-backup', 'everest-backup', 'wp-staging', 'wp-reset', 'wp-migrate-db', 'xcloner-backup-and-restore']],
  ['Stores send email through the platform, which counts it against their plan.', ['wp-mail-smtp', 'post-smtp', 'fluent-smtp', 'easy-wp-smtp', 'smtp-mailer', 'gosmtp', 'wp-smtp', 'suremails']],
  ['File managers would let a store change the code its version replaces.', ['wp-file-manager', 'file-manager-advanced', 'filester', 'file-manager', 'advanced-file-manager']],
  ['Firewalls that rewrite the server setup clash with the hosting.', ['wordfence', 'all-in-one-wp-security-and-firewall', 'better-wp-security', 'ninjafirewall', 'bulletproof-security']],
  ['Updates come with each new version.', ['easy-updates-manager', 'companion-auto-update', 'wp-rollback']],
];
const BLOCK_REASON = new Map(BLOCKED.flatMap(([reason, slugs]) => slugs.map((slug) => [slug, reason] as const)));
/** Our own plugins come with the platform. */
const OWN = new Set(['waas-client', 'waas-host', 'waas-payments']);

export function blockedReason(slug: string): string | null {
  if (OWN.has(slug)) return 'It comes with the platform.';
  return BLOCK_REASON.get(slug) ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toChoice(row: any, shared: boolean) {
  return {
    slug: row.slug,
    name: row.name,
    icon: row.icon,
    action: row.action,
    ...(row.action === 'add' && { version: row.version, sha256: row.sha256 }),
    siteTypes: row.site_types,
    shared,
    dateChanged: row.date_changed.toISOString(),
  };
}

type Choice = ReturnType<typeof toChoice>;

/** What a version build gets: the effective choices, in a fixed order. */
export function forVersion(choices: Choice[]): (VersionPlugin & { name: string })[] {
  return choices
    .map((c) => ({ slug: c.slug, name: c.name, action: c.action, ...(c.action === 'add' && { version: c.version, sha256: c.sha256 }), siteTypes: [...c.siteTypes].sort() }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The same choices, as far as building a version goes. */
const sameBuild = (a: VersionPlugin, b: VersionPlugin) =>
  a.slug === b.slug && a.action === b.action && (a.version ?? null) === (b.version ?? null) && [...a.siteTypes].sort().join() === [...b.siteTypes].sort().join();

function parseSiteTypes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20 || !value.every((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v))) {
    throw badRequest('siteTypes must be a list of site type keys (letters, digits, - and _), or empty for all');
  }
  return [...new Set(value as string[])];
}

export function pluginChoiceService({ pool, provisioner, wporg = wordpressOrg() }: Deps) {
  const ownerWhere = (owner: ChoiceOwner) =>
    typeof owner === 'string' ? (['product_id = $1', owner] as const) : (['reseller_id = $1', owner.resellerId] as const);

  async function rows(owner: ChoiceOwner) {
    const [where, id] = ownerWhere(owner);
    return (await pool.query(`SELECT * FROM plugin_choices WHERE ${where} ORDER BY slug`, [id])).rows;
  }

  /** A product's choices with its reseller's under them (its own win), or a reseller's own. */
  async function effective(owner: ChoiceOwner): Promise<Choice[]> {
    if (typeof owner !== 'string') return (await rows(owner)).map((r) => toChoice(r, true));
    const reseller = (await pool.query('SELECT reseller_id FROM products WHERE id = $1', [owner])).rows[0]?.reseller_id;
    const own = (await rows(owner)).map((r) => toChoice(r, false));
    const shared = reseller ? (await rows({ resellerId: reseller })).map((r) => toChoice(r, true)) : [];
    return [...own, ...shared.filter((s) => !own.some((o) => o.slug === s.slug))].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * The choices, each marked with whether the production version has it as it is now, and with
   * `checkUpdates` the newest version wordpress.org has of each added plugin.
   */
  async function list(owner: ChoiceOwner, { checkUpdates = false } = {}) {
    const choices = await effective(owner);
    let production: VersionPlugin[] | null = null;
    if (typeof owner === 'string') {
      const row = (await pool.query('SELECT plugin_choices FROM versions WHERE product_id = $1 AND is_production', [owner])).rows[0];
      production = row?.plugin_choices ?? [];
    }
    const latest = new Map<string, string | null>();
    if (checkUpdates) {
      await Promise.all(
        choices
          .filter((c) => c.action === 'add')
          .map(async (c) => latest.set(c.slug, (await wporg.plugin(c.slug).catch(() => null))?.version ?? null)),
      );
    }
    return choices.map((c) => {
      const built = forVersion([c])[0]!;
      return {
        ...c,
        ...(production && { inProduction: production.some((p) => sameBuild(p, built)) }),
        ...(checkUpdates && c.action === 'add' && { latestVersion: latest.get(c.slug) ?? null }),
      };
    });
  }

  async function search(query: unknown, page: unknown) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (q.length < 2 || q.length > 100) throw badRequest('q must be 2 to 100 characters');
    const n = page === undefined ? 1 : Number(page);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw badRequest('page must be 1 to 50');
    let result;
    try {
      result = await wporg.search(q, n);
    } catch (err) {
      console.error(`wordpress.org search failed: ${(err as Error).message}`);
      throw new HttpError(503, 'The wordpress.org plugin directory is unavailable; try again shortly');
    }
    return { ...result, plugins: result.plugins.map((p) => ({ ...p, blocked: blockedReason(p.slug) })) };
  }

  /**
   * Adds a plugin (pinned to `version`, or the newest) or switches one off, for the site types given or all.
   * An added plugin's zip is downloaded now and kept, so every version built later gets exactly these bytes.
   */
  async function set(owner: ChoiceOwner, slug: string, input: unknown) {
    if (!PLUGIN_SLUG.test(slug)) throw badRequest('slug must be a wordpress.org plugin slug');
    const body = (input ?? {}) as { action?: unknown; version?: unknown; siteTypes?: unknown };
    const action = body.action ?? 'add';
    if (action !== 'add' && action !== 'off') throw badRequest('action must be add or off');
    const siteTypes = parseSiteTypes(body.siteTypes);
    if (body.version !== undefined && (action !== 'add' || typeof body.version !== 'string' || !PLUGIN_VERSION.test(body.version))) {
      throw badRequest('version is a wordpress.org version of the plugin, and only for action add');
    }

    let info;
    try {
      info = await wporg.plugin(slug);
    } catch (err) {
      console.error(`wordpress.org plugin details failed: ${(err as Error).message}`);
      throw new HttpError(503, 'The wordpress.org plugin directory is unavailable; try again shortly');
    }
    let version: string | null = null;
    let sha256: string | null = null;
    if (action === 'add') {
      const blocked = blockedReason(slug);
      if (blocked) throw badRequest(`${info?.name ?? slug} can't be added: ${blocked}`);
      if (!info) throw badRequest(`wordpress.org has no plugin ${slug}`);
      version = (body.version as string | undefined) ?? info.version;
      if (version !== info.version && !info.versions.includes(version)) throw badRequest(`wordpress.org has no version ${version} of ${slug}`);
      const [where, id] = ownerWhere(owner);
      const added = await pool.query(`SELECT count(*)::int AS n FROM plugin_choices WHERE ${where} AND action = 'add' AND slug <> $2`, [id, slug]);
      if (added.rows[0].n >= MAX_ADDED) throw badRequest(`At most ${MAX_ADDED} plugins can be added`);
      const existing = (await pool.query(`SELECT version, sha256 FROM plugin_choices WHERE ${where} AND slug = $2`, [id, slug])).rows[0];
      if (existing?.version === version && existing.sha256) {
        sha256 = existing.sha256;
      } else {
        let zip;
        try {
          zip = await wporg.download(slug, version);
          await provisioner.storePluginPackage({ slug, version, body: zip.body });
        } catch (err) {
          console.error(`Keeping ${slug} ${version} failed: ${(err as Error).message}`);
          throw new HttpError(503, `${slug} ${version} could not be downloaded from wordpress.org; try again shortly`);
        }
        sha256 = zip.sha256;
      }
    }

    const owned = typeof owner === 'string' ? { product: owner, reseller: null } : { product: null, reseller: owner.resellerId };
    const { rows: saved } = await pool.query(
      `INSERT INTO plugin_choices (product_id, reseller_id, slug, name, icon, action, version, sha256, site_types)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (${owned.product ? 'product_id' : 'reseller_id'}, slug) WHERE ${owned.product ? 'product_id' : 'reseller_id'} IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon, action = EXCLUDED.action, version = EXCLUDED.version,
                     sha256 = EXCLUDED.sha256, site_types = EXCLUDED.site_types, date_changed = now()
       RETURNING *`,
      [owned.product, owned.reseller, slug, info?.name ?? slug, info?.icon ?? null, action, version, sha256, siteTypes],
    );
    return toChoice(saved[0], typeof owner !== 'string');
  }

  async function remove(owner: ChoiceOwner, slug: string) {
    const [where, id] = ownerWhere(owner);
    const { rowCount } = await pool.query(`DELETE FROM plugin_choices WHERE ${where} AND slug = $2`, [id, slug]);
    if (!rowCount) throw badRequest(`No plugin choice ${slug}`);
    return { slug };
  }

  return { effective, list, search, set, remove };
}

/**
 * /v1/plugin-choices. A partner key without a productId, or with ?shared=true, works on the reseller's
 * choices for all its storefronts; with a productId, on that storefront's own.
 */
export function pluginChoiceRoutes(deps: Deps) {
  const choices = pluginChoiceService(deps);
  const app = new Hono<AppEnv>();
  const owner = (c: Context<AppEnv>): ChoiceOwner => {
    const resellerId = c.get('resellerId');
    const productId = c.get('productId') as string | undefined;
    if (resellerId && (!productId || c.req.query('shared') === 'true')) return { resellerId };
    if (!productId) throw badRequest('productId is required');
    return productId;
  };

  app.get('/search', async (c) => c.json(await choices.search(c.req.query('q'), c.req.query('page'))));
  app.get('/', async (c) => c.json(await choices.list(owner(c), { checkUpdates: c.req.query('checkUpdates') === 'true' })));
  app.put('/:slug', async (c) => c.json(await choices.set(owner(c), c.req.param('slug'), await readJson(c))));
  app.delete('/:slug', async (c) => c.json(await choices.remove(owner(c), c.req.param('slug'))));
  return app;
}


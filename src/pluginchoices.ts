import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import { badRequest, HttpError } from './errors.ts';
import { randomUUID } from 'node:crypto';
import { compact, isUuid, readJson } from './http.ts';
import { Status } from './status.ts';
import type { VersionPlugin } from './provisioner/provisioner.ts';
import { inspectPluginZip, PluginZipError, type PluginZipInfo } from './pluginzip.ts';
import { MAX_PLUGIN_ZIP, PLUGIN_SLUG, PLUGIN_VERSION, wordpressOrg } from './wporg.ts';

/**
 * Plugin choices (docs/plugin-choices.md): wordpress.org plugins, or premium ones uploaded as zips, that a
 * storefront adds to its stores, or plugins it switches off, on top of its template. A reseller's choices apply to all its storefronts; a storefront's
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
    action: row.action as 'add' | 'off',
    ...(row.action === 'add' && {
      source: row.source as 'wporg' | 'upload',
      version: row.version,
      sha256: row.sha256,
      ...(row.upload_id && { uploadId: row.upload_id }),
      licenceConstants: row.licence_names ?? [],
    }),
    siteTypes: row.site_types,
    shared,
    dateChanged: row.date_changed.toISOString(),
    /** Encrypted JSON of the licence constants; never answered, only passed to version builds. */
    licence: (row.licence as string | null) ?? undefined,
  };
}

type Choice = ReturnType<typeof toChoice>;

/** A choice as the API answers it: without the licence values. */
const answer = ({ licence: _licence, ...choice }: Choice) => choice;

/** What a version is made with: the effective choices, in a fixed order. Licences stay encrypted until the build. */
export function forVersion(choices: Choice[]): (VersionPlugin & { name: string; licence?: string })[] {
  return choices
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      action: c.action,
      ...(c.action === 'add' && { version: c.version, sha256: c.sha256, ...(c.uploadId && { uploadId: c.uploadId }), ...(c.licence && { licence: c.licence }) }),
      siteTypes: [...c.siteTypes].sort(),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The same choices, as far as building a version goes. */
const sameBuild = (a: VersionPlugin & { licence?: string }, b: VersionPlugin & { licence?: string }) =>
  a.slug === b.slug &&
  a.action === b.action &&
  (a.sha256 ?? null) === (b.sha256 ?? null) &&
  (a.licence ?? null) === (b.licence ?? null) &&
  [...a.siteTypes].sort().join() === [...b.siteTypes].sort().join();

/** Licence constants: {"GF_LICENSE_KEY": "..."}; null clears them. Names as PHP constants are usually written. */
function parseLicence(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  const entries = typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as object) : null;
  if (!entries || entries.length > 10 || !entries.every(([k, v]) => /^[A-Z][A-Z0-9_]{2,63}$/.test(k) && typeof v === 'string' && v.length <= 500)) {
    throw badRequest('licence must be up to 10 constants, like {"GF_LICENSE_KEY": "..."}: upper-case names, values up to 500 characters');
  }
  return entries.length ? Object.fromEntries(entries as [string, string][]) : null;
}

function parseSiteTypes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20 || !value.every((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v))) {
    throw badRequest('siteTypes must be a list of site type keys (letters, digits, - and _), or empty for all');
  }
  return [...new Set(value as string[])];
}

export function pluginChoiceService({ pool, provisioner, secrets, wporg = wordpressOrg() }: Deps) {
  const ownerWhere = (owner: ChoiceOwner) =>
    typeof owner === 'string' ? (['product_id = $1', owner] as const) : (['reseller_id = $1', owner.resellerId] as const);
  const ownerValues = (owner: ChoiceOwner) => (typeof owner === 'string' ? [owner, null] : [null, owner.resellerId]);

  async function rows(owner: ChoiceOwner) {
    const [where, id] = ownerWhere(owner);
    const { rows } = await pool.query(`SELECT * FROM plugin_choices WHERE ${where} ORDER BY slug`, [id]);
    // Only the constants' names are ever shown.
    return rows.map((r) => ({ ...r, licence_names: r.licence ? Object.keys(JSON.parse(secrets.decrypt(r.licence))) : [] }));
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
   * `checkUpdates` the newest version wordpress.org has of each added wordpress.org plugin.
   */
  async function list(owner: ChoiceOwner, { checkUpdates = false } = {}) {
    const choices = await effective(owner);
    let production: (VersionPlugin & { licence?: string })[] | null = null;
    if (typeof owner === 'string') {
      const row = (await pool.query('SELECT plugin_choices FROM versions WHERE product_id = $1 AND is_production', [owner])).rows[0];
      production = row?.plugin_choices ?? [];
    }
    const latest = new Map<string, string | null>();
    if (checkUpdates) {
      await Promise.all(
        choices
          .filter((c) => c.action === 'add' && c.source === 'wporg')
          .map(async (c) => latest.set(c.slug, (await wporg.plugin(c.slug).catch(() => null))?.version ?? null)),
      );
    }
    return choices.map((c) => {
      const built = forVersion([c])[0]!;
      return {
        ...answer(c),
        ...(production && { inProduction: production.some((p) => sameBuild(p, built)) }),
        ...(checkUpdates && c.action === 'add' && c.source === 'wporg' && { latestVersion: latest.get(c.slug) ?? null }),
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
   * Adds a plugin or switches one off, for the site types given or all. A wordpress.org plugin is pinned to
   * `version` (or the newest) and its zip downloaded now and kept, so every version built later gets exactly
   * those files; an uploaded one (`uploadId`) is pinned to that checked upload. `licence` sets the constants
   * its stores define (left out: kept as they are; null: none).
   */
  async function set(owner: ChoiceOwner, slug: string, input: unknown) {
    if (!PLUGIN_SLUG.test(slug)) throw badRequest('slug must be a plugin slug: lowercase letters, digits and dashes');
    const body = (input ?? {}) as { action?: unknown; version?: unknown; siteTypes?: unknown; uploadId?: unknown; licence?: unknown };
    const action = body.action ?? 'add';
    if (action !== 'add' && action !== 'off') throw badRequest('action must be add or off');
    const siteTypes = parseSiteTypes(body.siteTypes);
    if (body.version !== undefined && (action !== 'add' || body.uploadId !== undefined || typeof body.version !== 'string' || !PLUGIN_VERSION.test(body.version))) {
      throw badRequest('version is a wordpress.org version of the plugin, and only for action add');
    }
    if (body.uploadId !== undefined && (action !== 'add' || typeof body.uploadId !== 'string' || !isUuid(body.uploadId))) {
      throw badRequest('uploadId is the id of a checked plugin upload, and only for action add');
    }
    if (body.licence !== undefined && action !== 'add') throw badRequest('licence is only for action add');
    const blocked = blockedReason(slug);
    const [where, id] = ownerWhere(owner);
    const existing = (await pool.query(`SELECT * FROM plugin_choices WHERE ${where} AND slug = $2`, [id, slug])).rows[0];

    let name = slug;
    let icon: string | null = null;
    let version: string | null = null;
    let sha256: string | null = null;
    let uploadId: string | null = null;
    if (action === 'add') {
      const added = await pool.query(`SELECT count(*)::int AS n FROM plugin_choices WHERE ${where} AND action = 'add' AND slug <> $2`, [id, slug]);
      if (added.rows[0].n >= MAX_ADDED) throw badRequest(`At most ${MAX_ADDED} plugins can be added`);
    }
    // An uploaded plugin stays on its upload when only its site types or licence change.
    const wantUpload = body.uploadId ?? (action === 'add' && body.version === undefined && existing?.source === 'upload' ? existing.upload_id : undefined);
    if (action === 'add' && wantUpload) {
      const upload = (await pool.query(`SELECT * FROM plugin_uploads WHERE id = $2 AND ${where}`, [id, wantUpload])).rows[0];
      if (!upload || upload.status !== 'ready') throw badRequest(`Plugin upload ${wantUpload} not found or not checked`);
      if (upload.slug !== slug) throw badRequest(`That upload is the plugin ${upload.slug}, not ${slug}`);
      if (blocked) throw badRequest(`${upload.name} can't be added: ${blocked}`);
      ({ name, version, sha256 } = upload);
      uploadId = upload.id;
    } else {
      let info;
      try {
        info = await wporg.plugin(slug);
      } catch (err) {
        console.error(`wordpress.org plugin details failed: ${(err as Error).message}`);
        throw new HttpError(503, 'The wordpress.org plugin directory is unavailable; try again shortly');
      }
      name = info?.name ?? existing?.name ?? slug;
      icon = info?.icon ?? null;
      if (action === 'add') {
        if (blocked) throw badRequest(`${info?.name ?? slug} can't be added: ${blocked}`);
        if (!info) throw badRequest(`wordpress.org has no plugin ${slug}. A premium plugin is uploaded as a zip instead.`);
        version = (body.version as string | undefined) ?? info.version;
        if (version !== info.version && !info.versions.includes(version)) throw badRequest(`wordpress.org has no version ${version} of ${slug}`);
        if (existing?.source === 'wporg' && existing.version === version && existing.sha256) {
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
    }
    const licence =
      action !== 'add' ? null : body.licence === undefined ? (existing?.licence ?? null) : ((l) => (l ? secrets.encrypt(JSON.stringify(l)) : null))(parseLicence(body.licence));

    const column = typeof owner === 'string' ? 'product_id' : 'reseller_id';
    const { rows: saved } = await pool.query(
      `INSERT INTO plugin_choices (product_id, reseller_id, slug, name, icon, action, version, sha256, site_types, source, upload_id, licence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (${column}, slug) WHERE ${column} IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon, action = EXCLUDED.action, version = EXCLUDED.version,
                     sha256 = EXCLUDED.sha256, site_types = EXCLUDED.site_types, source = EXCLUDED.source,
                     upload_id = EXCLUDED.upload_id, licence = EXCLUDED.licence, date_changed = now()
       RETURNING *`,
      [...ownerValues(owner), slug, name, icon, action, version, sha256, siteTypes, uploadId ? 'upload' : 'wporg', uploadId, licence],
    );
    const row = saved[0];
    return answer(toChoice({ ...row, licence_names: licence ? Object.keys(JSON.parse(secrets.decrypt(licence))) : [] }, typeof owner !== 'string'));
  }

  async function remove(owner: ChoiceOwner, slug: string) {
    const [where, id] = ownerWhere(owner);
    const { rowCount } = await pool.query(`DELETE FROM plugin_choices WHERE ${where} AND slug = $2`, [id, slug]);
    if (!rowCount) throw badRequest(`No plugin choice ${slug}`);
    return { slug };
  }

  // Uploads: premium plugin zips a seller bought, checked before a choice can use them.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toUpload = (u: any) =>
    compact({
      id: u.id,
      status: u.status,
      reason: u.reason,
      slug: u.slug,
      name: u.name,
      version: u.version,
      sha256: u.sha256,
      sizeBytes: u.size_bytes === null ? null : Number(u.size_bytes),
      shared: u.reseller_id !== null,
      dateCreated: u.date_created.toISOString(),
    });

  async function uploads(owner: ChoiceOwner) {
    const [where, id] = ownerWhere(owner);
    return (await pool.query(`SELECT * FROM plugin_uploads WHERE ${where} ORDER BY date_created DESC`, [id])).rows.map(toUpload);
  }

  /** A new upload: PUT the zip to uploadUrl within the hour, then check it. */
  async function createUpload(owner: ChoiceOwner) {
    const [where, id] = ownerWhere(owner);
    const waiting = await pool.query(`SELECT count(*)::int AS n FROM plugin_uploads WHERE ${where} AND status = 'pending'`, [id]);
    if (waiting.rows[0].n >= 10) throw badRequest('10 uploads are waiting to be checked; check or delete them first');
    const uploadId = randomUUID();
    const { uploadUrl } = await provisioner.createPluginUpload({ uploadId });
    await pool.query('INSERT INTO plugin_uploads (id, product_id, reseller_id) VALUES ($1, $2, $3)', [uploadId, ...ownerValues(owner)]);
    return { id: uploadId, uploadUrl, expiresIn: 3600, maxBytes: MAX_PLUGIN_ZIP };
  }

  /** Reads the uploaded zip and checks it (src/pluginzip.ts); a rejected one says why and is deleted. */
  async function checkUpload(owner: ChoiceOwner, uploadId: string) {
    const [where, id] = ownerWhere(owner);
    if (!isUuid(uploadId)) throw badRequest(`Plugin upload ${uploadId} not found`);
    const upload = (await pool.query(`SELECT * FROM plugin_uploads WHERE id = $2 AND ${where}`, [id, uploadId])).rows[0];
    if (!upload) throw badRequest(`Plugin upload ${uploadId} not found`);
    if (upload.status !== 'pending') return toUpload(upload);
    let zip;
    try {
      zip = await provisioner.readPluginUpload({ uploadId, maxBytes: MAX_PLUGIN_ZIP });
    } catch (err) {
      const reason = /larger than/.test((err as Error).message) ? 'The zip is larger than 64 MB' : null;
      if (!reason) throw err;
      zip = reason;
    }
    if (zip === null) throw badRequest('Nothing has been uploaded yet: PUT the zip to uploadUrl first');
    let result;
    if (typeof zip === 'string') {
      result = { status: 'rejected', reason: zip };
    } else {
      try {
        const info = inspectPluginZip(zip);
        const blocked = blockedReason(info.slug);
        result = blocked
          ? { status: 'rejected', reason: `${info.name} can't be added: ${blocked}`, slug: info.slug, name: info.name }
          : { status: 'ready', ...info };
      } catch (err) {
        if (!(err instanceof PluginZipError)) throw err;
        result = { status: 'rejected', reason: err.message };
      }
    }
    const r = result as Partial<PluginZipInfo> & { status: string; reason?: string };
    const { rows } = await pool.query(
      `UPDATE plugin_uploads SET status = $2, reason = $3, slug = $4, name = $5, version = $6, file = $7, sha256 = $8, size_bytes = $9
        WHERE id = $1 RETURNING *`,
      [uploadId, r.status, r.reason ?? null, r.slug ?? null, r.name ?? null, r.version ?? (r.status === 'ready' ? 'unknown' : null), r.file ?? null, r.sha256 ?? null, r.sizeBytes ?? null],
    );
    if (r.status === 'rejected') await provisioner.deletePluginUpload({ uploadId });
    return toUpload(rows[0]);
  }

  /** Versions already built keep their own copy; a choice still using the upload must go first. */
  async function removeUpload(owner: ChoiceOwner, uploadId: string) {
    const [where, id] = ownerWhere(owner);
    if (!isUuid(uploadId)) throw badRequest(`Plugin upload ${uploadId} not found`);
    if (!(await pool.query(`SELECT 1 FROM plugin_uploads WHERE id = $2 AND ${where}`, [id, uploadId])).rowCount) throw badRequest(`Plugin upload ${uploadId} not found`);
    const used = await pool.query('SELECT slug FROM plugin_choices WHERE upload_id = $1', [uploadId]);
    if (used.rowCount) throw badRequest(`The plugin choice ${used.rows[0].slug} uses this upload; remove it or pick another upload first`);
    const building = await pool.query('SELECT 1 FROM versions WHERE status = $1 AND plugin_choices @> $2::jsonb', [Status.Pending, JSON.stringify([{ uploadId }])]);
    if (building.rowCount) throw badRequest('A version that is still building uses this upload; try again once it is done');
    await pool.query('DELETE FROM plugin_uploads WHERE id = $1', [uploadId]);
    await provisioner.deletePluginUpload({ uploadId });
    return { id: uploadId };
  }

  return { effective, list, search, set, remove, uploads, createUpload, checkUpload, removeUpload };
}

/**
 * /v1/plugin-choices. A partner key without a productId, or with ?shared=true, works on the reseller's
 * choices and uploads for all its storefronts; with a productId, on that storefront's own.
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
  app.get('/uploads', async (c) => c.json(await choices.uploads(owner(c))));
  app.post('/uploads', async (c) => c.json(await choices.createUpload(owner(c))));
  app.post('/uploads/:id/check', async (c) => c.json(await choices.checkUpload(owner(c), c.req.param('id'))));
  app.delete('/uploads/:id', async (c) => c.json(await choices.removeUpload(owner(c), c.req.param('id'))));
  app.get('/', async (c) => c.json(await choices.list(owner(c), { checkUpdates: c.req.query('checkUpdates') === 'true' })));
  app.put('/:slug', async (c) => c.json(await choices.set(owner(c), c.req.param('slug'), await readJson(c))));
  app.delete('/:slug', async (c) => c.json(await choices.remove(owner(c), c.req.param('slug'))));
  return app;
}

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import { withTransaction, type Client, type Pool } from './db.ts';
import { badRequest, HttpError } from './errors.ts';
import { channelKey, parseManifest } from './releases.ts';
import { readJson } from './http.ts';
import { SIZES, type Size } from './plans.ts';
import type { Provisioner, SiteCheck } from './provisioner/provisioner.ts';
import { enqueue } from './queue.ts';
import { Status } from './status.ts';

/**
 * Sites moved in from another host. Creating a tenant with uploadCustomSnapshot (POST /v1/tenants)
 * makes a store that waits for its site and answers an import code. The owner pastes that code into
 * the AnyPress Export plugin on the old site, which packages the site (database.sql, wp-content and a
 * waas.json describing it) and, with the code's token and no API key, gets an upload link, uploads,
 * starts the move and follows it here (POST /imports/upload, /imports/start, /imports/status). The
 * store is then built from the archive and keeps the site's own plugins and themes (tenants.own_code).
 * Runbook: docs/site-imports.md.
 */

/** How long an import code works before the move is started. */
export const IMPORT_DAYS = 7;
/** How long an upload link works. */
const UPLOAD_SECONDS = 12 * 3600;
/** One PUT to object storage (R2, S3) takes at most 5 GiB. */
export const MAX_IMPORT_BYTES = 5 * 1024 ** 3;

const CODE_PREFIX = 'AP1.';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** The import code: the API's address and the token, in one string to copy and paste. */
export function importCode(apiUrl: string, token: string): string {
  return CODE_PREFIX + Buffer.from(JSON.stringify({ u: apiUrl, t: token })).toString('base64url');
}

/** The token in an import code, or the token itself when that is what was sent. */
export function tokenFromCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed.startsWith(CODE_PREFIX)) return trimmed;
  try {
    const parsed = JSON.parse(Buffer.from(trimmed.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
    return typeof parsed?.t === 'string' ? parsed.t : '';
  } catch {
    return '';
  }
}

/** The largest archive a store of this size takes: its storage, within one upload's limit. */
export const maxImportBytes = (size: Size) => Math.min(SIZES[size].storageGb * 1024 ** 3, MAX_IMPORT_BYTES);

/** Records a new import for a store inside the caller's transaction. Returns its token. */
export async function createImport(client: Client, tenantId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await client.query(`INSERT INTO tenant_imports (tenant_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [
    tenantId,
    hashToken(token),
    IMPORT_DAYS,
  ]);
  return token;
}

/** A new token for a store still waiting for its site; the one before stops working. Null when it isn't waiting. */
export async function renewImport(pool: Pool, tenantId: string): Promise<string | null> {
  return withTransaction(pool, async (client) => {
    const { rowCount } = await client.query('DELETE FROM tenant_imports WHERE tenant_id = $1 AND started_at IS NULL', [tenantId]);
    return rowCount ? createImport(client, tenantId) : null;
  });
}

/**
 * What the dashboard shows about a store's move: when its code expires, when it started and what the plugin told;
 * once built, what the check of the moved site found and any warnings; once failed, why.
 */
export async function importDetail(pool: Pool, tenantId: string) {
  const { rows } = await pool.query(
    `SELECT i.expires_at, i.started_at, i.source, i.failure_reason, i.site_check, i.warnings, t.status
       FROM tenant_imports i JOIN tenants t ON t.id = i.tenant_id WHERE i.tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    expiresAt: row.expires_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    source: row.source ?? null,
    ...(row.status === Status.Failed && { reason: row.failure_reason ?? FAILED }),
    ...(row.site_check && { check: row.site_check }),
    warnings: (row.warnings ?? []) as string[],
  };
}

/** Why a move failed, when nothing more is known. */
const FAILED = 'The move could not be finished. Contact support with the store\'s address.';

/**
 * Why a move failed, in words the site's owner can act on, from the store agent's error (agent.php). Only these fixed
 * sentences reach the owner: an error can carry paths and database output.
 */
export function importFailureReason(error: string): string {
  const reasons: [RegExp, string][] = [
    [/must hold database\.sql and wp-content/, 'The export is missing its database or its files. Run the export again on the old site.'],
    [/multisite/i, 'Multisite networks can\'t be moved in yet.'],
    [/has both \S+ and \S+/, 'The database holds two sets of WordPress tables whose names collide. Remove the old copy\'s tables from the old site\'s database, then export again.'],
    [/no WordPress tables|table prefix WordPress cannot use/, 'The export\'s database holds no WordPress tables this store can use. Run the export again on the old site.'],
    [/download failed|not a readable zip|\btar exited|gzip|unexpected end of file/i, 'The uploaded export could not be read: it may be incomplete. Run the export again on the old site.'],
    [/database could not be imported|wp db exited|db import|server has gone away|Unknown collation|ERROR \d{4}/i, 'The database could not be imported. Contact support with the store\'s address so we can look at it.'],
    [/timed out/i, 'The move took too long. A smaller export (media moved separately) may help; contact support.'],
  ];
  return reasons.find(([pattern]) => pattern.test(error))?.[1] ?? FAILED;
}

/** Records why a move failed (importFailureReason). Nothing for a store that wasn't moved in. */
export async function recordImportFailure(pool: Pool | Client, tenantId: string, error: string): Promise<void> {
  await pool.query('UPDATE tenant_imports SET failure_reason = $2 WHERE tenant_id = $1', [tenantId, importFailureReason(error)]);
}

/** Major.minor of a version, as numbers: "8.3.6" is [8, 3]. Null when it isn't one. */
const majorMinor = (v: string | undefined) => {
  const m = /^(\d+)\.(\d+)/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2])] : null;
};
/**
 * -1, 0 or 1 as `a` is older, the same as, or newer than `b`, part by part as far as both go (a version's "7.1" is
 * whichever 7.1 release its image has); 0 when either isn't a version.
 */
function compareVersions(a: string | undefined, b: string | undefined): number {
  if (!/^\d+(\.\d+)*$/.test(a ?? '') || !/^\d+(\.\d+)*$/.test(b ?? '')) return 0;
  const x = a!.split('.').map(Number);
  const y = b!.split('.').map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * What the owner should know about a site moved in: it ran another PHP than the store does, or a newer WordPress
 * (the store can't go back), and what the check after the move found (src/provisioner: SiteCheck).
 */
export function importWarnings(source: ImportSource | null, store: { wordPressVersion: string; phpVersion: string }, check?: SiteCheck): string[] {
  const warnings: string[] = [];
  const php = majorMinor(source?.phpVersion);
  const storePhp = majorMinor(store.phpVersion);
  if (php && storePhp && (php[0] !== storePhp[0] || php[1] !== storePhp[1])) {
    warnings.push(`The old site ran PHP ${php.join('.')} and this store runs PHP ${storePhp.join('.')}. Check that its plugins and theme work.`);
  }
  if (compareVersions(source?.wordPressVersion?.replace(/-.*$/, ''), store.wordPressVersion) > 0) {
    warnings.push(
      `The old site ran WordPress ${source!.wordPressVersion}, newer than this store's ${store.wordPressVersion}. Plugins that need the newer WordPress may not work until the store moves to a version with it.`,
    );
  }
  if (check && !check.ok) {
    if (check.error) warnings.push('The site could not be checked after the move. Open it and its admin to see that it works.');
    else {
      const pages = [check.home !== undefined && `the home page answered ${check.home || 'nothing'}`, check.login !== undefined && `the login page ${check.login || 'nothing'}`]
        .filter(Boolean)
        .join(' and ');
      warnings.push(`After the move ${pages}${check.fatal ? `, and PHP stopped with: ${check.fatal}` : check.loaded === false ? ', and WordPress did not load with its plugins' : ''}. Fix or switch off the plugin or theme at fault.`);
    }
  }
  return warnings;
}

/**
 * Records a built move: the check and the warnings, with no failure from an earlier attempt, and puts the store on
 * hold until its owner makes it live (POST /v1/tenants/go-live).
 */
export async function recordImportBuilt(pool: Pool, tenantId: string, check?: SiteCheck): Promise<void> {
  const { rows } = await pool.query(
    `SELECT i.source, v.wordpress_version, v.php_version FROM tenant_imports i JOIN tenants t ON t.id = i.tenant_id JOIN versions v ON v.id = t.version_id
      WHERE i.tenant_id = $1`,
    [tenantId],
  );
  if (!rows[0]) return;
  const warnings = importWarnings(rows[0].source, { wordPressVersion: rows[0].wordpress_version, phpVersion: rows[0].php_version }, check);
  await pool.query('UPDATE tenant_imports SET site_check = $2, warnings = $3, failure_reason = NULL WHERE tenant_id = $1', [
    tenantId,
    check ?? null,
    JSON.stringify(warnings),
  ]);
}

/**
 * Who else gets email while a moved site is held, besides its administration address: the people with an account on
 * the store's storefront (its owner and team).
 */
export async function holdAllowList(pool: Pool, tenantId: string): Promise<string[]> {
  const { rows } = await pool.query<{ email: string }>(
    `SELECT DISTINCT lower(u.email) AS email FROM tenants t
       JOIN auth.organization o ON o."productId" = t.product_id
       JOIN auth.member m ON m."organizationId" = o.id
       JOIN auth."user" u ON u.id = m."userId"
      WHERE t.id = $1 ORDER BY 1 LIMIT 20`,
    [tenantId],
  );
  return rows.map((r) => r.email);
}

export interface ImportSource {
  home?: string;
  wordPressVersion?: string;
  phpVersion?: string;
  tablePrefix?: string;
  sizeBytes?: number;
}

/** What the export plugin may tell about the old site, kept for support; anything else is dropped. */
function importSource(value: unknown): ImportSource {
  const v = (value ?? {}) as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === 'string' && x.length <= 200 ? x : undefined);
  return {
    home: text(v.home),
    wordPressVersion: text(v.wordPressVersion),
    phpVersion: text(v.phpVersion),
    tablePrefix: text(v.tablePrefix),
    sizeBytes: typeof v.sizeBytes === 'number' && Number.isFinite(v.sizeBytes) ? v.sizeBytes : undefined,
  };
}

/** The routes the export plugin calls with an import code. No API key: the code's token is the credential. */
export function importRoutes({ pool, boss, provisioner, releases }: Deps) {
  const app = new Hono<AppEnv>();

  // The AnyPress Export plugin to install on the old site: the latest stable release.
  app.get('/plugin.zip', async (c) => {
    if (!releases) throw new HttpError(503, 'Plugin downloads are not configured');
    const manifest = parseManifest(await releases.getJson(channelKey('anypress-export', 'stable')), 'anypress-export');
    if (!manifest) throw new HttpError(404, 'The AnyPress Export plugin is not released yet');
    return c.redirect(releases.presignGet(manifest.zip, 600), 302);
  });

  /** The import the request's code names, with its store. 404 for an unknown code, 410 for an expired one. */
  async function findImport(body: unknown) {
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !code.trim()) throw badRequest('code is required');
    const token = tokenFromCode(code);
    const { rows } = await pool.query(
      `SELECT i.tenant_id, i.expires_at, i.started_at, i.failure_reason, i.warnings, t.name, t.size, t.status, t.on_hold,
         (SELECT d.domain_name FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_main) AS main_domain
       FROM tenant_imports i JOIN tenants t ON t.id = i.tenant_id WHERE i.token_hash = $1`,
      [hashToken(token)],
    );
    const found = rows[0];
    if (!found) throw new HttpError(404, 'This import code is not valid. Copy it again from AnyPress.');
    return found as {
      tenant_id: string;
      expires_at: Date;
      started_at: Date | null;
      failure_reason: string | null;
      warnings: string[] | null;
      name: string;
      size: Size;
      status: number;
      on_hold: boolean;
      main_domain: string;
    };
  }

  const notStarted = (found: { expires_at: Date; started_at: Date | null }) => {
    if (found.started_at) throw new HttpError(409, 'This site is already being moved in.');
    if (found.expires_at.getTime() < Date.now()) throw new HttpError(410, 'This import code has expired. Start again from AnyPress.');
  };

  const store = (found: { name: string; size: Size; main_domain: string }) => ({ name: found.name, size: found.size, domain: found.main_domain });

  // An upload link for the archive, and the most it may hold.
  app.post('/upload', async (c) => {
    const found = await findImport(await readJson(c));
    notStarted(found);
    const uploadUrl = await provisioner.createImportUpload({ storeId: found.tenant_id, expiresInSeconds: UPLOAD_SECONDS });
    return c.json({ uploadUrl, maxBytes: maxImportBytes(found.size), store: store(found) });
  });

  // The archive is uploaded: build the store from it.
  app.post('/start', async (c) => {
    const body = await readJson(c);
    const found = await findImport(body);
    notStarted(found);
    const bytes = await provisioner.importSize({ storeId: found.tenant_id });
    if (bytes === null) throw badRequest('Nothing was uploaded yet. Upload the export, then start.');
    if (bytes > maxImportBytes(found.size)) {
      throw badRequest(`The export is ${gb(bytes)} GB, more than a ${found.size} store holds (${gb(maxImportBytes(found.size))} GB). Choose a larger size.`);
    }
    const source = { ...importSource((body as { source?: unknown }).source), uploadedBytes: bytes };
    const started = await withTransaction(pool, async (client) => {
      const { rowCount } = await client.query('UPDATE tenant_imports SET started_at = now(), source = $2 WHERE tenant_id = $1 AND started_at IS NULL', [
        found.tenant_id,
        source,
      ]);
      if (rowCount) await enqueue(boss, client, { type: 'tenant.create', tenantId: found.tenant_id });
      return rowCount === 1;
    });
    if (!started) throw new HttpError(409, 'This site is already being moved in.');
    return c.json({ status: 'moving', store: store(found) });
  });

  // How the move is going: waiting for the upload, moving, done (with the site's address, whether it is still on hold
  // and any warnings) or failed (with why).
  app.post('/status', async (c) => {
    const found = await findImport(await readJson(c));
    const status = !found.started_at
      ? 'waiting'
      : found.status === Status.Done
        ? 'done'
        : found.status === Status.Failed
          ? 'failed'
          : 'moving';
    const warnings = found.warnings ?? [];
    return c.json({
      status,
      store: store(found),
      ...(status === 'done' && { url: `https://${found.main_domain}`, onHold: found.on_hold }),
      ...(status === 'failed' && { reason: found.failure_reason ?? FAILED }),
      ...(status !== 'waiting' && warnings.length > 0 && { warnings }),
    });
  });

  return app;

  function gb(bytes: number) {
    return (bytes / 1024 ** 3).toFixed(1);
  }
}

/**
 * Removes the stores whose import code expired before the move started, with anything uploaded for
 * them. Such a store never ran, so there is nothing on the store host to remove. Returns how many.
 */
export async function purgeExpiredImports(pool: Pool, provisioner: Provisioner): Promise<number> {
  const { rows } = await pool.query<{ tenant_id: string }>('SELECT tenant_id FROM tenant_imports WHERE started_at IS NULL AND expires_at < now()');
  for (const { tenant_id } of rows) {
    await provisioner.deleteImport({ storeId: tenant_id });
    await pool.query('DELETE FROM tenants WHERE id = $1 AND status = $2', [tenant_id, Status.Pending]);
  }
  return rows.length;
}

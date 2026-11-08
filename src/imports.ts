import { createHash, createPublicKey, generateKeyPair, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { PgBoss } from 'pg-boss';
import { Hono } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import { withTransaction, type Client, type Pool } from './db.ts';
import { badRequest, HttpError } from './errors.ts';
import { channelKey, parseManifest } from './releases.ts';
import { readJson } from './http.ts';
import { SIZES, type Size } from './plans.ts';
import { ImportPartsError, type MoveReport, type Provisioner, type SiteCheck } from './provisioner/provisioner.ts';
import { enqueue } from './queue.ts';
import type { Secrets } from './secrets.ts';
import { siteReport, type SiteReport } from './sitereport.ts';
import { Status } from './status.ts';

/**
 * Sites moved in from another host. Creating a tenant with uploadCustomSnapshot (POST /v1/tenants)
 * makes a store that waits for its site and answers an import code. The owner pastes that code into
 * the AnyPress Export plugin on the old site, which packages the site (database.sql, wp-content and a
 * anypress.json describing it) and, with the code's token and no API key, gets an upload link, uploads,
 * starts the move and follows it here (POST /imports/upload, /imports/start, /imports/status). The
 * store is then built from the archive and keeps the site's own plugins and themes (tenants.own_code).
 *
 * The other way in copies the site from its host with WordPress's own Reprint (wordpress.org plugin `reprint`): each
 * waiting store has a key, whose public half is the Migration Token the owner pastes into the Reprint plugin on the old
 * site (Tools → Reprint Server). Given the old site's address (startReprintCopy), the store's agent pulls the site over
 * HTTPS with the official client and builds the store from it the same way. Until the store goes live it can be
 * copied again, so orders and posts made on the old site meanwhile come along.
 * Runbook: docs/site-imports.md.
 */

/** How long an import code works before the move is started. */
export const IMPORT_DAYS = 7;
/** How long an upload link works. */
const UPLOAD_SECONDS = 12 * 3600;
/** One PUT to object storage (R2, S3) takes at most 5 GiB. */
export const MAX_IMPORT_BYTES = 5 * 1024 ** 3;

/** S3 takes at most 10,000 parts of at least 5 MiB (the last may be smaller). */
const MAX_PARTS = 10_000;
const PART_MIB = 16;
const GONE = 'This upload is no longer known. Upload the export again.';

/** The part size for an archive of `bytes`: 16 MiB (small enough to send within one slow web request), or larger in whole MiB so it fits in 10,000 parts. */
export const importPartSize = (bytes: number) => Math.max(PART_MIB, Math.ceil(bytes / MAX_PARTS / 1024 ** 2)) * 1024 ** 2;

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

/**
 * A new key for copying a site with Reprint, encrypted to keep: RSA 3072 in PKCS#8 PEM, as Reprint's own `keygen`
 * makes. The Reprint client signs its requests with it (src/provisioner/coolify/agent.php).
 */
export async function newReprintKey(secrets: Secrets): Promise<string> {
  const { privateKey } = await promisify(generateKeyPair)('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return secrets.encrypt(privateKey);
}

/** The Migration Token for a kept key: its public half on one line (base64 of the DER), as the Reprint plugin takes it. */
export function migrationToken(secrets: Secrets, storedKey: string): string {
  return createPublicKey(secrets.decrypt(storedKey)).export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * Records a new import for a store inside the caller's transaction. Returns its token. `reprintKey` is the store's
 * encrypted Reprint key (newReprintKey), kept when a code is renewed so a token already pasted on the old site still works.
 */
export async function createImport(client: Client, tenantId: string, reprintKey: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await client.query(
    `INSERT INTO tenant_imports (tenant_id, token_hash, expires_at, reprint_key) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [tenantId, hashToken(token), IMPORT_DAYS, reprintKey],
  );
  return token;
}

/** A new token for a store still waiting for its site; the one before stops working. Null when it isn't waiting. */
export async function renewImport(pool: Pool, tenantId: string): Promise<string | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ reprint_key: string | null }>(
      'DELETE FROM tenant_imports WHERE tenant_id = $1 AND started_at IS NULL RETURNING reprint_key',
      [tenantId],
    );
    return rows[0] ? createImport(client, tenantId, rows[0].reprint_key) : null;
  });
}

/** The old site's address for a copy with Reprint: https, a host, no user, query or fragment. Throws a 400 otherwise. */
export function reprintSite(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw badRequest("siteUrl is required: the old site's address");
  let url: URL;
  try {
    url = new URL(value.trim().includes('://') ? value.trim() : `https://${value.trim()}`);
  } catch {
    throw badRequest("siteUrl must be the old site's address, such as https://example.com");
  }
  if (url.protocol !== 'https:') throw badRequest('siteUrl must start with https://: Reprint copies a site over HTTPS only');
  if (url.username || url.password || !url.hostname.includes('.')) throw badRequest("siteUrl must be the old site's address, such as https://example.com");
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Starts copying a store's site from its old host with Reprint: for a store waiting for its site, one whose move
 * failed (to try again, or after one with the AnyPress Export plugin failed), or one moved in and still on hold (a
 * copy again, which replaces the store's content with the old site's latest). Answers false when the store is busy or
 * live, null when it was not moved in.
 */
export async function startReprintCopy(pool: Pool, boss: PgBoss, secrets: Secrets, tenantId: string, site: string): Promise<boolean | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ started_at: Date | null; expires_at: Date; reprint_key: string | null; status: number; on_hold: boolean }>(
      `SELECT i.started_at, i.expires_at, i.reprint_key, t.status, t.on_hold FROM tenant_imports i JOIN tenants t ON t.id = i.tenant_id
        WHERE i.tenant_id = $1 FOR UPDATE OF i, t`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) return null;
    const waiting = !row.started_at;
    if (waiting && row.expires_at.getTime() < Date.now()) throw new HttpError(410, 'This move has expired. Start again from AnyPress.');
    const again = row.status === Status.Failed || (row.status === Status.Done && row.on_hold);
    if (!waiting && !again) return false;
    await client.query(
      `UPDATE tenant_imports SET started_at = COALESCE(started_at, now()), reprint_site = $2, reprint_copies = reprint_copies + 1,
         reprint_key = COALESCE(reprint_key, $3), failure_reason = NULL, source = COALESCE(source, '{}'::jsonb) || jsonb_build_object('home', $2::text)
        WHERE tenant_id = $1`,
      [tenantId, site, row.reprint_key ? null : await newReprintKey(secrets)],
    );
    await client.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1', [tenantId, Status.Pending]);
    await enqueue(boss, client, { type: 'tenant.create', tenantId });
    return true;
  });
}

/** How a store's site comes in when it is built: copied with Reprint (the old site's address and the key), or null for the uploaded archive. */
export async function reprintSource(pool: Pool, secrets: Secrets, tenantId: string): Promise<{ site: string; privateKey: string } | null> {
  const { rows } = await pool.query<{ reprint_site: string | null; reprint_key: string | null }>(
    'SELECT reprint_site, reprint_key FROM tenant_imports WHERE tenant_id = $1',
    [tenantId],
  );
  const row = rows[0];
  return row?.reprint_site && row.reprint_key ? { site: row.reprint_site, privateKey: secrets.decrypt(row.reprint_key) } : null;
}

/**
 * What the dashboard shows about a store's move: when its code expires, when it started and what the plugin told;
 * once built, what the check of the moved site found, any warnings and what's on the site (src/sitereport.ts); once
 * failed, why.
 */
export async function importDetail(pool: Pool, tenantId: string, secrets?: Secrets) {
  const { rows } = await pool.query(
    `SELECT i.expires_at, i.started_at, i.source, i.failure_reason, i.site_check, i.warnings, i.site_report, i.reprint_key, i.reprint_site, i.reprint_copies, t.status
       FROM tenant_imports i JOIN tenants t ON t.id = i.tenant_id WHERE i.tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    expiresAt: row.expires_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    source: row.source ?? null,
    // Why it failed; for a store still built (a copy again that could not fetch the site), why that copy failed.
    ...((row.status === Status.Failed || row.failure_reason) && { reason: row.failure_reason ?? FAILED }),
    ...(row.site_check && { check: row.site_check }),
    warnings: (row.warnings ?? []) as string[],
    ...(row.site_report && { siteReport: row.site_report as SiteReport }),
    // For a copy with Reprint: the token to paste on the old site, and the address it was copied from.
    ...(secrets && row.reprint_key && { migrationToken: migrationToken(secrets, row.reprint_key) }),
    reprintSite: (row.reprint_site as string | null) ?? null,
    reprintCopies: row.reprint_copies as number,
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
    // A copy with Reprint (agent.php: reprint_run), by Reprint's error code.
    [/reprint AUTH_REQUIRES_TOKEN/, "The old site's host can't check a Migration Token (it has no OpenSSL). Move the site with the AnyPress Export plugin instead."],
    [/reprint (AUTH_UNKNOWN_KEY|AUTH_NOT_CONFIGURED|AUTH_FAILED|AUTH_NO_CREDENTIAL|AUTH_REQUIRES_KEY)/, "Reprint on the old site hasn't let this store in yet. Under Tools → Reprint Server, paste this store's Migration Token, choose Authorize client, then start the copy again."],
    [/reprint (NOT_FOUND|HTML_RESPONSE|INVALID_JSON|INVALID_PREFLIGHT_RESPONSE)|Reprint Server plugin is not installed/, "Reprint isn't installed and active on the old site at that address. Install Reprint (Plugins → Add New Plugin), activate it, check the address, then start the copy again."],
    [/reprint (CLOUDFLARE_CHALLENGE|WORDFENCE_BLOCKED|AUTH_HEADERS_STRIPPED|RATE_LIMITED)/, 'A security service in front of the old site (such as Cloudflare or Wordfence) stopped the copy. Let the copy through, or move the site with the AnyPress Export plugin instead.'],
    [/reprint (CURL_ERROR|REDIRECT)/, "The old site couldn't be reached at that address. Check it (https:// and with or without www, as the site uses it), then start the copy again."],
    [/reprint: still copying/, "The site is big and the copy didn't finish in time. Start the copy again: it carries on where it stopped."],
    [/the copy must hold database\.sql and wp-content/, "Reprint brought no database or no wp-content from the old site. Check that the address is the WordPress site's, or move it with the AnyPress Export plugin."],
    [/reprint (PREFLIGHT_FAILED|exit \d+)|reprint: /, "Reprint couldn't copy the old site. Move it with the AnyPress Export plugin instead, or contact support with the store's address."],
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
export function importWarnings(
  source: ImportSource | null,
  store: { wordPressVersion: string; phpVersion: string },
  check?: SiteCheck,
  moved?: MoveReport,
): string[] {
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
  const short = moved?.rows ?? [];
  if (short.length > 0) {
    const list = short.slice(0, 5).map((r) => `${r.table} (${r.loaded} of ${r.exported})`).join(', ');
    warnings.push(`Some rows did not arrive: ${list}${short.length > 5 ? ` and ${short.length - 5} more tables` : ''}. Contact support with the store's address before going live.`);
  }
  warnings.push(...(moved?.notes ?? []));
  return warnings;
}

/**
 * Records a built move: the check, the warnings and the report of what's on the site (src/sitereport.ts, from the
 * check's inventory, which isn't kept itself), with no failure from an earlier attempt. The store is held until its
 * owner makes it live (POST /v1/tenants/go-live).
 */
export async function recordImportBuilt(pool: Pool, tenantId: string, check?: SiteCheck, moved?: MoveReport): Promise<void> {
  const { rows } = await pool.query(
    `SELECT i.source, v.wordpress_version, v.php_version FROM tenant_imports i JOIN tenants t ON t.id = i.tenant_id JOIN versions v ON v.id = t.version_id
      WHERE i.tenant_id = $1`,
    [tenantId],
  );
  if (!rows[0]) return;
  const warnings = importWarnings(rows[0].source, { wordPressVersion: rows[0].wordpress_version, phpVersion: rows[0].php_version }, check, moved);
  const { inventory, ...found } = check ?? ({} as SiteCheck);
  await pool.query('UPDATE tenant_imports SET site_check = $2, warnings = $3, site_report = $4, failure_reason = NULL WHERE tenant_id = $1', [
    tenantId,
    check ? found : null,
    JSON.stringify(warnings),
    siteReport(inventory),
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
    return c.redirect(await releases.presignGet(manifest.zip, 600), 302);
  });

  /** The import the request's code names, with its store. 404 for an unknown code, 410 for an expired one. */
  async function findImport(body: unknown) {
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !code.trim()) throw badRequest('code is required');
    const token = tokenFromCode(code);
    const { rows } = await pool.query(
      `SELECT i.tenant_id, i.expires_at, i.started_at, i.failure_reason, i.warnings, i.site_report, t.name, t.size, t.status, t.on_hold,
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
      site_report: SiteReport | null;
      name: string;
      size: Size;
      status: number;
      on_hold: boolean;
      main_domain: string;
    };
  }

  // A move that failed can be done again with the plugin (after a copy with Reprint that could not reach the site, say).
  const notStarted = (found: { expires_at: Date; started_at: Date | null; status: number }) => {
    if (found.started_at && found.status !== Status.Failed) throw new HttpError(409, 'This site is already being moved in.');
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

  // Uploading in parts, so a dropped connection costs one part and an upload can carry on where it stopped. The plugin
  // says how big the archive is; AnyPress picks the part size. Then: links for the parts still missing, then finish,
  // then start.
  app.post('/upload/parts/start', async (c) => {
    const body = await readJson(c);
    const found = await findImport(body);
    notStarted(found);
    const bytes = (body as { bytes?: unknown }).bytes;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1) throw badRequest('bytes is required: the size of the export');
    const max = maxImportBytes(found.size);
    if (bytes > max) throw badRequest(`The export is ${gb(bytes)} GB, more than a ${found.size} store holds (${gb(max)} GB). Choose a larger size.`);
    const partSize = importPartSize(bytes);
    const uploadId = await provisioner.startImportParts({ storeId: found.tenant_id });
    return c.json({ uploadId, partSize, partCount: Math.ceil(bytes / partSize), maxBytes: max, store: store(found) });
  });

  // Which parts are uploaded already, and links for the parts asked for (at most 100 at a time).
  app.post('/upload/parts', async (c) => {
    const body = await readJson(c);
    const found = await findImport(body);
    notStarted(found);
    const uploadId = partsUploadId(body);
    const asked = (body as { parts?: unknown }).parts ?? [];
    if (!Array.isArray(asked) || asked.length > 100 || asked.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_PARTS)) {
      throw badRequest(`parts must be a list of at most 100 part numbers from 1 to ${MAX_PARTS}`);
    }
    const done = await provisioner.importParts({ storeId: found.tenant_id, uploadId });
    if (!done) throw new HttpError(404, GONE);
    const urls = await provisioner.importPartUrls({ storeId: found.tenant_id, uploadId, parts: [...new Set(asked as number[])], expiresInSeconds: UPLOAD_SECONDS });
    return c.json({ done: done.map((p) => p.number), bytes: done.reduce((sum, p) => sum + p.size, 0), urls });
  });

  // Every part is uploaded: join them into the archive. Start the move next.
  app.post('/upload/parts/finish', async (c) => {
    const body = await readJson(c);
    const found = await findImport(body);
    notStarted(found);
    const uploadId = partsUploadId(body);
    try {
      await provisioner.finishImportParts({ storeId: found.tenant_id, uploadId });
    } catch (e) {
      if (e instanceof ImportPartsError) throw badRequest(e.message);
      throw e;
    }
    return c.json({ bytes: await provisioner.importSize({ storeId: found.tenant_id }), store: store(found) });
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
      // The archive, not a copy with Reprint, is what the store is built from now.
      const { rowCount } = await client.query(
        `UPDATE tenant_imports i SET started_at = now(), source = $2, reprint_site = NULL, failure_reason = NULL FROM tenants t
          WHERE i.tenant_id = $1 AND t.id = i.tenant_id AND (i.started_at IS NULL OR t.status = $3)`,
        [found.tenant_id, source, Status.Failed],
      );
      if (rowCount) {
        await client.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 AND status = $3', [found.tenant_id, Status.Pending, Status.Failed]);
        await enqueue(boss, client, { type: 'tenant.create', tenantId: found.tenant_id });
      }
      return rowCount === 1;
    });
    if (!started) throw new HttpError(409, 'This site is already being moved in.');
    return c.json({ status: 'moving', store: store(found) });
  });

  // How the move is going: waiting for the upload, moving, done (with the site's address, whether it is still on hold,
  // any warnings and what's on the site) or failed (with why).
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
      ...(status === 'done' && found.site_report && { siteReport: found.site_report }),
    });
  });

  return app;

  function partsUploadId(body: unknown) {
    const id = (body as { uploadId?: unknown } | null)?.uploadId;
    if (typeof id !== 'string' || !id || id.length > 1024) throw badRequest('uploadId is required');
    return id;
  }

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

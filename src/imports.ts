import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import { withTransaction, type Client, type Pool } from './db.ts';
import { badRequest, HttpError } from './errors.ts';
import { channelKey, parseManifest } from './releases.ts';
import { readJson } from './http.ts';
import { SIZES, type Size } from './plans.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
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

interface ImportSource {
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
      `SELECT i.tenant_id, i.expires_at, i.started_at, t.name, t.size, t.status,
         (SELECT d.domain_name FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_main) AS main_domain
       FROM tenant_imports i JOIN tenants t ON t.id = i.tenant_id WHERE i.token_hash = $1`,
      [hashToken(token)],
    );
    const found = rows[0];
    if (!found) throw new HttpError(404, 'This import code is not valid. Copy it again from AnyPress.');
    return found as { tenant_id: string; expires_at: Date; started_at: Date | null; name: string; size: Size; status: number; main_domain: string };
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

  // How the move is going: waiting for the upload, moving, done (with the site's address) or failed.
  app.post('/status', async (c) => {
    const found = await findImport(await readJson(c));
    const status = !found.started_at
      ? 'waiting'
      : found.status === Status.Done
        ? 'done'
        : found.status === Status.Failed
          ? 'failed'
          : 'moving';
    return c.json({ status, store: store(found), ...(status === 'done' && { url: `https://${found.main_domain}` }) });
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

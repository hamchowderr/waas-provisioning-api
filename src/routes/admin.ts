import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { adminAccountRoutes, SESSION_HEADER, sessionAuth } from '../accounts.ts';
import { adminApplicationRoutes } from '../applications.ts';
import type { AppEnv, Deps } from '../app.ts';
import type { Config } from '../config.ts';
import { withTransaction, type Client, type Pool } from '../db.ts';
import { HttpError, badRequest } from '../errors.ts';
import { dbBackupStatus } from '../dbbackup.ts';
import { checkHealth } from '../health.ts';
import { booleanQuery, isUuid, readJson, requiredUuidQuery, scopedProduct, uuidQuery } from '../http.ts';
import { importCode, importDetail, renewImport } from '../imports.ts';
import { mailUsage } from '../mailcount.ts';
import { getMailDomain, removeMailDomain, setMailDomain } from '../maildomains.ts';
import { enqueue, QUEUE, type JobData } from '../queue.ts';
import { addApiKey, listApiKeys, parseGraceHours, parseLabel, revokeApiKey, rotateApiKey } from '../keys.ts';
import { isPluginSlug, manifestKey, parseManifest, RELEASE_VERSION } from '../releases.ts';
import { publicBase } from '../oauth.ts';
import { adminResellerRoutes } from '../resellers.ts';
import { Status, statusName } from '../status.ts';
import { createStorefront, getStorefront, type NewStorefront } from '../storefronts.ts';
import { baseSnapshotService } from './basesnapshots.ts';
import { storeDomainConnect } from './domainconnect.ts';
import { addTenantDomain, assertChangeable } from './domains.ts';
import { createTenant } from './tenants.ts';
import { versionService } from './versions.ts';
import { adminWebhookRoutes } from './webhooks.ts';

/**
 * Admin API for the dashboard (waas-api-plu). Not part of /v1: documented in the README
 * and openapi/admin/admin-api.yaml. Sees every product. Authenticated with ADMIN_TOKEN as a
 * bearer token; product keys get 403.
 *
 * The same routes also serve signed-in customers at /account (docs/accounts.md), narrowed to their
 * organization's product: every list and lookup is filtered to it, another product's records are
 * 404, and the platform-only routes (new products, limits, plugins, database backups) are 404.
 */

const notFound = (what: string) => new HttpError(404, what);

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Compares digests, so the comparison takes the same time whatever the token's length. */
export function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

function page(c: Context) {
  const pageNumber = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize') ?? 50) || 50));
  return { page: pageNumber, pageSize, offset: (pageNumber - 1) * pageSize };
}

function statusQuery(c: Context): number | undefined {
  const value = c.req.query('status');
  if (value === undefined || value === '') return undefined;
  const code = Number(value);
  if (!Number.isInteger(code) || code < 0 || code > 3) throw badRequest('status must be 0, 1, 2 or 3');
  return code;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (d: any) => (d ? new Date(d).toISOString() : null);

/** What an admin may see of a job: never its data, which can hold encrypted secrets. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jobTarget(data: any) {
  return {
    type: data?.type ?? null,
    tenantId: data?.tenantId ?? null,
    versionId: data?.versionId ?? null,
    backupId: data?.backupId ?? null,
    baseSnapshotId: data?.baseSnapshotId ?? null,
  };
}

/** A pg-boss job (`j`) that works on one of product $N's stores or versions; any job when $N is null. */
const jobOfProduct = (n: number) => `($${n}::uuid IS NULL
  OR EXISTS (SELECT 1 FROM tenants t WHERE t.id::text = j.data->>'tenantId' AND t.product_id = $${n})
  OR EXISTS (SELECT 1 FROM versions v WHERE v.id::text = j.data->>'versionId' AND v.product_id = $${n}))`;

/** The same for a job failure (`f`). */
const failureOfProduct = (n: number) => `($${n}::uuid IS NULL
  OR EXISTS (SELECT 1 FROM tenants t WHERE t.id = f.tenant_id AND t.product_id = $${n})
  OR EXISTS (SELECT 1 FROM versions v WHERE v.id = f.version_id AND v.product_id = $${n}))`;

/**
 * Puts the record a failed job was working on back to Pending (or Removing for a delete), so the
 * re-queued job can finish it. Only from Failed: anything newer is left alone. Returns false
 * when there's nothing Failed to reset.
 */
async function resetForRetry(client: Client, data: JobData): Promise<boolean> {
  const one = async (sql: string, params: unknown[]) => ((await client.query(sql, params)).rowCount ?? 0) > 0;
  const tenant = (id: string, to: number) => one('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 AND status = $3', [id, to, Status.Failed]);
  const backup = (id: string) => one('UPDATE tenant_backups SET status = $2 WHERE id = $1 AND status = $3', [id, Status.Pending, Status.Failed]);
  switch (data.type) {
    case 'version.create':
    case 'version.delete': {
      const to = data.type === 'version.create' ? Status.Pending : Status.Removing;
      const ok = await one('UPDATE versions SET status = $2, date_changed = now() WHERE id = $1 AND status = $3', [data.versionId, to, Status.Failed]);
      if (ok) await client.query('UPDATE snapshots SET status = $2 WHERE version_id = $1 AND status = $3', [data.versionId, to, Status.Failed]);
      return ok;
    }
    case 'tenant.delete':
      return tenant(data.tenantId, Status.Removing);
    case 'tenant.suspend': {
      const ok = await tenant(data.tenantId, Status.Pending);
      if (ok && data.backupId) await backup(data.backupId);
      return ok;
    }
    case 'tenant.backup':
      return backup(data.backupId);
    case 'tenant.rollback': {
      // A rollback whose first backup failed left the store untouched and Done (src/jobs.ts).
      const untouched = !!data.safetyBackupId && (await backup(data.safetyBackupId));
      if (untouched) return one('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 AND status IN ($3, $4)', [data.tenantId, Status.Pending, Status.Done, Status.Failed]);
      return tenant(data.tenantId, Status.Pending);
    }
    case 'basesnapshot.delete':
      return true; // nothing recorded to reset; the archive delete is simply tried again
    default:
      return tenant(data.tenantId, Status.Pending);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toPin = (p: any) => ({ productId: p.product_id, slug: p.slug, version: p.version, pinnedAt: iso(p.pinned_at) });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const backupView = (retentionDays: number) => (b: any) => ({
  id: b.id,
  tenantId: b.tenant_id,
  externalId: b.external_id,
  productId: b.product_id,
  reason: b.reason,
  sizeBytes: b.size_bytes === null ? null : Number(b.size_bytes),
  statusCode: b.status,
  statusName: statusName(b.status),
  dateCreated: iso(b.date_created),
  tenantDeletedAt: iso(b.tenant_deleted_at),
  expiresAt: b.tenant_deleted_at ? new Date(new Date(b.tenant_deleted_at).getTime() + retentionDays * 86400000).toISOString() : null,
});

/**
 * Store backups, newest first: every product's, or one product's (`productId`). Shared by
 * GET /admin/backups and the signed-in customer's GET /account/backups (the same route, narrowed).
 */
export async function listBackups(pool: Pool, retentionDays: number, c: Context, productId: string | null) {
  const { page: pageNumber, pageSize, offset } = page(c);
  const params = [
    productId,
    uuidQuery(c, 'tenantId') ?? null,
    c.req.query('externalId') || null,
    statusQuery(c) ?? null,
    booleanQuery(c, 'tenantDeleted') ?? null,
  ];
  const where = `($1::uuid IS NULL OR product_id = $1) AND ($2::uuid IS NULL OR tenant_id = $2)
    AND ($3::text IS NULL OR external_id = $3) AND ($4::int IS NULL OR status = $4)
    AND ($5::boolean IS NULL OR (tenant_deleted_at IS NOT NULL) = $5)`;
  const [{ rows }, total] = await Promise.all([
    pool.query(`SELECT * FROM tenant_backups WHERE ${where} ORDER BY date_created DESC, id LIMIT ${pageSize} OFFSET ${offset}`, params),
    pool.query(`SELECT count(*)::int AS n FROM tenant_backups WHERE ${where}`, params),
  ]);
  return c.json({ items: rows.map(backupView(retentionDays)), total: total.rows[0].n, page: pageNumber, pageSize });
}

/** A `from`/`to` query parameter: an ISO 8601 date-time, or undefined when absent. */
function timeQuery(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw badRequest(`${name} must be an ISO 8601 date-time`);
  return new Date(time).toISOString();
}

/**
 * The rows of request log `r` that belong to product $N; every row when $N is null. A product's own
 * calls, plus failed sign-ins with one of its key ids (wrong or old secret, revoked key), which carry
 * no product: the key id is the product's, so the attempt is theirs to see.
 */
const requestOfProduct = (n: number) => `($${n}::uuid IS NULL OR r.product_id = $${n}
  OR (r.product_id IS NULL AND r.api_key_id IN (SELECT id FROM api_keys WHERE product_id = $${n})))`;

/**
 * The request log (src/requestlog.ts), newest first: every product's, or one product's
 * (`productId`; its last-24-hours counts then cover only that product too). `outcome`: ok (below
 * 400), client-error (4xx), server-error (5xx) or error (either). `path` matches any part of the path.
 * `from` and `to` (ISO 8601) bound the time: from inclusive, to exclusive.
 * Shared by GET /admin/requests and the signed-in customer's GET /account/requests (the same route, narrowed).
 */
export async function listRequests(pool: Pool, config: Config, c: Context, productId: string | null) {
  const { page: pageNumber, pageSize, offset } = page(c);
  const source = c.req.query('source') || null;
  if (source !== null && source !== 'v1' && source !== 'admin' && source !== 'account') throw badRequest('source must be v1, admin or account');
  const outcome = c.req.query('outcome') || null;
  const ranges: Record<string, [number, number]> = { ok: [0, 399], 'client-error': [400, 499], 'server-error': [500, 599], error: [400, 599] };
  if (outcome !== null && !ranges[outcome]) throw badRequest('outcome must be ok, client-error, server-error or error');
  const method = c.req.query('method')?.toUpperCase() || null;
  const path = c.req.query('path') || null;
  const [low, high] = outcome ? ranges[outcome]! : [null, null];
  const params = [productId, uuidQuery(c, 'tenantId') ?? null, source, low, high, method, path, timeQuery(c, 'from') ?? null, timeQuery(c, 'to') ?? null];
  const where = `${requestOfProduct(1)} AND ($2::uuid IS NULL OR r.tenant_id = $2)
    AND ($3::text IS NULL OR r.source = $3) AND ($4::int IS NULL OR r.status BETWEEN $4 AND $5)
    AND ($6::text IS NULL OR r.method = $6) AND ($7::text IS NULL OR strpos(r.path, $7) > 0)
    AND ($8::timestamptz IS NULL OR r.at >= $8) AND ($9::timestamptz IS NULL OR r.at < $9)`;
  const [{ rows }, total, day] = await Promise.all([
    // A store's name only when it's the product's own: a call can name another product's store id.
    pool.query(
      `SELECT r.*, p.name AS product_name, t.name AS tenant_name, k.label AS api_key_label FROM api_requests r
         LEFT JOIN products p ON p.id = r.product_id
         LEFT JOIN tenants t ON t.id = r.tenant_id AND ($1::uuid IS NULL OR t.product_id = $1)
         LEFT JOIN api_keys k ON k.id = r.api_key_id
        WHERE ${where} ORDER BY r.at DESC, r.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    ),
    pool.query(`SELECT count(*)::int AS n FROM api_requests r WHERE ${where}`, params),
    pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status BETWEEN 400 AND 499)::int AS client_errors,
              count(*) FILTER (WHERE status >= 500)::int AS server_errors
         FROM api_requests r WHERE r.at > now() - interval '24 hours' AND ${requestOfProduct(1)}`,
      [productId],
    ),
  ]);
  return c.json({
    last24Hours: { total: day.rows[0].total, clientErrors: day.rows[0].client_errors, serverErrors: day.rows[0].server_errors },
    retentionDays: config.requestLogDays ?? 30,
    items: rows.map((r) => ({
      id: String(r.id),
      at: iso(r.at),
      source: r.source,
      method: r.method,
      path: r.path,
      query: r.query,
      status: r.status,
      durationMs: r.duration_ms,
      productId: r.product_id,
      productName: r.product_name,
      apiKeyId: r.api_key_id,
      apiKeyLabel: r.api_key_label,
      userId: r.user_id,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      externalId: r.external_id,
      ip: r.ip,
      userAgent: r.user_agent,
      error: r.error,
    })),
    total: total.rows[0].n,
    page: pageNumber,
    pageSize,
  });
}

/**
 * `session`: serve a signed-in customer (/account) instead of the platform admin (/admin). Their
 * session cookie, passed on by the dashboard's server with X-Session-Auth: 1, picks the product.
 */
export function adminRoutes(deps: Deps, { session = false } = {}) {
  const { config, pool, boss, releases } = deps;
  const versions = versionService(deps);
  const templates = baseSnapshotService(deps);
  const app = new Hono<AppEnv>();

  if (session) {
    app.use('*', async (c, next) => {
      if (c.req.header(SESSION_HEADER) !== '1' || c.env?.internalAuth) return c.json({ statusCode: 403, message: 'Sign in first' }, 403);
      return sessionAuth(deps)(c, async () => {
        const productId = c.get('productId');
        if (!productId) throw new HttpError(403, 'Sign in first');
        c.set('scopeProductId', productId);
        await next();
      });
    });
  } else {
    app.use('*', async (c, next) => {
      const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
      if (!config.adminToken || !match || !tokenMatches(match[1]!, config.adminToken)) {
        return c.json({ statusCode: 403, message: 'Admin token required' }, 403);
      }
      await next();
    });
  }

  /** For the platform admin only; a signed-in customer gets 404, as if the route weren't there. */
  const adminOnly: MiddlewareHandler = async (c, next) => {
    if (scopedProduct(c)) throw notFound('Not found');
    await next();
  };
  app.post('/products', adminOnly);
  app.put('/products/:productId', adminOnly);
  app.post('/products/:productId/storefront', adminOnly);
  app.use('/db-backups', adminOnly);
  app.use('/plugins', adminOnly);
  app.use('/products/:productId/plugins/*', adminOnly);
  app.put('/products/:productId/organization', adminOnly);
  app.use('/applications', adminOnly);
  app.use('/applications/*', adminOnly);
  app.use('/resellers', adminOnly);
  app.use('/resellers/*', adminOnly);

  // Products' organizations, members and invitations: the Team page (src/accounts.ts).
  app.route('/', adminAccountRoutes(deps));

  // Applications to sell on the platform, waiting for the platform admin (src/applications.ts).
  app.route('/applications', adminApplicationRoutes(deps));

  // Reseller accounts: storefronts grouped under one partner, and their usage (src/resellers.ts).
  app.route('/resellers', adminResellerRoutes(deps));

  // Every product's webhook endpoints and deliveries (src/routes/webhooks.ts).
  app.route('/webhooks', adminWebhookRoutes(deps));

  async function jobCounts(productId: string | null) {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS queued,
              count(*) FILTER (WHERE state = 'active')::int AS running
         FROM pgboss.job j WHERE name = $1 AND state IN ('created', 'retry', 'active') AND ${jobOfProduct(2)}`,
      [QUEUE, productId],
    );
    const failed = await pool.query(`SELECT count(*)::int AS n FROM job_failures f WHERE status = 'failed' AND ${failureOfProduct(1)}`, [productId]);
    return { queued: rows[0].queued, running: rows[0].running, failed: failed.rows[0].n };
  }

  const byStatus = async (table: string, productId: string | null) => {
    const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM ${table} WHERE ($1::uuid IS NULL OR product_id = $1) GROUP BY status`, [
      productId,
    ]);
    const counts = { pending: 0, done: 0, failed: 0, removing: 0 };
    for (const r of rows) counts[statusName(r.status).toLowerCase() as keyof typeof counts] = r.n;
    return counts;
  };

  app.get('/overview', async (c) => {
    // Counts for one storefront (?productId, or the customer's own); the product list stays whole
    // for the platform admin, so the storefront switcher keeps every choice.
    const own = scopedProduct(c);
    const scope = own ?? uuidQuery(c, 'productId') ?? null;
    const [health, tenants, versions, backups, jobs, suspended, products] = await Promise.all([
      checkHealth(pool, boss, !!deps.config.dbBackup),
      byStatus('tenants', scope),
      byStatus('versions', scope),
      byStatus('tenant_backups', scope),
      jobCounts(scope),
      pool.query('SELECT count(*)::int AS n FROM tenants WHERE is_suspended AND ($1::uuid IS NULL OR product_id = $1)', [scope]),
      pool.query(
        `SELECT p.id, p.name, count(t.id)::int AS tenant_count
           FROM products p LEFT JOIN tenants t ON t.product_id = p.id
          WHERE ($1::uuid IS NULL OR p.id = $1) GROUP BY p.id ORDER BY p.name`,
        [own],
      ),
    ]);
    return c.json({
      health,
      tenants: { ...tenants, suspended: suspended.rows[0].n },
      versions,
      backups,
      jobs,
      products: products.rows.map((p) => ({ id: p.id, name: p.name, tenantCount: p.tenant_count })),
    });
  });

  app.get('/tenants', async (c) => {
    const { page: pageNumber, pageSize, offset } = page(c);
    const q = c.req.query('q')?.trim();
    const params = [
      scopedProduct(c) ?? uuidQuery(c, 'productId') ?? null,
      statusQuery(c) ?? null,
      booleanQuery(c, 'suspended') ?? null,
      uuidQuery(c, 'versionId') ?? null,
      q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null,
    ];
    const where = `($1::uuid IS NULL OR t.product_id = $1) AND ($2::int IS NULL OR t.status = $2)
      AND ($3::boolean IS NULL OR t.is_suspended = $3) AND ($4::uuid IS NULL OR t.version_id = $4)
      AND ($5::text IS NULL OR t.external_id ILIKE $5 OR t.name ILIKE $5
           OR EXISTS (SELECT 1 FROM tenant_domains d WHERE d.tenant_id = t.id AND d.domain_name ILIKE $5))`;
    const [{ rows }, total] = await Promise.all([
      pool.query(
        `SELECT t.*, p.name AS product_name, v.name AS version_name,
           (SELECT domain_name FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_main) AS main_domain,
           (SELECT count(*)::int FROM tenant_domains d WHERE d.tenant_id = t.id) AS domain_count,
           (SELECT max(date_created) FROM tenant_backups b WHERE b.tenant_id = t.id AND b.status = 1) AS latest_backup_at
         FROM tenants t JOIN products p ON p.id = t.product_id JOIN versions v ON v.id = t.version_id
         WHERE ${where} ORDER BY t.date_created DESC, t.id LIMIT ${pageSize} OFFSET ${offset}`,
        params,
      ),
      pool.query(`SELECT count(*)::int AS n FROM tenants t WHERE ${where}`, params),
    ]);
    return c.json({
      items: rows.map((t) => ({
        id: t.id,
        externalId: t.external_id,
        name: t.name,
        productId: t.product_id,
        productName: t.product_name,
        versionId: t.version_id,
        versionName: t.version_name,
        mainDomain: t.main_domain,
        domainCount: t.domain_count,
        statusCode: t.status,
        statusName: statusName(t.status),
        size: t.size,
        isSuspended: t.is_suspended,
        latestBackupAt: iso(t.latest_backup_at),
        dateCreated: iso(t.date_created),
      })),
      total: total.rows[0].n,
      page: pageNumber,
      pageSize,
    });
  });

  app.get('/tenants/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw notFound(`Tenant ${id} not found`);
    const { rows } = await pool.query(
      `SELECT t.*, p.name AS product_name, v.name AS version_name FROM tenants t
         JOIN products p ON p.id = t.product_id JOIN versions v ON v.id = t.version_id
        WHERE t.id = $1 AND ($2::uuid IS NULL OR t.product_id = $2)`,
      [id, scopedProduct(c)],
    );
    const t = rows[0];
    if (!t) throw notFound(`Tenant ${id} not found`);
    const [domains, backups, jobs, failures, moveIn, emailUsage] = await Promise.all([
      pool.query('SELECT * FROM tenant_domains WHERE tenant_id = $1 ORDER BY date_created', [id]),
      pool.query('SELECT * FROM tenant_backups WHERE tenant_id = $1 ORDER BY date_created DESC', [id]),
      pool.query(
        `SELECT id, data, state, retry_count, created_on, started_on, completed_on FROM pgboss.job
          WHERE name = $1 AND singleton_key = $2 ORDER BY created_on DESC LIMIT 20`,
        [QUEUE, `tenant:${id}`],
      ),
      pool.query('SELECT * FROM job_failures WHERE tenant_id = $1 ORDER BY failed_at DESC LIMIT 20', [id]),
      importDetail(pool, id),
      mailUsage(pool, id),
    ]);
    return c.json({
      id: t.id,
      externalId: t.external_id,
      name: t.name,
      productId: t.product_id,
      productName: t.product_name,
      versionId: t.version_id,
      versionName: t.version_name,
      snapshotName: t.snapshot_name,
      snapshotGroupName: t.snapshot_group_name,
      statusCode: t.status,
      statusName: statusName(t.status),
      size: t.size,
      keepsOwnCode: t.own_code,
      // A site moved in from another host (docs/site-imports.md): waiting while it has no startedAt.
      ...(moveIn && { moveIn }),
      // This month's emails as the platform counted them on toSend (docs/store-email.md), once counted.
      ...(emailUsage && { emailUsage }),
      isSuspended: t.is_suspended,
      dateSuspended: iso(t.date_suspended),
      dateCreated: iso(t.date_created),
      dateChanged: iso(t.date_changed),
      // Names only: values can be secret.
      wpOptionNames: Object.keys(t.wp_options).sort(),
      phpConstantNames: Object.keys(t.php_constants).sort(),
      domains: domains.rows.map((d) => ({ id: d.id, domainName: d.domain_name, isMainDomain: d.is_main, isBaseDomain: d.is_base })),
      backups: backups.rows.map(toBackup),
      recentJobs: jobs.rows.map((j) => ({
        id: j.id,
        ...jobTarget(j.data),
        state: j.state,
        attempts: j.retry_count + 1,
        createdOn: iso(j.created_on),
        startedOn: iso(j.started_on),
        completedOn: iso(j.completed_on),
      })),
      failures: failures.rows.map(toFailure),
    });
  });

  // Moving a site in (docs/site-imports.md): a store of the product that waits for its site, and its import code.
  app.post('/products/:productId/imports', async (c) => {
    const productId = await product(c);
    const body = ((await readJson(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.name !== 'string') throw badRequest('name is required');
    const params = {
      name: body.name,
      uploadCustomSnapshot: true,
      ...(typeof body.size === 'string' && { size: body.size }),
      ...(typeof body.customDomainName === 'string' && body.customDomainName.trim() && { customDomainName: body.customDomainName.trim() }),
    } as Parameters<typeof createTenant>[2];
    const created = (await createTenant(deps, productId, params, publicBase(c, config.publicUrl))) as { id: string; externalId: string; importCode?: string };
    return c.json({ tenantId: created.id, externalId: created.externalId, importCode: created.importCode, pluginUrl: `${publicBase(c, config.publicUrl)}/imports/plugin.zip` });
  });

  // A new store of the product from its production version and latest template, as POST /v1/tenants
  // makes it: the dashboard's "New site", so a store can be made without the storefront or a key.
  app.post('/products/:productId/tenants', async (c) => {
    const productId = await product(c);
    const body = ((await readJson(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.name !== 'string') throw badRequest('name is required');
    if (body.size !== undefined && !['small', 'medium', 'large'].includes(body.size as string)) throw badRequest('size must be small, medium or large');
    const params = {
      name: body.name.trim().slice(0, 100),
      ...(typeof body.size === 'string' && { size: body.size }),
      ...(typeof body.customDomainName === 'string' && body.customDomainName.trim() && { customDomainName: body.customDomainName.trim() }),
    } as Parameters<typeof createTenant>[2];
    const created = (await createTenant(deps, productId, params, publicBase(c, config.publicUrl))) as { id: string; externalId: string };
    return c.json({ tenantId: created.id, externalId: created.externalId }, 201);
  });

  app.post('/tenants/:id/import-code', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw notFound(`Tenant ${id} not found`);
    const { rows } = await pool.query('SELECT id, external_id FROM tenants WHERE id = $1 AND ($2::uuid IS NULL OR product_id = $2)', [id, scopedProduct(c)]);
    if (!rows[0]) throw notFound(`Tenant ${id} not found`);
    const token = await renewImport(pool, id);
    if (!token) throw badRequest('This store is not waiting for a site to be moved in');
    const base = publicBase(c, config.publicUrl);
    return c.json({ tenantId: id, externalId: rows[0].external_id, importCode: importCode(base, token), pluginUrl: `${base}/imports/plugin.zip` });
  });

  // Makes a domain the store's main address (adding it if new), as the storefront's addTenantDomain
  // with setAsMainDomain does, for any product. The old main domain stays as a redirect.
  app.put('/tenants/:id/domains/main', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw notFound(`Tenant ${id} not found`);
    const body = (await readJson(c)) as { domainName?: unknown };
    if (typeof body?.domainName !== 'string' || !body.domainName.trim()) throw badRequest('domainName is required');
    const { rows } = await pool.query('SELECT id, external_id, status FROM tenants WHERE id = $1 AND ($2::uuid IS NULL OR product_id = $2)', [
      id,
      scopedProduct(c),
    ]);
    if (!rows[0]) throw notFound(`Tenant ${id} not found`);
    assertChangeable(rows[0]);
    return c.json(await addTenantDomain(deps, rows[0], body.domainName, true));
  });

  // Rolls a live store back to one of its own Done backups, in place (docs/store-backups.md). What
  // the store holds now is backed up first ('before-restore') unless takeBackup is false.
  app.post('/tenants/:id/restore', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw notFound(`Tenant ${id} not found`);
    const body = ((await readJson(c)) ?? {}) as { backupId?: unknown; takeBackup?: unknown };
    if (typeof body.backupId !== 'string' || !isUuid(body.backupId)) throw badRequest('backupId is required');
    if (body.takeBackup !== undefined && typeof body.takeBackup !== 'boolean') throw badRequest('takeBackup must be a boolean');
    const { rows } = await pool.query(
      'SELECT id, product_id, external_id, status FROM tenants WHERE id = $1 AND ($2::uuid IS NULL OR product_id = $2)',
      [id, scopedProduct(c)],
    );
    const tenant = rows[0];
    if (!tenant) throw notFound(`Tenant ${id} not found`);
    assertChangeable(tenant);
    const { rows: backups } = await pool.query('SELECT id FROM tenant_backups WHERE id = $1 AND tenant_id = $2 AND status = $3', [
      body.backupId,
      id,
      Status.Done,
    ]);
    if (!backups[0]) throw badRequest(`Backup ${body.backupId} is not a Done backup of this store`);
    const safetyBackupId = body.takeBackup === false ? null : randomUUID();
    await withTransaction(pool, async (client) => {
      if (safetyBackupId) {
        await client.query(
          "INSERT INTO tenant_backups (id, product_id, tenant_id, external_id, reason) VALUES ($1, $2, $3, $4, 'before-restore')",
          [safetyBackupId, tenant.product_id, id, tenant.external_id],
        );
      }
      await client.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1', [id, Status.Pending]);
      await enqueue(boss, client, { type: 'tenant.rollback', tenantId: id, backupId: body.backupId as string, ...(safetyBackupId ? { safetyBackupId } : {}) });
    });
    return c.json({ tenantId: id, externalId: tenant.external_id, backupId: body.backupId, safetyBackupId });
  });

  // The store's own sending domain (docs/store-email.md): GET shows it with the DNS records to add
  // (null: it sends from the platform's address), PUT adds it, DELETE moves the store back.
  async function mailTenant(c: Context) {
    const id = c.req.param('id');
    if (!id || !isUuid(id)) throw notFound(`Tenant ${id} not found`);
    const { rows } = await pool.query('SELECT id, external_id, status FROM tenants WHERE id = $1 AND ($2::uuid IS NULL OR product_id = $2)', [
      id,
      scopedProduct(c),
    ]);
    if (!rows[0]) throw notFound(`Tenant ${id} not found`);
    return rows[0];
  }

  app.get('/tenants/:id/mail-domain', async (c) => {
    const tenant = await mailTenant(c);
    return c.json({ mailDomain: await getMailDomain(pool, config.sendingDomains, tenant.id) });
  });

  app.put('/tenants/:id/mail-domain', async (c) => {
    const tenant = await mailTenant(c);
    assertChangeable(tenant);
    const body = (await readJson(c)) as { domainName?: unknown };
    if (typeof body?.domainName !== 'string' || !body.domainName.trim()) throw badRequest('domainName is required');
    const from = config.coolify?.mail?.from;
    if (!from) throw badRequest('Stores send no email: STORE_SMTP_PASSWORD is not set on the API');
    return c.json({ mailDomain: await setMailDomain(pool, config.sendingDomains, tenant.id, body.domainName, from) });
  });

  app.get('/tenants/:id/domain-connect', async (c) => {
    const tenant = await mailTenant(c);
    return c.json(await storeDomainConnect(deps, tenant.id, c.req.query('domainName'), c.req.query('service')));
  });

  app.delete('/tenants/:id/mail-domain', async (c) => {
    const tenant = await mailTenant(c);
    const removed = await removeMailDomain(pool, tenant.id);
    if (!removed) throw notFound('This store has no sending domain');
    return c.json(removed);
  });

  const toBackup = backupView(config.backupRetentionDays);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function toFailure(f: any) {
    return {
      id: f.id,
      jobId: f.job_id,
      ...jobTarget(f.job_data),
      errorMessage: f.error_message,
      attempts: f.attempts,
      failedAt: iso(f.failed_at),
      status: f.status,
      retriedAt: iso(f.retried_at),
      retryJobId: f.retry_job_id,
    };
  }

  app.get('/backups', (c) => listBackups(pool, config.backupRetentionDays, c, scopedProduct(c) ?? uuidQuery(c, 'productId') ?? null));

  app.get('/db-backups', async (c) => {
    const { page: pageNumber, pageSize, offset } = page(c);
    const [status, list, total] = await Promise.all([
      dbBackupStatus(pool, !!deps.config.dbBackup),
      pool.query(`SELECT * FROM db_backups ORDER BY started_at DESC, id LIMIT ${pageSize} OFFSET ${offset}`),
      pool.query('SELECT count(*)::int AS n FROM db_backups'),
    ]);
    return c.json({
      ...status,
      items: list.rows.map((b) => ({
        id: b.id,
        status: b.status,
        startedAt: iso(b.started_at),
        finishedAt: iso(b.finished_at),
        objectKey: b.object_key,
        sizeBytes: b.size_bytes === null ? null : Number(b.size_bytes),
        error: b.error_message,
        prunedAt: iso(b.pruned_at),
      })),
      total: total.rows[0].n,
      page: pageNumber,
      pageSize,
    });
  });

  app.get('/requests', (c) => listRequests(pool, config, c, scopedProduct(c) ?? uuidQuery(c, 'productId') ?? null));

  app.get('/jobs', async (c) => {
    const state = c.req.query('state') ?? 'queued';
    const { page: pageNumber, pageSize, offset } = page(c);
    const scope = scopedProduct(c);
    const counts = await jobCounts(scope);
    if (state === 'failed') {
      const { rows } = await pool.query(
        `SELECT * FROM job_failures f WHERE status = 'failed' AND ${failureOfProduct(1)} ORDER BY failed_at DESC, id LIMIT ${pageSize} OFFSET ${offset}`,
        [scope],
      );
      return c.json({ state, counts, items: rows.map(toFailure), total: counts.failed, page: pageNumber, pageSize });
    }
    if (state !== 'queued' && state !== 'running') throw badRequest('state must be queued, running or failed');
    const states = state === 'queued' ? ['created', 'retry'] : ['active'];
    const { rows } = await pool.query(
      `SELECT id, data, state, retry_count, created_on, started_on, start_after FROM pgboss.job j
        WHERE name = $1 AND state::text = ANY($2) AND ${jobOfProduct(3)} ORDER BY created_on, id LIMIT ${pageSize} OFFSET ${offset}`,
      [QUEUE, states, scope],
    );
    return c.json({
      state,
      counts,
      items: rows.map((j) => ({
        id: j.id,
        ...jobTarget(j.data),
        state: j.state,
        attempts: j.retry_count + 1,
        createdOn: iso(j.created_on),
        startedOn: iso(j.started_on),
        startAfter: iso(j.start_after),
      })),
      total: state === 'queued' ? counts.queued : counts.running,
      page: pageNumber,
      pageSize,
    });
  });

  // Versions and templates of any product: the same operations, request and response shapes as
  // the /v1 ones (listVersions, createVersion, deleteVersion, setProductionVersion and the
  // base-snapshot operations), with the product taken from the path.

  async function products(id: string | null) {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.created_at, p.max_tenants, p.reseller_id, r.name AS reseller_name,
         (SELECT count(*)::int FROM tenants t WHERE t.product_id = p.id) AS tenant_count,
         (SELECT count(*)::int FROM versions v WHERE v.product_id = p.id) AS version_count,
         (SELECT v.id FROM versions v WHERE v.product_id = p.id AND v.is_production) AS production_version_id
       FROM products p LEFT JOIN resellers r ON r.id = p.reseller_id
       WHERE ($1::uuid IS NULL OR p.id = $1) ORDER BY p.name, p.id`,
      [id],
    );
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      tenantCount: p.tenant_count,
      maxTenants: p.max_tenants,
      versionCount: p.version_count,
      productionVersionId: p.production_version_id,
      resellerId: p.reseller_id,
      resellerName: p.reseller_name,
      dateCreated: iso(p.created_at),
    }));
  }

  app.get('/products', async (c) => c.json(await products(scopedProduct(c))));

  // The product's settings. Only maxTenants for now: the most tenants it may have, or null for no
  // limit. Lowering it below the current count deletes nothing; it only stops new ones.
  app.put('/products/:productId', async (c) => {
    const productId = await product(c);
    const body = (await readJson(c)) as { maxTenants?: unknown };
    const max = body?.maxTenants;
    if (max !== null && !(typeof max === 'number' && Number.isInteger(max) && max >= 0 && max <= 100000)) {
      throw badRequest('maxTenants must be a whole number, 0 or more, or null for no limit');
    }
    await pool.query('UPDATE products SET max_tenants = $2 WHERE id = $1', [productId, max]);
    return c.json((await products(productId))[0]);
  });

  // A new product (an agency's storefront) with its first API key. The secret is in this response
  // only; the dashboard shows it once.
  app.post('/products', async (c) => {
    const body = (await readJson(c)) as { name?: unknown; maxTenants?: unknown; keyLabel?: unknown };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) throw badRequest('name is required, at most 100 characters');
    const max = body?.maxTenants ?? null;
    if (max !== null && !(typeof max === 'number' && Number.isInteger(max) && max >= 0 && max <= 100000)) {
      throw badRequest('maxTenants must be a whole number, 0 or more, or null for no limit');
    }
    const label = parseLabel(body?.keyLabel);
    const { rows } = await pool.query<{ id: string }>('INSERT INTO products (name, max_tenants) VALUES ($1, $2) RETURNING id', [name, max]);
    const productId = rows[0]!.id;
    const key = await addApiKey(pool, productId, label);
    c.header('Cache-Control', 'no-store');
    return c.json({ product: (await products(productId))[0], key }, 201);
  });

  // A product's API keys: the same operations as /v1/keys, for any product. Unlike /v1/keys, the
  // last active key can be revoked (to cut a storefront off).
  app.get('/products/:productId/keys', async (c) => c.json(await listApiKeys(pool, await product(c))));
  app.post('/products/:productId/keys', async (c) => {
    const body = (await readJson(c)) as { label?: unknown };
    const key = await addApiKey(pool, await product(c), parseLabel(body?.label));
    c.header('Cache-Control', 'no-store');
    return c.json(key, 201);
  });
  app.post('/products/:productId/keys/:id/rotate', async (c) => {
    const body = (await readJson(c)) as { graceHours?: unknown };
    const result = await rotateApiKey(pool, await product(c), c.req.param('id'), parseGraceHours(body?.graceHours));
    c.header('Cache-Control', 'no-store');
    return c.json(result, 201);
  });
  app.delete('/products/:productId/keys/:id', async (c) => c.json(await revokeApiKey(pool, await product(c), c.req.param('id'))));

  // The product's ready-made storefront (src/storefronts.ts): a WordPress site with WaaS Host, already
  // connected. GET answers null when it has none; POST builds it (platform admin only).
  app.get('/products/:productId/storefront', async (c) => c.json(await getStorefront(deps, await product(c))));
  app.post('/products/:productId/storefront', async (c) => {
    const productId = await product(c);
    const body = (await readJson(c)) as NewStorefront;
    return c.json(await createStorefront(deps, productId, body, publicBase(c, config.publicUrl)), 201);
  });

  async function product(c: Context): Promise<string> {
    const productId = c.req.param('productId')!;
    const scope = scopedProduct(c);
    if (scope && productId !== scope) throw notFound(`Product ${productId} not found`);
    if (!isUuid(productId) || !(await pool.query('SELECT 1 FROM products WHERE id = $1', [productId])).rowCount) {
      throw notFound(`Product ${productId} not found`);
    }
    return productId;
  }

  function versionId(c: Context): string {
    const id = c.req.param('id')!;
    if (!isUuid(id)) throw notFound(`Version ${id} not found`);
    return id;
  }

  app.get('/products/:productId/versions', async (c) =>
    c.json(await versions.list(await product(c), { versionId: uuidQuery(c, 'versionId'), versionName: c.req.query('versionName') || undefined })),
  );
  app.post('/products/:productId/versions', async (c) => c.json(await versions.create(await product(c), await readJson(c))));
  app.delete('/products/:productId/versions/:id', async (c) => {
    await versions.remove(await product(c), versionId(c));
    return c.body(null, 200);
  });
  app.put('/products/:productId/versions/:id/production', async (c) => c.json(await versions.setProduction(await product(c), versionId(c))));

  app.get('/products/:productId/basesnapshots', async (c) => {
    booleanQuery(c, 'onlyPartnerSpecific');
    return c.json(
      await templates.list(await product(c), {
        baseSnapshotId: uuidQuery(c, 'baseSnapshotId'),
        name: c.req.query('name') || undefined,
        groupName: c.req.query('groupName') || undefined,
      }),
    );
  });
  app.post('/products/:productId/basesnapshots', async (c) => c.json(await templates.create(await product(c), await readJson(c))));
  app.delete('/products/:productId/basesnapshots', async (c) => c.json(await templates.remove(await product(c), requiredUuidQuery(c, 'id'))));

  // Plugin updates (waas-hw4): which version each site last reported, and per-product pins.
  app.get('/plugins', async (c) => {
    const productId = uuidQuery(c, 'productId') ?? null;
    const slug = c.req.query('slug') || null;
    const [installs, pins] = await Promise.all([
      pool.query(
        `SELECT i.*, p.name AS product_name FROM plugin_installs i JOIN products p ON p.id = i.product_id
          WHERE ($1::uuid IS NULL OR i.product_id = $1) AND ($2::text IS NULL OR i.slug = $2)
          ORDER BY p.name, i.slug, i.site`,
        [productId, slug],
      ),
      pool.query(
        `SELECT * FROM plugin_pins WHERE ($1::uuid IS NULL OR product_id = $1) AND ($2::text IS NULL OR slug = $2)
          ORDER BY product_id, slug`,
        [productId, slug],
      ),
    ]);
    return c.json({
      installs: installs.rows.map((i) => ({
        productId: i.product_id,
        productName: i.product_name,
        slug: i.slug,
        site: i.site,
        version: i.version,
        channel: i.channel,
        wpVersion: i.wp_version,
        phpVersion: i.php_version,
        firstSeen: iso(i.first_seen),
        lastSeen: iso(i.last_seen),
      })),
      pins: pins.rows.map(toPin),
    });
  });

  function pluginSlug(c: Context) {
    const slug = c.req.param('slug')!;
    if (!isPluginSlug(slug)) throw notFound(`Unknown plugin ${slug}`);
    return slug;
  }

  // Holds a product's sites at one release, which must exist in the releases bucket.
  app.put('/products/:productId/plugins/:slug/pin', async (c) => {
    const productId = await product(c);
    const slug = pluginSlug(c);
    const body = (await readJson(c)) as { version?: unknown };
    const version = body?.version;
    if (typeof version !== 'string' || !RELEASE_VERSION.test(version)) throw badRequest('version must be a release version, like 2.3.0 or 2.3.0-beta.1');
    if (!releases) throw new HttpError(503, 'Plugin updates are not configured');
    if (!parseManifest(await releases.getJson(manifestKey(slug, version)), slug, version)) {
      throw badRequest(`Release ${version} of ${slug} not found`);
    }
    const { rows } = await pool.query(
      `INSERT INTO plugin_pins (product_id, slug, version) VALUES ($1, $2, $3)
       ON CONFLICT (product_id, slug) DO UPDATE SET version = EXCLUDED.version, pinned_at = now() RETURNING *`,
      [productId, slug, version],
    );
    return c.json(toPin(rows[0]));
  });

  app.delete('/products/:productId/plugins/:slug/pin', async (c) => {
    await pool.query('DELETE FROM plugin_pins WHERE product_id = $1 AND slug = $2', [await product(c), pluginSlug(c)]);
    return c.body(null, 200);
  });

  // Idempotent: retrying an already retried failure returns the same result.
  app.post('/jobs/failures/:id/retry', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw notFound(`Failure ${id} not found`);
    const scope = scopedProduct(c);
    const failure = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(`SELECT * FROM job_failures f WHERE id = $1 AND ${failureOfProduct(2)} FOR UPDATE`, [id, scope]);
      const f = rows[0];
      if (!f) throw notFound(`Failure ${id} not found`);
      if (f.status === 'retried') return f;
      if (!(await resetForRetry(client, f.job_data))) {
        throw badRequest('The record this job worked on is gone or no longer Failed; nothing to retry');
      }
      const jobId = await enqueue(boss, client, f.job_data);
      const { rows: updated } = await client.query(
        "UPDATE job_failures SET status = 'retried', retried_at = now(), retry_job_id = $2 WHERE id = $1 RETURNING *",
        [id, jobId],
      );
      return updated[0];
    });
    return c.json(toFailure(failure));
  });

  return app;
}

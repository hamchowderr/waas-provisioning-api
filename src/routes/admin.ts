import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { Deps } from '../app.ts';
import { withTransaction, type Client } from '../db.ts';
import { HttpError, badRequest } from '../errors.ts';
import { checkHealth } from '../health.ts';
import { booleanQuery, isUuid, readJson, requiredUuidQuery, uuidQuery } from '../http.ts';
import { enqueue, QUEUE, type JobData } from '../queue.ts';
import { isPluginSlug, manifestKey, parseManifest, RELEASE_VERSION } from '../releases.ts';
import { Status, statusName } from '../status.ts';
import { baseSnapshotService } from './basesnapshots.ts';
import { versionService } from './versions.ts';

/**
 * Admin API for the dashboard (waas-api-plu). Outside the WPCS contract: documented in the README
 * and openapi/admin/admin-api.yaml. Sees every product. Authenticated with ADMIN_TOKEN as a
 * bearer token; product keys get 403.
 */

const notFound = (what: string) => new HttpError(404, what);

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Compares digests, so the comparison takes the same time whatever the token's length. */
function tokenMatches(given: string, expected: string): boolean {
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
    case 'basesnapshot.delete':
      return true; // nothing recorded to reset; the archive delete is simply tried again
    default:
      return tenant(data.tenantId, Status.Pending);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toPin = (p: any) => ({ productId: p.product_id, slug: p.slug, version: p.version, pinnedAt: iso(p.pinned_at) });

export function adminRoutes(deps: Deps) {
  const { config, pool, boss, releases } = deps;
  const versions = versionService(deps);
  const templates = baseSnapshotService(deps);
  const app = new Hono();

  app.use('*', async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
    if (!config.adminToken || !match || !tokenMatches(match[1]!, config.adminToken)) {
      return c.json({ statusCode: 403, message: 'Admin token required' }, 403);
    }
    await next();
  });

  async function jobCounts() {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS queued,
              count(*) FILTER (WHERE state = 'active')::int AS running
         FROM pgboss.job WHERE name = $1`,
      [QUEUE],
    );
    const failed = await pool.query("SELECT count(*)::int AS n FROM job_failures WHERE status = 'failed'");
    return { queued: rows[0].queued, running: rows[0].running, failed: failed.rows[0].n };
  }

  const byStatus = async (table: string) => {
    const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM ${table} GROUP BY status`);
    const counts = { pending: 0, done: 0, failed: 0, removing: 0 };
    for (const r of rows) counts[statusName(r.status).toLowerCase() as keyof typeof counts] = r.n;
    return counts;
  };

  app.get('/overview', async (c) => {
    const [health, tenants, versions, backups, jobs, suspended, products] = await Promise.all([
      checkHealth(pool, boss),
      byStatus('tenants'),
      byStatus('versions'),
      byStatus('tenant_backups'),
      jobCounts(),
      pool.query('SELECT count(*)::int AS n FROM tenants WHERE is_suspended'),
      pool.query(
        `SELECT p.id, p.name, count(t.id)::int AS tenant_count
           FROM products p LEFT JOIN tenants t ON t.product_id = p.id GROUP BY p.id ORDER BY p.name`,
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
      uuidQuery(c, 'productId') ?? null,
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
         JOIN products p ON p.id = t.product_id JOIN versions v ON v.id = t.version_id WHERE t.id = $1`,
      [id],
    );
    const t = rows[0];
    if (!t) throw notFound(`Tenant ${id} not found`);
    const [domains, backups, jobs, failures] = await Promise.all([
      pool.query('SELECT * FROM tenant_domains WHERE tenant_id = $1 ORDER BY date_created', [id]),
      pool.query('SELECT * FROM tenant_backups WHERE tenant_id = $1 ORDER BY date_created DESC', [id]),
      pool.query(
        `SELECT id, data, state, retry_count, created_on, started_on, completed_on FROM pgboss.job
          WHERE name = $1 AND singleton_key = $2 ORDER BY created_on DESC LIMIT 20`,
        [QUEUE, `tenant:${id}`],
      ),
      pool.query('SELECT * FROM job_failures WHERE tenant_id = $1 ORDER BY failed_at DESC LIMIT 20', [id]),
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function toBackup(b: any) {
    return {
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
      expiresAt: b.tenant_deleted_at ? new Date(new Date(b.tenant_deleted_at).getTime() + config.backupRetentionDays * 86400000).toISOString() : null,
    };
  }

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

  app.get('/backups', async (c) => {
    const { page: pageNumber, pageSize, offset } = page(c);
    const params = [
      uuidQuery(c, 'productId') ?? null,
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
    return c.json({ items: rows.map(toBackup), total: total.rows[0].n, page: pageNumber, pageSize });
  });

  app.get('/jobs', async (c) => {
    const state = c.req.query('state') ?? 'queued';
    const { page: pageNumber, pageSize, offset } = page(c);
    const counts = await jobCounts();
    if (state === 'failed') {
      const { rows } = await pool.query(
        `SELECT * FROM job_failures WHERE status = 'failed' ORDER BY failed_at DESC, id LIMIT ${pageSize} OFFSET ${offset}`,
      );
      return c.json({ state, counts, items: rows.map(toFailure), total: counts.failed, page: pageNumber, pageSize });
    }
    if (state !== 'queued' && state !== 'running') throw badRequest('state must be queued, running or failed');
    const states = state === 'queued' ? ['created', 'retry'] : ['active'];
    const { rows } = await pool.query(
      `SELECT id, data, state, retry_count, created_on, started_on, start_after FROM pgboss.job
        WHERE name = $1 AND state::text = ANY($2) ORDER BY created_on, id LIMIT ${pageSize} OFFSET ${offset}`,
      [QUEUE, states],
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
  // the WPCS ones (listVersions, createVersion, deleteVersion, setProductionVersion and the
  // base-snapshot operations), with the product taken from the path.

  app.get('/products', async (c) => {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.created_at,
         (SELECT count(*)::int FROM tenants t WHERE t.product_id = p.id) AS tenant_count,
         (SELECT count(*)::int FROM versions v WHERE v.product_id = p.id) AS version_count,
         (SELECT v.id FROM versions v WHERE v.product_id = p.id AND v.is_production) AS production_version_id
       FROM products p ORDER BY p.name, p.id`,
    );
    return c.json(
      rows.map((p) => ({
        id: p.id,
        name: p.name,
        tenantCount: p.tenant_count,
        versionCount: p.version_count,
        productionVersionId: p.production_version_id,
        dateCreated: iso(p.created_at),
      })),
    );
  });

  async function product(c: Context): Promise<string> {
    const productId = c.req.param('productId')!;
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
    const failure = await withTransaction(pool, async (client) => {
      const { rows } = await client.query('SELECT * FROM job_failures WHERE id = $1 FOR UPDATE', [id]);
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

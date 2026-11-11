import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import { withTransaction, type Pool } from './db.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import { isUuid, scopedProduct } from './http.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import { enqueue } from './queue.ts';
import { siteKeys, verifySiteRequest } from './sitekeys.ts';
import { Status, statusName } from './status.ts';

/**
 * "Download my site" (docs/site-downloads.md): a copy of a whole store (WordPress, its files and its database, with
 * how to restore it) as a plain WordPress archive its owner can put up on any host. The dashboard asks for one on a
 * store's page (sellers and resellers, for their clients' sites), and AnyPress Client in the store's wp-admin
 * (its administrators), signing with the store's site key. A copy is kept a week; each link works for an hour.
 */

/** Asking again within this many minutes of the last copy gives that copy, not a new one. */
const REUSE_MINUTES = 10;
/** Copies are deleted from storage once they are this many days old. */
const DOWNLOAD_KEEP_DAYS = 7;
/** How long a download link works. */
const LINK_SECONDS = 3600;
/** The route AnyPress Client signs for a store's own download. */
export const SITE_DOWNLOAD_ROUTE = '/sites/download';

interface SiteDownload {
  id: string;
  statusCode: number;
  statusName: string;
  sizeBytes: number | null;
  dateCreated: string;
  dateDone: string | null;
  /** When the copy is deleted from storage. */
  expiresAt: string;
  fileName: string;
  /** A link to the copy that works for an hour, once it is Done. */
  url: string | null;
}

interface Store {
  id: string;
  product_id: string;
  external_id: string;
  status: number;
  main_domain: string | null;
}

interface DownloadRow {
  id: string;
  status: number;
  size_bytes: string | null;
  file_name: string;
  date_created: Date;
  date_done: Date | null;
}

async function describe(provisioner: Provisioner, row: DownloadRow | undefined): Promise<SiteDownload | null> {
  if (!row) return null;
  const done = row.status === Status.Done;
  return {
    id: row.id,
    statusCode: row.status,
    statusName: statusName(row.status),
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    dateCreated: row.date_created.toISOString(),
    dateDone: row.date_done?.toISOString() ?? null,
    expiresAt: new Date(row.date_created.getTime() + DOWNLOAD_KEEP_DAYS * 86_400_000).toISOString(),
    fileName: row.file_name,
    url: done ? await provisioner.downloadUrl({ downloadId: row.id, fileName: row.file_name, expiresInSeconds: LINK_SECONDS }) : null,
  };
}

async function newest(pool: Pool, tenantId: string): Promise<DownloadRow | undefined> {
  const { rows } = await pool.query<DownloadRow>(
    `SELECT id, status, size_bytes, file_name, date_created, date_done FROM site_downloads
      WHERE tenant_id = $1 AND date_created > now() - make_interval(days => $2) ORDER BY date_created DESC, id LIMIT 1`,
    [tenantId, DOWNLOAD_KEEP_DAYS],
  );
  return rows[0];
}

/** The store's newest copy from the last week, any status, or null. */
async function currentDownload(pool: Pool, provisioner: Provisioner, store: Store): Promise<SiteDownload | null> {
  return describe(provisioner, await newest(pool, store.id));
}

/**
 * Starts a new copy of the store, unless one is being made or the last was made in the last few minutes (a second
 * press gives that one). The store keeps running meanwhile.
 */
async function startDownload(deps: Pick<Deps, 'pool' | 'boss' | 'provisioner'>, store: Store): Promise<SiteDownload> {
  if (store.status === Status.Removing || store.status === Status.Failed) throw badRequest(`Tenant ${store.external_id} is ${statusName(store.status)}`);
  const last = await newest(deps.pool, store.id);
  if (last && (last.status === Status.Pending || (last.status === Status.Done && Date.now() - last.date_created.getTime() < REUSE_MINUTES * 60_000))) {
    return (await describe(deps.provisioner, last))!;
  }
  const id = randomUUID();
  const fileName = `${store.main_domain ?? store.external_id}-${new Date().toISOString().slice(0, 10)}.zip`.replace(/[^A-Za-z0-9._-]/g, '-');
  await withTransaction(deps.pool, async (client) => {
    await client.query('INSERT INTO site_downloads (id, product_id, tenant_id, file_name) VALUES ($1, $2, $3, $4)', [id, store.product_id, store.id, fileName]);
    await enqueue(deps.boss, client, { type: 'tenant.download', tenantId: store.id, downloadId: id });
  });
  return (await describe(deps.provisioner, await newest(deps.pool, store.id)))!;
}

/** The tenant.download job: makes the copy. A repeat after it is Done does nothing. */
export async function makeDownload(pool: Pool, provisioner: Provisioner, tenantId: string, downloadId: string): Promise<void> {
  const { rows } = await pool.query('SELECT status FROM site_downloads WHERE id = $1', [downloadId]);
  if (rows[0]?.status !== Status.Pending) return;
  const { sizeBytes } = await provisioner.downloadStore({ storeId: tenantId, downloadId });
  await pool.query('UPDATE site_downloads SET status = $2, size_bytes = $3, date_done = now() WHERE id = $1', [downloadId, Status.Done, sizeBytes]);
}

export const failDownload = (pool: Pool, downloadId: string) =>
  pool.query('UPDATE site_downloads SET status = $2 WHERE id = $1 AND status = $3', [downloadId, Status.Failed, Status.Pending]);

/** Deletes copies older than DOWNLOAD_KEEP_DAYS, from storage and the table. Safe to re-run. */
export async function purgeExpiredDownloads(pool: Pool, provisioner: Provisioner): Promise<number> {
  const { rows } = await pool.query('SELECT id FROM site_downloads WHERE date_created < now() - make_interval(days => $1)', [DOWNLOAD_KEEP_DAYS]);
  for (const { id } of rows) {
    await provisioner.deleteDownload({ downloadId: id });
    await pool.query('DELETE FROM site_downloads WHERE id = $1', [id]);
  }
  return rows.length;
}

const STORE_SELECT = `SELECT t.id, t.product_id, t.external_id, t.status,
    (SELECT domain_name FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_main) AS main_domain
  FROM tenants t`;

/** GET and POST /admin/tenants/{id}/download, for anyone who may see the store (members only look). */
export function adminSiteDownloadRoutes(app: Hono<AppEnv>, deps: Deps) {
  const store = async (c: Context<AppEnv>) => {
    const id = c.req.param('id') ?? '';
    if (!isUuid(id)) throw notFound(`Tenant ${id} not found`);
    const { rows } = await deps.pool.query<Store>(`${STORE_SELECT} WHERE t.id = $1 AND ($2::uuid IS NULL OR t.product_id = $2)`, [id, scopedProduct(c)]);
    if (!rows[0]) throw notFound(`Tenant ${id} not found`);
    return rows[0];
  };
  app.get('/tenants/:id/download', async (c) => c.json({ download: await currentDownload(deps.pool, deps.provisioner, await store(c)) }));
  app.post('/tenants/:id/download', async (c) => c.json({ download: await startDownload(deps, await store(c)) }));
}

/**
 * POST /sites/download: a store's own wp-admin (AnyPress Client), signed with the store's site key. Body
 * {site: the store's domain, start?: true}. Answers {download} like the dashboard's route; `start` makes a new copy.
 */
export function siteDownloadRoutes(app: Hono<AppEnv>, deps: Deps) {
  const keyFor = siteKeys(deps.config.secretsKey);
  app.post(SITE_DOWNLOAD_ROUTE, async (c) => {
    const raw = await c.req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw badRequest('The body must be JSON');
    }
    const domain = typeof body.site === 'string' ? body.site.toLowerCase() : '';
    if (!domain) throw badRequest('site is required');
    const { rows } = await deps.pool.query<Store>(
      `${STORE_SELECT} WHERE t.id = (SELECT tenant_id FROM tenant_domains WHERE domain_name = $1 LIMIT 1)`,
      [domain],
    );
    const tenant = rows[0];
    if (!tenant || !verifySiteRequest(keyFor(tenant.id), c.req.header('X-AnyPress-Signature'), 'POST', SITE_DOWNLOAD_ROUTE, raw)) {
      throw new HttpError(403, 'This request is not signed by that website');
    }
    const download = body.start === true ? await startDownload(deps, tenant) : await currentDownload(deps.pool, deps.provisioner, tenant);
    return c.json({ download }, 200, { 'Cache-Control': 'no-store' });
  });
}

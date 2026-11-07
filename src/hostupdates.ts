import type { PgBoss } from 'pg-boss';
import { withTransaction, type Pool } from './db.ts';
import type { Size } from './plans.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import { enqueue } from './queue.ts';
import { channelKey, manifestKey, parseManifest, type PluginSlug, type ReleaseStore } from './releases.ts';
import { Status } from './status.ts';

/**
 * Every ready-made storefront on the latest AnyPress Host (docs/host-updates.md). Storefronts don't update the plugin
 * themselves (automatic updates are off, and WP-Cron may be), so the API pushes each stable release: every 15
 * minutes it reads the stable channel and queues a storefront.update-host job for each ready storefront that
 * hasn't been given that version. The job has the store's agent install the signed zip (Provisioner.updatePlugin),
 * which puts the old copy back if WordPress stops loading. A failure is kept on the storefront's host_updates row,
 * recorded in job_failures and emailed to the admins like any failed job, and is not tried again on its own; the
 * admin API's POST /admin/host-updates tries the failed ones again.
 */

export const HOST_UPDATE_QUEUE = 'host-updates';

/** The plugin pushed, and the folders older copies of it may still be in (before it was renamed). */
export const HOST_SLUG: PluginSlug = 'anypress-host';
export const OLD_HOST_SLUGS: string[] = ['wpcs-waas-host', 'waas-host'];

/** How long the package URL handed to a store works: the agent downloads it straight away. */
const PACKAGE_URL_TTL = 3600;

export interface HostUpdateDeps {
  pool: Pool;
  boss: PgBoss;
  releases?: ReleaseStore;
  /** The product whose stores are the ready-made storefronts (Config.storefrontProductId). */
  storefrontProductId?: string;
}

/**
 * Queues the stable release for every ready storefront not given it yet; with `retryFailed`, also for those where it
 * failed. Answers the release and how many were queued (version null when there is no release to push).
 */
export async function queueHostUpdates({ pool, boss, releases, storefrontProductId }: HostUpdateDeps, { retryFailed = false } = {}) {
  if (!releases || !storefrontProductId) return { version: null, queued: 0 };
  const manifest = parseManifest(await releases.getJson(channelKey(HOST_SLUG, 'stable')), HOST_SLUG);
  if (!manifest) return { version: null, queued: 0 };
  const queued = await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT t.id FROM tenants t LEFT JOIN host_updates h ON h.tenant_id = t.id
        WHERE t.product_id = $1 AND t.status = $2
          AND (h.tenant_id IS NULL OR h.version <> $3 OR (h.status = $4 AND $5))
          -- A storefront whose product is held at a release (a pin, /admin/products/{id}/plugins/{slug}/pin) stays there.
          AND NOT EXISTS (SELECT 1 FROM plugin_pins pp WHERE pp.slug = $6 AND t.external_id = 'storefront-' || pp.product_id::text)
        ORDER BY t.date_created, t.id
        FOR UPDATE OF t`,
      [storefrontProductId, Status.Done, manifest.version, Status.Failed, retryFailed, HOST_SLUG],
    );
    for (const { id } of rows) {
      await client.query(
        `INSERT INTO host_updates (tenant_id, version, status) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET version = EXCLUDED.version, status = EXCLUDED.status, error = NULL, date_changed = now()`,
        [id, manifest.version, Status.Pending],
      );
      await enqueue(boss, client, {
        type: 'storefront.update-host',
        tenantId: id,
        version: manifest.version,
      });
    }
    return rows.length;
  });
  return { version: manifest.version, queued };
}

/**
 * The storefront.update-host job: installs the release on the store and records what happened. Jobs for one store run
 * in the order they were queued, so a store's tenant.update that writes its renamed ANYPRESS_ constants (queued on
 * startup, src/constantnames.ts) always finishes before AnyPress Host, which reads only those, replaces the old copy.
 */
export async function pushHostUpdate(pool: Pool, provisioner: Provisioner, releases: ReleaseStore | undefined, tenantId: string, version: string) {
  const { rows } = await pool.query<{ size: Size }>(
    'SELECT t.size FROM host_updates h JOIN tenants t ON t.id = h.tenant_id WHERE h.tenant_id = $1 AND h.version = $2',
    [tenantId, version],
  );
  // Deleted, moved (which clears the row) or given a newer release since this was queued: nothing to do.
  if (!rows[0]) return;
  // The current store agent first: one from before a fix to its update-plugin would otherwise do the old thing.
  // A store already on the current setup costs two lookups (Provisioner.ensureStoreSetup).
  await provisioner.ensureStoreSetup({ storeId: tenantId, size: rows[0].size });
  if (!releases) throw new Error('Plugin releases are not configured (RELEASES_S3_BUCKET)');
  const manifest = parseManifest(await releases.getJson(manifestKey(HOST_SLUG, version)), HOST_SLUG, version);
  if (!manifest) throw new Error(`Release ${version} of ${HOST_SLUG} not found`);
  const { from } = await provisioner.updatePlugin({
    storeId: tenantId,
    slug: HOST_SLUG,
    version,
    url: await releases.presignGet(manifest.zip, PACKAGE_URL_TTL),
    sha256: manifest.sha256,
    replaces: OLD_HOST_SLUGS,
  });
  await pool.query('UPDATE host_updates SET status = $3, from_version = $4, error = NULL, date_changed = now() WHERE tenant_id = $1 AND version = $2', [
    tenantId,
    version,
    Status.Done,
    from,
  ]);
}

/** Keeps why the push failed on the storefront's row. */
export async function failHostUpdate(pool: Pool, tenantId: string, version: string, error: unknown) {
  await pool.query('UPDATE host_updates SET status = $3, error = $4, date_changed = now() WHERE tenant_id = $1 AND version = $2', [
    tenantId,
    version,
    Status.Failed,
    (error instanceof Error ? error.message : String(error)).slice(0, 2000),
  ]);
}

/** A store whose code was replaced (moved, restored, rolled back) has its template's copy again: push it once more. */
export async function forgetHostUpdate(pool: Pool, tenantId: string) {
  await pool.query('DELETE FROM host_updates WHERE tenant_id = $1', [tenantId]);
}

/** Every storefront's last push, for the admin API. */
export async function listHostUpdates(pool: Pool) {
  const { rows } = await pool.query(
    `SELECT h.tenant_id, t.name, h.version, h.from_version, h.status, h.error, h.date_changed
       FROM host_updates h JOIN tenants t ON t.id = h.tenant_id ORDER BY t.date_created, t.id`,
  );
  return rows.map((r) => ({
    tenantId: r.tenant_id as string,
    name: (r.name as string | null) ?? null,
    version: r.version as string,
    fromVersion: (r.from_version as string | null) ?? null,
    status: r.status === Status.Done ? 'done' : r.status === Status.Failed ? 'failed' : 'pending',
    error: (r.error as string | null) ?? null,
    dateChanged: (r.date_changed as Date).toISOString(),
  }));
}

/** Checks the stable channel every 15 minutes, when releases and the storefront product are set up. */
export async function startHostUpdates(deps: HostUpdateDeps): Promise<void> {
  const { boss } = deps;
  if (!deps.releases || !deps.storefrontProductId) {
    if (await boss.getQueue(HOST_UPDATE_QUEUE)) await boss.unschedule(HOST_UPDATE_QUEUE);
    return;
  }
  if (!(await boss.getQueue(HOST_UPDATE_QUEUE)))
    await boss.createQueue(HOST_UPDATE_QUEUE, {
      retryLimit: 0,
      expireInSeconds: 600,
    });
  await boss.schedule(HOST_UPDATE_QUEUE, '*/15 * * * *');
  await boss.work(HOST_UPDATE_QUEUE, { pollingIntervalSeconds: 60 }, async () => {
    const { version, queued } = await queueHostUpdates(deps);
    if (queued) console.log(`AnyPress Host ${version}: pushing to ${queued} storefront${queued === 1 ? '' : 's'}`);
  });
}

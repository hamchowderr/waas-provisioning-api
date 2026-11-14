import { withTransaction, type Pool } from './db.ts';
import type { PgBoss } from 'pg-boss';
import { enqueue } from './queue.ts';
import { Status } from './status.ts';

/**
 * Old store template versions and base snapshots, cleared out by the nightly maintenance so they don't pile up.
 * Every template release makes a new version of the store template product, and every storefront that follows it
 * gets a copy, so without this each product kept every version it ever had (70 on 2026-11-13, each with a stopped
 * Coolify service and its code in storage).
 *
 * Only versions the platform made are cleared: those of the template products (STORE_TEMPLATE_PRODUCT_ID,
 * STOREFRONT_PRODUCT_ID) and of products that follow another. A seller's own versions are theirs to keep. Kept:
 * the production version, the newest built version before it (the way back), any version a store is on or whose
 * snapshot a store started from, anything not yet a day old, and anything still building or being removed.
 */
const KEEP_BASE_SNAPSHOTS = 2;

/** Products whose versions and base snapshots the platform makes: the template products and every follower. */
const PLATFORM_PRODUCTS = `(p.id = ANY($1::uuid[]) OR p.follows_product_id IS NOT NULL)`;

export async function pruneOldVersions(pool: Pool, boss: PgBoss, templateProductIds: string[]): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT v.id FROM versions v JOIN products p ON p.id = v.product_id
      WHERE ${PLATFORM_PRODUCTS}
        AND NOT v.is_production
        AND v.status IN ($2, $3)
        AND v.date_created < now() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.version_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM snapshots s JOIN tenants t ON t.snapshot_id = s.id WHERE s.version_id = v.id)
        AND v.id <> coalesce((
          SELECT r.id FROM versions r
           WHERE r.product_id = v.product_id AND NOT r.is_production AND r.status = $2
             AND r.date_created < coalesce((SELECT max(pv.date_created) FROM versions pv WHERE pv.product_id = v.product_id AND pv.is_production), 'infinity')
           ORDER BY r.date_created DESC LIMIT 1), '00000000-0000-0000-0000-000000000000'::uuid)`,
    [templateProductIds, Status.Done, Status.Failed],
  );
  for (const { id } of rows) {
    await withTransaction(pool, async (client) => {
      await client.query('UPDATE versions SET status = $2, date_changed = now() WHERE id = $1', [id, Status.Removing]);
      await client.query('UPDATE snapshots SET status = $2 WHERE version_id = $1', [id, Status.Removing]);
      await enqueue(boss, client, { type: 'version.delete', versionId: id });
    });
  }
  return rows.map((r) => r.id);
}

/**
 * Base snapshots past the newest KEEP_BASE_SNAPSHOTS of each platform product. A version copies its base snapshot
 * when it is made, so nothing reads an old one again; one a version is still being built from is kept.
 */
export async function pruneOldBaseSnapshots(pool: Pool, boss: PgBoss, templateProductIds: string[]): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT b.id FROM (
        SELECT b.*, row_number() OVER (PARTITION BY b.product_id ORDER BY b.date_created DESC) AS n
          FROM base_snapshots b JOIN products p ON p.id = b.product_id
         WHERE ${PLATFORM_PRODUCTS}) b
      WHERE b.n > $2
        AND b.date_created < now() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.source_base_snapshot_id = b.id AND s.status = $3)`,
    [templateProductIds, KEEP_BASE_SNAPSHOTS, Status.Pending],
  );
  for (const { id } of rows) {
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM base_snapshots WHERE id = $1', [id]);
      await enqueue(boss, client, { type: 'basesnapshot.delete', baseSnapshotId: id });
    });
  }
  return rows.map((r) => r.id);
}

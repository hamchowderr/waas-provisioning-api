import type { PgBoss } from 'pg-boss';
import type { Client } from './db.ts';
import { enqueue } from './queue.ts';
import { Status } from './status.ts';

/**
 * Makes a built version its product's production version. Unless `moveStores` is false, every store of the product
 * on another version moves to it (a failed move puts the store back, src/jobs.ts). Answers how many move.
 *
 * A store that is busy (Pending) moves too: its jobs run one at a time, so the move waits for the job it is on.
 * Leaving it out left it on the old version for good (waas-api-lca1).
 */
export async function promoteVersion(client: Client, boss: PgBoss, productId: string, versionId: string, moveStores = true): Promise<number> {
  await client.query('UPDATE versions SET is_production = false, date_changed = now() WHERE product_id = $1 AND is_production', [productId]);
  await client.query('UPDATE versions SET is_production = true, promote_when_done = false, date_changed = now() WHERE id = $1', [versionId]);
  if (!moveStores) return 0;
  const { rows } = await client.query<{ id: string; version_id: string }>(
    `UPDATE tenants SET status = $3, date_changed = now()
      WHERE product_id = $1 AND status IN ($3, $4) AND version_id IS NOT NULL AND version_id <> $2
      RETURNING id, version_id`,
    [productId, versionId, Status.Pending, Status.Done],
  );
  for (const row of rows) {
    await enqueue(boss, client, { type: 'tenant.move', tenantId: row.id, targetVersionId: versionId, rollbackVersionId: row.version_id });
  }
  return rows.length;
}

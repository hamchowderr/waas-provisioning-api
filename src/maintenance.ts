import type { Pool } from './db.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import { Status } from './status.ts';

/**
 * Makes sure every live store runs its scheduled jobs on its own (Provisioner.ensureStoreCron).
 * Run on startup, so stores created before stores had a cron get one. One store failing does not
 * stop the others; it is logged and tried again on the next start.
 */
export async function ensureStoreCrons(pool: Pool, provisioner: Provisioner, log: Pick<Console, 'log' | 'error'> = console): Promise<void> {
  let ids: string[];
  try {
    ids = (await pool.query('SELECT id FROM tenants WHERE status = $1 ORDER BY date_created, id', [Status.Done])).rows.map((r) => r.id);
  } catch (err) {
    log.error(`Store cron check skipped: ${(err as Error).message}`);
    return;
  }
  for (const storeId of ids) {
    try {
      const result = await provisioner.ensureStoreCron({ storeId });
      if (result !== 'unchanged') log.log(`Store ${storeId}: cron task ${result}`);
    } catch (err) {
      log.error(`Store ${storeId}: cron task not ensured: ${(err as Error).message}`);
    }
  }
}

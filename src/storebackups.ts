import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { withTransaction, type Pool } from './db.ts';
import { selectExpired } from './dbbackup.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import type { JobData, JobHandlers } from './queue.ts';
import { Status } from './status.ts';

/**
 * Nightly backups of every live store (its files and database), on top of the manual and
 * suspend backups the contract already has. Each one is an ordinary tenant_backups row with
 * reason 'scheduled', taken by the same `tenant.backup` job and stored like any other backup
 * (Provisioner.backupStore; on Coolify, backups/<id>.zip in the S3 bucket). Retention keeps the
 * newest scheduled backup of each of a store's last `keepDaily` days and of each of its last
 * `keepWeekly` ISO weeks. Once a store is deleted, its backups follow BACKUP_RETENTION_DAYS
 * like the others. Runbook: docs/store-backups.md.
 */
export interface StoreBackupConfig {
  /** pg-boss cron (UTC). */
  schedule: string;
  keepDaily: number;
  keepWeekly: number;
}

/** The nightly run: prunes, then queues one backup per live store. */
export const STORE_BACKUPS_QUEUE = 'store-backups';
/**
 * The backups themselves, one store at a time, on their own queue so a night's backups never
 * hold up store creates and changes on the provision queue.
 */
export const STORE_BACKUP_QUEUE = 'store-backup';

/** A store with a scheduled backup newer than this is skipped, so a re-run never doubles up. */
const SKIP_IF_NEWER_THAN_HOURS = 20;
/** No scheduled backup run this long: queue one on startup (first deploy, or the API was down). */
const DUE_AFTER_HOURS = 26;

/** On unless STORE_BACKUP=off. Nightly at 09:00 UTC (early morning across the US). */
export function loadStoreBackupConfig(env: NodeJS.ProcessEnv): StoreBackupConfig | undefined {
  if (env.STORE_BACKUP === 'off') return undefined;
  return {
    schedule: env.STORE_BACKUP_SCHEDULE ?? '0 9 * * *',
    keepDaily: Number(env.STORE_BACKUP_KEEP_DAILY ?? 7),
    keepWeekly: Number(env.STORE_BACKUP_KEEP_WEEKLY ?? 4),
  };
}

/**
 * Deletes the scheduled backups of live stores that retention no longer keeps, and scheduled
 * backups that never finished once they are older than the daily window. Returns how many.
 */
export async function pruneScheduledBackups(pool: Pool, provisioner: Provisioner, config: Pick<StoreBackupConfig, 'keepDaily' | 'keepWeekly'>): Promise<number> {
  const { rows } = await pool.query<{ id: string; tenant_id: string; status: number; date_created: Date }>(
    "SELECT id, tenant_id, status, date_created FROM tenant_backups WHERE reason = 'scheduled' AND tenant_deleted_at IS NULL",
  );
  const done = new Map<string, { key: string; at: Date }[]>();
  const expired: string[] = [];
  const unfinishedCutoff = Date.now() - config.keepDaily * 86400_000;
  for (const b of rows) {
    if (b.status === Status.Done) {
      const list = done.get(b.tenant_id) ?? [];
      list.push({ key: b.id, at: b.date_created });
      done.set(b.tenant_id, list);
    } else if (b.date_created.getTime() < unfinishedCutoff) {
      expired.push(b.id);
    }
  }
  for (const list of done.values()) expired.push(...selectExpired(list, config.keepDaily, config.keepWeekly));
  for (const id of expired) {
    await provisioner.deleteBackup({ backupId: id });
    await pool.query('DELETE FROM tenant_backups WHERE id = $1', [id]);
  }
  return expired.length;
}

/**
 * Queues a scheduled backup of every live store (Done, not suspended: a suspended store doesn't
 * change, and got its own backup when it was suspended) that has none from the last 20 hours.
 * The row and its job are written in one transaction. Returns how many were queued.
 */
export async function queueScheduledBackups(pool: Pool, boss: PgBoss): Promise<number> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; tenant_id: string }>(
      `INSERT INTO tenant_backups (product_id, tenant_id, external_id, reason)
       SELECT t.product_id, t.id, t.external_id, 'scheduled' FROM tenants t
        WHERE t.status = $1 AND NOT t.is_suspended
          AND NOT EXISTS (SELECT 1 FROM tenant_backups b WHERE b.tenant_id = t.id AND b.reason = 'scheduled'
                            AND b.date_created > now() - make_interval(hours => $2))
        ORDER BY t.date_created, t.id
       RETURNING id, tenant_id`,
      [Status.Done, SKIP_IF_NEWER_THAN_HOURS],
    );
    for (const row of rows) {
      const data: JobData = { type: 'tenant.backup', tenantId: row.tenant_id, backupId: row.id };
      await boss.send(STORE_BACKUP_QUEUE, data, { db: { executeSql: (text, values) => client.query(text, values) } });
    }
    return rows.length;
  });
}

/** True when there are live stores and no scheduled backup was queued in the last 26 hours. */
export async function scheduledBackupsDue(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM tenants WHERE status = $1 AND NOT is_suspended)
        AND NOT EXISTS (SELECT 1 FROM tenant_backups WHERE reason = 'scheduled' AND date_created > now() - make_interval(hours => $2)) AS due`,
    [Status.Done, DUE_AFTER_HOURS],
  );
  return rows[0].due;
}

/**
 * Schedules the nightly run and works both queues; unschedules it when STORE_BACKUP=off. A backup
 * that still fails after its retry is recorded like any failed job (job_failures, the row
 * Failed) and does not stop the other stores. Also queues a run now when one is overdue.
 */
export async function startStoreBackups(
  boss: PgBoss,
  pool: Pool,
  provisioner: Provisioner,
  handlers: Pick<JobHandlers, 'run' | 'fail'>,
  config: StoreBackupConfig | undefined,
  { pollingIntervalSeconds = 60, retryDelaySeconds = 600, log = console }: { pollingIntervalSeconds?: number; retryDelaySeconds?: number; log?: Pick<Console, 'log' | 'error'> } = {},
): Promise<void> {
  if (!config) {
    if (await boss.getQueue(STORE_BACKUPS_QUEUE)) await boss.unschedule(STORE_BACKUPS_QUEUE);
    return;
  }
  if (!(await boss.getQueue(STORE_BACKUPS_QUEUE))) await boss.createQueue(STORE_BACKUPS_QUEUE, { retryLimit: 2, retryDelay: 300 });
  if (!(await boss.getQueue(STORE_BACKUP_QUEUE))) {
    await boss.createQueue(STORE_BACKUP_QUEUE, { retryLimit: 1, retryDelay: retryDelaySeconds, expireInSeconds: 3600, deleteAfterSeconds: 7 * 24 * 3600 });
  }
  await boss.schedule(STORE_BACKUPS_QUEUE, config.schedule);

  await boss.work(STORE_BACKUPS_QUEUE, { pollingIntervalSeconds }, async () => {
    try {
      const pruned = await pruneScheduledBackups(pool, provisioner, config);
      if (pruned) log.log(`store backups: pruned ${pruned}`);
    } catch (err) {
      // Tonight's backups matter more; pruning runs again tomorrow.
      log.error(`store backups: pruning failed: ${(err as Error).message}`);
    }
    const queued = await queueScheduledBackups(pool, boss);
    log.log(`store backups: queued ${queued}`);
  });

  await boss.work(STORE_BACKUP_QUEUE, { includeMetadata: true, pollingIntervalSeconds: Math.min(pollingIntervalSeconds, 5) }, async ([job]: JobWithMetadata<JobData>[]) => {
    if (!job) return;
    try {
      await handlers.run(job.data);
    } catch (err) {
      if (job.retryCount < job.retryLimit) throw err;
      log.error(`store backup ${job.id} failed:`, err);
      await handlers.fail(job.data, err, { id: job.id, attempts: job.retryCount + 1 });
    }
  });

  if (await scheduledBackupsDue(pool)) await boss.send(STORE_BACKUPS_QUEUE, {}, { singletonKey: 'catch-up', singletonSeconds: 3600 });
}

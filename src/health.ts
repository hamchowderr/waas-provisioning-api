import type { PgBoss } from 'pg-boss';
import type { Pool } from './db.ts';
import { dbBackupStatus, type DbBackupStatus } from './dbbackup.ts';
import { QUEUE } from './queue.ts';

export interface Health {
  ok: boolean;
  database: 'ok' | 'down';
  queue: 'ok' | 'down';
  /** Informational: a failed or stale backup does not make `ok` false. */
  dbBackup: DbBackupStatus;
  /**
   * Informational, like dbBackup: store and version jobs that failed their last retry in the last
   * 24 hours and haven't been retried. `ok` is false while there are any, for an outside monitor
   * to alert on (docs/self-hosting.md#monitoring).
   */
  jobs: { ok: boolean; failedLastDay: number };
}

async function check(fn: () => Promise<unknown>): Promise<'ok' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), 3000)))]);
    return 'ok';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

const UNKNOWN: DbBackupStatus = { status: 'unknown', lastAttemptAt: null, lastSuccessAt: null, sizeBytes: null, stale: false };

/** Postgres and the job queue, each given 3 seconds to answer, plus the last database backup and failed jobs. */
export async function checkHealth(pool: Pool, boss: PgBoss, dbBackupEnabled = false): Promise<Health> {
  let dbBackup = UNKNOWN;
  let failedLastDay = 0;
  const [database, queue] = await Promise.all([
    check(() => pool.query('SELECT 1')),
    check(async () => {
      if (!(await boss.getQueue(QUEUE))) throw new Error('queue missing');
    }),
    check(async () => (dbBackup = await dbBackupStatus(pool, dbBackupEnabled))),
    check(async () => {
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM job_failures WHERE status = 'failed' AND failed_at > now() - interval '24 hours'");
      failedLastDay = rows[0].n;
    }),
  ]);
  return { ok: database === 'ok' && queue === 'ok', database, queue, dbBackup, jobs: { ok: failedLastDay === 0, failedLastDay } };
}

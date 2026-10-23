import type { PgBoss } from 'pg-boss';
import { sendRestoreTestFailed, type AuthMail } from './authmail.ts';
import type { Pool } from './db.ts';
import { isSize, DEFAULT_SIZE } from './plans.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import { Status } from './status.ts';

/**
 * The nightly restore test: proof that the nightly store backups (src/storebackups.ts) can actually
 * be restored. Each night, after the backups, one live store's newest nightly backup is restored into
 * a throwaway test store (Provisioner.testRestore), checked, and deleted. The store tested longest
 * ago goes next, so every store gets its turn. The real store is never touched, and the test store
 * never serves visitors, sends email or runs cron. A failed test is emailed to the admins
 * (JOB_ALERT_EMAILS) and shows on /health as restoreTest.ok false. Runbook: docs/store-backups.md.
 */
export interface RestoreTestConfig {
  /** pg-boss cron (UTC). */
  schedule: string;
}

export const RESTORE_TEST_QUEUE = 'restore-test';

/** Only a nightly backup this recent is tested: an older one says the backups themselves stopped. */
const BACKUP_MAX_AGE_HOURS = 48;
/** /health reports the test stale when nothing passed for this long (two nights and some). */
const STALE_AFTER_HOURS = 50;
/** A test still "running" after this long was cut off (the API restarted); it counts as failed. */
const INTERRUPTED_AFTER_HOURS = 3;
/** No test started this long: queue one on startup (first deploy, or the API was down at night). */
const DUE_AFTER_HOURS = 26;

/** On unless RESTORE_TEST=off. Nightly at 11:00 UTC, two hours after the store backups. */
export function loadRestoreTestConfig(env: NodeJS.ProcessEnv): RestoreTestConfig | undefined {
  if (env.RESTORE_TEST === 'off') return undefined;
  return { schedule: env.RESTORE_TEST_SCHEDULE ?? '0 11 * * *' };
}

export interface RestoreTestAlerts {
  mail?: AuthMail;
  to?: string[];
}

export interface RestoreTestOutcome {
  id: string;
  tenantId: string;
  backupId: string;
  status: 'passed' | 'failed';
  error?: string;
}

/**
 * Marks tests cut off mid-way as failed and deletes any test store they left. Returns how many.
 */
export async function cleanUpInterruptedTests(pool: Pool, provisioner: Provisioner): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE restore_tests SET status = 'failed', error = 'The test was cut off (the API restarted) before it finished', finished_at = now()
      WHERE status = 'running' AND started_at < now() - make_interval(hours => $1) RETURNING id`,
    [INTERRUPTED_AFTER_HOURS],
  );
  for (const { id } of rows) await provisioner.deleteRestoreTest({ testId: id });
  return rows.length;
}

/**
 * Tests one store: the live store (Done, not suspended) with a finished nightly backup from the last
 * 48 hours that was tested longest ago (never tested first). Records the result and emails the
 * admins on a failure. Undefined when no store has such a backup.
 */
export async function runRestoreTest(
  pool: Pool,
  provisioner: Provisioner,
  alerts: RestoreTestAlerts = {},
  fetchFn: typeof fetch = fetch,
): Promise<RestoreTestOutcome | undefined> {
  const { rows } = await pool.query<{ tenant_id: string; name: string; version_id: string; size: string; backup_id: string; backup_at: Date }>(
    `SELECT t.id AS tenant_id, t.name, t.version_id, t.size, b.id AS backup_id, b.date_created AS backup_at
       FROM tenants t
       JOIN LATERAL (SELECT id, date_created FROM tenant_backups
                      WHERE tenant_id = t.id AND reason = 'scheduled' AND status = $1 AND date_created > now() - make_interval(hours => $2)
                      ORDER BY date_created DESC LIMIT 1) b ON true
      WHERE t.status = $1 AND NOT t.is_suspended
      ORDER BY (SELECT max(r.started_at) FROM restore_tests r WHERE r.tenant_id = t.id) ASC NULLS FIRST, t.date_created, t.id
      LIMIT 1`,
    [Status.Done, BACKUP_MAX_AGE_HOURS],
  );
  const pick = rows[0];
  if (!pick) return undefined;
  const { rows: started } = await pool.query<{ id: string }>('INSERT INTO restore_tests (tenant_id, backup_id) VALUES ($1, $2) RETURNING id', [
    pick.tenant_id,
    pick.backup_id,
  ]);
  const id = started[0]!.id;
  const outcome: RestoreTestOutcome = { id, tenantId: pick.tenant_id, backupId: pick.backup_id, status: 'passed' };
  try {
    const found = await provisioner.testRestore({
      testId: id,
      backupId: pick.backup_id,
      versionId: pick.version_id,
      size: isSize(pick.size) ? pick.size : DEFAULT_SIZE,
    });
    if (found.tables === 0) throw new Error('The restored database has no tables');
    await pool.query("UPDATE restore_tests SET status = 'passed', details = $2, finished_at = now() WHERE id = $1", [id, found]);
  } catch (err) {
    outcome.status = 'failed';
    outcome.error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    await pool.query("UPDATE restore_tests SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [id, outcome.error]);
    if (alerts.mail) {
      for (const address of alerts.to ?? []) {
        try {
          await sendRestoreTestFailed(alerts.mail, address, { store: pick.name, backupAt: pick.backup_at, error: outcome.error }, fetchFn);
        } catch (mailErr) {
          console.error(`restore test ${id}: alert to ${address} not sent: ${(mailErr as Error).message}`);
        }
      }
    }
  }
  return outcome;
}

export interface RestoreTestStatus {
  /** False when the last test failed, or tests are on and none passed in about two days while there are live stores. */
  ok: boolean;
  status: 'off' | 'never' | 'running' | 'passed' | 'failed';
  lastPassedAt: string | null;
}

/** For /health. */
export async function restoreTestStatus(pool: Pool, enabled: boolean): Promise<RestoreTestStatus> {
  const { rows } = await pool.query<{ status: RestoreTestStatus['status'] | null; last_passed: Date | null; stale: boolean }>(
    `SELECT (SELECT status FROM restore_tests ORDER BY started_at DESC LIMIT 1) AS status,
            (SELECT max(finished_at) FROM restore_tests WHERE status = 'passed') AS last_passed,
            EXISTS (SELECT 1 FROM tenants WHERE status = $1 AND NOT is_suspended)
              AND NOT EXISTS (SELECT 1 FROM restore_tests WHERE status = 'passed' AND finished_at > now() - make_interval(hours => $2)) AS stale`,
    [Status.Done, STALE_AFTER_HOURS],
  );
  const row = rows[0]!;
  const lastPassedAt = row.last_passed?.toISOString() ?? null;
  if (!enabled) return { ok: true, status: 'off', lastPassedAt };
  if (!row.status) return { ok: true, status: 'never', lastPassedAt };
  return { ok: row.status !== 'failed' && (row.status === 'running' || !row.stale), status: row.status, lastPassedAt };
}

/** True when there are live stores and no test started in the last 26 hours. */
async function restoreTestDue(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM tenants WHERE status = $1 AND NOT is_suspended)
        AND NOT EXISTS (SELECT 1 FROM restore_tests WHERE started_at > now() - make_interval(hours => $2)) AS due`,
    [Status.Done, DUE_AFTER_HOURS],
  );
  return rows[0].due;
}

/**
 * Schedules the nightly test and works its queue; unschedules it when RESTORE_TEST=off. A test is
 * not retried: a failure is the finding, and the next night tests again. Also queues a test now when
 * one is overdue.
 */
export async function startRestoreTests(
  boss: PgBoss,
  pool: Pool,
  provisioner: Provisioner,
  config: RestoreTestConfig | undefined,
  alerts: RestoreTestAlerts = {},
  { pollingIntervalSeconds = 60, log = console }: { pollingIntervalSeconds?: number; log?: Pick<Console, 'log' | 'error'> } = {},
): Promise<void> {
  if (!config) {
    if (await boss.getQueue(RESTORE_TEST_QUEUE)) await boss.unschedule(RESTORE_TEST_QUEUE);
    return;
  }
  // A big store's restore can take a while; three hours before pg-boss gives up on it.
  if (!(await boss.getQueue(RESTORE_TEST_QUEUE))) await boss.createQueue(RESTORE_TEST_QUEUE, { retryLimit: 0, expireInSeconds: 3 * 3600, deleteAfterSeconds: 7 * 24 * 3600 });
  await boss.schedule(RESTORE_TEST_QUEUE, config.schedule);

  await boss.work(RESTORE_TEST_QUEUE, { pollingIntervalSeconds }, async () => {
    try {
      const cleaned = await cleanUpInterruptedTests(pool, provisioner);
      if (cleaned) log.log(`restore test: cleaned up ${cleaned} interrupted`);
    } catch (err) {
      log.error(`restore test: cleanup failed: ${(err as Error).message}`);
    }
    const outcome = await runRestoreTest(pool, provisioner, alerts);
    if (!outcome) log.log('restore test: no store has a recent nightly backup');
    else if (outcome.status === 'passed') log.log(`restore test ${outcome.id}: passed (store ${outcome.tenantId}, backup ${outcome.backupId})`);
    else log.error(`restore test ${outcome.id}: failed (store ${outcome.tenantId}, backup ${outcome.backupId}): ${outcome.error}`);
  });

  if (await restoreTestDue(pool)) await boss.send(RESTORE_TEST_QUEUE, {}, { singletonKey: 'catch-up', singletonSeconds: 3600 });
}

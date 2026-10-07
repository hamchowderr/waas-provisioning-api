import { PgBoss, type JobWithMetadata } from 'pg-boss';
import type { Client } from './db.ts';

/**
 * Slow store-side work runs as pg-boss jobs in the API's own Postgres database.
 *
 * One queue with the key_strict_fifo policy: jobs that share a singletonKey (one version, or one
 * tenant) run one at a time in arrival order, so a delete waits for the build before it.
 * Jobs with different keys run independently.
 */
export const QUEUE = 'provision';

export type JobData =
  | { type: 'version.create'; versionId: string; source: { snapshotId: string } | { baseSnapshotId: string } | { upload: true } }
  | { type: 'version.delete'; versionId: string }
  /** Deletes a template's archive; the row is already gone. */
  | { type: 'basesnapshot.delete'; baseSnapshotId: string }
  | {
      type: 'tenant.create';
      tenantId: string;
      /** The store's first WordPress user. The password is encrypted (src/secrets.ts). */
      user?: { name: string; email: string; role: string; encryptedPassword?: string };
    }
  | { type: 'tenant.update'; tenantId: string; wpOptions?: Record<string, string>; phpConstantNames?: string[] }
  | { type: 'tenant.move'; tenantId: string; targetVersionId: string }
  /** Applies the tenant's current domains from the database (main + redirects). */
  | { type: 'tenant.domains'; tenantId: string }
  | { type: 'tenant.delete'; tenantId: string }
  /** Backs up first when backupId is set, then takes the store offline. */
  | { type: 'tenant.suspend'; tenantId: string; backupId?: string }
  | { type: 'tenant.resume'; tenantId: string }
  | { type: 'tenant.backup'; tenantId: string; backupId: string }
  /** Re-creates a deleted tenant (already re-inserted by the request) from a kept backup. */
  | { type: 'tenant.restore'; tenantId: string; backupId: string };

/** Daily housekeeping (purging expired backups), on its own queue so it never waits behind store work. */
export const MAINTENANCE_QUEUE = 'maintenance';

function singletonKey(data: JobData): string {
  if ('baseSnapshotId' in data) return `basesnapshot:${data.baseSnapshotId}`;
  return 'versionId' in data ? `version:${data.versionId}` : `tenant:${data.tenantId}`;
}

export async function startBoss(databaseUrl: string, { retryDelaySeconds = 10 } = {}): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  boss.on('error', (err) => console.error('pg-boss:', err));
  await boss.start();
  if (!(await boss.getQueue(QUEUE))) {
    await boss.createQueue(QUEUE, {
      policy: 'key_strict_fifo',
      retryLimit: 3,
      retryDelay: retryDelaySeconds,
      retryBackoff: true,
      expireInSeconds: 3600,
      deleteAfterSeconds: 7 * 24 * 3600,
    });
  }
  if (!(await boss.getQueue(MAINTENANCE_QUEUE))) await boss.createQueue(MAINTENANCE_QUEUE, { retryLimit: 2 });
  await boss.schedule(MAINTENANCE_QUEUE, '17 3 * * *');
  return boss;
}

/** Queues a job inside the caller's transaction, so the job exists only if the row change commits. */
export async function enqueue(boss: PgBoss, client: Client, data: JobData): Promise<string | null> {
  return boss.send(QUEUE, data, {
    singletonKey: singletonKey(data),
    db: { executeSql: (text, values) => client.query(text, values) },
  });
}

export interface JobHandlers {
  run(data: JobData): Promise<void>;
  /** Called once retries are used up. Records the Failed status and the failure itself. */
  fail(data: JobData, error: unknown, job: { id: string; attempts: number }): Promise<void>;
  maintenance(): Promise<void>;
}

export async function startWorker(boss: PgBoss, handlers: JobHandlers, pollingIntervalSeconds = 2): Promise<string> {
  await boss.work(MAINTENANCE_QUEUE, { pollingIntervalSeconds: 60 }, () => handlers.maintenance());
  return boss.work(QUEUE, { includeMetadata: true, pollingIntervalSeconds }, async ([job]: JobWithMetadata<JobData>[]) => {
    if (!job) return;
    try {
      await handlers.run(job.data);
    } catch (err) {
      if (job.retryCount < job.retryLimit) throw err;
      // Last attempt: record Failed and complete the job. A failed job would hold back every
      // later job with the same key until someone retries or deletes it.
      console.error(`job ${job.id} (${job.data.type}) failed:`, err);
      await handlers.fail(job.data, err, { id: job.id, attempts: job.retryCount + 1 });
    }
  });
}

import { PgBoss, type JobWithMetadata, type Queue } from 'pg-boss';
import type { Client } from './db.ts';
import type { Size } from './plans.ts';

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
      /** Email the user that their website is ready, with a link to set their password, once it is built. */
      notifyOwner?: boolean;
    }
  /** `size`: the store's size changed; the job applies the size on record. */
  | { type: 'tenant.update'; tenantId: string; wpOptions?: Record<string, string>; phpConstantNames?: string[]; size?: Size }
  /**
   * `rollbackVersionId`: the version the store was on, when the move was started for it (a new production version,
   * src/routes/versions.ts). If the move fails its last retry, the store goes back to that version.
   */
  | { type: 'tenant.move'; tenantId: string; targetVersionId: string; rollbackVersionId?: string }
  /** Applies the tenant's current domains from the database (main + redirects). */
  | { type: 'tenant.domains'; tenantId: string }
  | { type: 'tenant.delete'; tenantId: string; /** Delete its backups too, instead of keeping them (test stores). */ dropBackups?: boolean }
  /** Backs up first when backupId is set, then takes the store offline. */
  | { type: 'tenant.suspend'; tenantId: string; backupId?: string }
  | { type: 'tenant.resume'; tenantId: string }
  /** Ends the hold of a site moved in (src/imports.ts): its cron, email and indexing start. */
  | { type: 'tenant.go-live'; tenantId: string }
  | { type: 'tenant.backup'; tenantId: string; backupId: string }
  /** "Download my site" (src/sitedownloads.ts): a copy of the whole store for its owner. */
  | { type: 'tenant.download'; tenantId: string; downloadId: string }
  /** Tells the store how many pack emails it has bought in all (tenant_email_packs, read when the job runs). */
  | { type: 'tenant.email-packs'; tenantId: string }
  /** Tells the store the storage its storage packs add (tenants.storage_packs, read when the job runs). */
  | { type: 'tenant.storage-packs'; tenantId: string }
  /** Re-creates a deleted tenant (already re-inserted by the request) from a kept backup. */
  | { type: 'tenant.restore'; tenantId: string; backupId: string }
  /**
   * Rolls a live tenant back to one of its backups in place. Backs up what it holds now first when
   * safetyBackupId is set, so the rollback can be undone.
   */
  | { type: 'tenant.rollback'; tenantId: string; backupId: string; safetyBackupId?: string }
  /** A ready-made storefront given this AnyPress Host release (src/hostupdates.ts). */
  | { type: 'storefront.update-host'; tenantId: string; version: string }
  /** Prospect finder results into the storefront's FluentCRM (src/prospectcrm.ts). */
  | { type: 'storefront.crm-prospects'; tenantId: string; productId: string }
  /** Prospect finder results into the FluentCRM of a storefront on its own website, through its AnyPress Host (src/prospectcrm.ts). */
  | { type: 'storefront.crm-prospects-host'; productId: string }
  /** The seller's own mailbox for prospect emails onto the storefront, or off it (src/outreach.ts). */
  | { type: 'storefront.outreach-mailbox'; tenantId: string; productId: string }
  /** Sales Kit outreach plans into the storefront's FluentCRM as draft automations (src/outreachautomation.ts). */
  | { type: 'storefront.outreach-automation'; tenantId: string; productId: string };

/** Daily housekeeping (purging expired backups), on its own queue so it never waits behind store work. */
export const MAINTENANCE_QUEUE = 'maintenance';

function singletonKey(data: JobData): string {
  if ('baseSnapshotId' in data) return `basesnapshot:${data.baseSnapshotId}`;
  if (data.type === 'storefront.crm-prospects-host') return `product:${data.productId}`;
  return 'versionId' in data ? `version:${data.versionId}` : `tenant:${data.tenantId}`;
}

/**
 * How often a running job must check in. The worker does it on its own (every half of this); when
 * the API stops mid-job (a redeploy, a crash) the check-ins stop, and pg-boss's supervisor (every
 * minute) hands the job back for its next try. Without it the job sat "active", and its store
 * Pending, until expireInSeconds ran out an hour later.
 */
export const HEARTBEAT_SECONDS = 60;

/**
 * How long a worker on a notify queue (ensureQueue) waits between checks when nothing woke it. pg-boss's
 * LISTEN/NOTIFY wakes workers the moment a job is sent, so this check is what picks up a retry once its
 * delay is over (a retry sends no notification) and covers a missed notification. Before NOTIFY, every
 * worker checked every 2 seconds.
 */
export const NOTIFY_POLL_SECONDS = 10;

/** Store and version jobs run side by side, up to this many at once (different stores only). */
const PROVISION_WORKERS = 2;

/**
 * Creates a queue, or brings an existing one up to date. Every queue is a notify queue: sending a job
 * wakes its workers at once through Postgres NOTIFY, instead of each worker checking the table every
 * few seconds all day. `heartbeatSeconds` can be changed on an existing queue too; the other options
 * stay as the queue was made.
 */
export async function ensureQueue(boss: PgBoss, name: string, options: Omit<Queue, 'name'> = {}): Promise<void> {
  const queue = await boss.getQueue(name);
  if (!queue) {
    await boss.createQueue(name, { ...options, notify: true });
    return;
  }
  const changes: { notify?: boolean; heartbeatSeconds?: number } = {};
  if (!queue.notify) changes.notify = true;
  if (options.heartbeatSeconds !== undefined && queue.heartbeatSeconds !== options.heartbeatSeconds) changes.heartbeatSeconds = options.heartbeatSeconds;
  if (Object.keys(changes).length) await boss.updateQueue(name, changes as Parameters<PgBoss['updateQueue']>[1]);
}

export async function startBoss(databaseUrl: string, { retryDelaySeconds = 10 } = {}): Promise<PgBoss> {
  // useListenNotify: one connection listens for new jobs, so workers start them at once (ensureQueue).
  const boss = new PgBoss({
    connectionString: databaseUrl, schema: 'pgboss', application_name: 'waas-api-jobs', useListenNotify: true,
    // Kept 30 days in pgboss.warning, for looking back after a slow day.
    persistWarnings: true,
    warningRetentionDays: 30,
  });
  boss.on('error', (err) => console.error('pg-boss:', err));
  // pg-boss's own checks: slow queries, a backlog, index bloat, vacuum falling behind, a lost listener.
  boss.on('warning', (warning) => console.warn(`pg-boss warning: ${warning.message}`, JSON.stringify(warning.data)));
  await boss.start();
  await ensureQueue(boss, QUEUE, {
    policy: 'key_strict_fifo',
    retryLimit: 3,
    retryDelay: retryDelaySeconds,
    retryBackoff: true,
    expireInSeconds: 3600,
    deleteAfterSeconds: 7 * 24 * 3600,
    heartbeatSeconds: HEARTBEAT_SECONDS,
  });
  await ensureQueue(boss, MAINTENANCE_QUEUE, { retryLimit: 2 });
  await boss.schedule(MAINTENANCE_QUEUE, '17 3 * * *');
  return boss;
}

/** Jobs that leave a store Done when they finish (or Removing, for a delete). */
const STATUS_JOBS = new Set<JobData['type']>([
  'tenant.create', 'tenant.update', 'tenant.move', 'tenant.domains', 'tenant.delete', 'tenant.suspend', 'tenant.resume',
  'tenant.go-live', 'tenant.restore', 'tenant.rollback',
]);

/**
 * Whether a job that changes the store's status is still waiting behind the one running now. Read inside the
 * caller's transaction, after it has locked the store's row.
 */
export async function storeJobWaiting(boss: PgBoss, client: Client, tenantId: string): Promise<boolean> {
  const waiting = await boss.findJobs<JobData>(QUEUE, {
    key: `tenant:${tenantId}`,
    queued: true,
    db: { executeSql: (text, values) => client.query(text, values) },
  });
  return waiting.some((job) => STATUS_JOBS.has(job.data.type));
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

export async function startWorker(
  boss: PgBoss,
  handlers: JobHandlers,
  pollingIntervalSeconds = 2,
  notifyPollingIntervalSeconds = NOTIFY_POLL_SECONDS,
): Promise<string> {
  await boss.work(MAINTENANCE_QUEUE, { pollingIntervalSeconds: 60 }, () => handlers.maintenance());
  // Two workers: a long store build doesn't hold up another store's quick change. Jobs for the same
  // store or version still run one at a time, in order (key_strict_fifo).
  return boss.work(QUEUE, { includeMetadata: true, pollingIntervalSeconds, notifyPollingIntervalSeconds, localConcurrency: PROVISION_WORKERS }, async ([job]: JobWithMetadata<JobData>[]) => {
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

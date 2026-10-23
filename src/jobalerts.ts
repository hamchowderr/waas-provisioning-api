import { sendJobFailureNotice, type AuthMail } from './authmail.ts';
import type { Pool } from './db.ts';
import type { JobData, JobHandlers } from './queue.ts';

/**
 * Emails the platform admins (JOB_ALERT_EMAILS, else APPLICATION_NOTIFY_EMAILS) when a store or
 * version job fails its last retry, so a paid store that never got built doesn't go unnoticed.
 * /health also counts the last day's failures (src/health.ts) for an outside monitor. An email
 * problem never changes the job's outcome.
 */

export interface JobAlertConfig {
  mail?: AuthMail;
  to?: string[];
  /** The dashboard's address (AUTH_URL), for a link to its Jobs page. */
  dashboardUrl?: string;
}

/** What the failed job was doing, in words: "Build the store Acme (acme.anypress.site)". */
export async function describeJob(pool: Pool, data: JobData): Promise<string> {
  const verb = VERBS[data.type] ?? data.type;
  if ('tenantId' in data) {
    const { rows } = await pool.query(
      `SELECT t.name, (SELECT d.domain_name FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_main) AS domain
         FROM tenants t WHERE t.id = $1`,
      [data.tenantId],
    );
    const t = rows[0] as { name: string | null; domain: string | null } | undefined;
    if (!t) return `${verb} the store ${data.tenantId}`;
    return `${verb} the store ${t.name ?? data.tenantId}${t.domain ? ` (${t.domain})` : ''}`;
  }
  if ('versionId' in data) {
    const { rows } = await pool.query('SELECT v.name, p.name AS product FROM versions v JOIN products p ON p.id = v.product_id WHERE v.id = $1', [data.versionId]);
    const v = rows[0] as { name: string; product: string } | undefined;
    return v ? `${verb} the version ${v.name} of ${v.product}` : `${verb} the version ${data.versionId}`;
  }
  return `${verb} the template ${data.baseSnapshotId}`;
}

const VERBS: Record<JobData['type'], string> = {
  'version.create': 'Build',
  'version.delete': 'Delete',
  'basesnapshot.delete': 'Delete',
  'tenant.create': 'Build',
  'tenant.update': 'Update',
  'tenant.move': 'Change the version of',
  'tenant.domains': 'Change the domains of',
  'tenant.delete': 'Delete',
  'tenant.suspend': 'Suspend',
  'tenant.resume': 'Resume',
  'tenant.backup': 'Back up',
  'tenant.email-packs': 'Update the email packs of',
  'tenant.restore': 'Restore',
  'tenant.rollback': 'Roll back',
};

/** Wraps the job handlers so each job that fails its last retry is emailed to the admins. */
export function withFailureAlerts<H extends JobHandlers>(handlers: H, pool: Pool, config: JobAlertConfig, fetchFn: typeof fetch = fetch): H {
  const { mail, to = [] } = config;
  if (!mail || !to.length) return handlers;
  return {
    ...handlers,
    async fail(data: JobData, error: unknown, job: { id: string; attempts: number }) {
      await handlers.fail(data, error, job);
      try {
        const what = await describeJob(pool, data);
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
        const url = config.dashboardUrl ? `${config.dashboardUrl.replace(/\/+$/, '')}/jobs?state=failed` : undefined;
        for (const address of to) await sendJobFailureNotice(mail, address, { what, error: message, attempts: job.attempts, url }, fetchFn);
      } catch (err) {
        console.error(`job ${job.id} failure alert not sent: ${(err as Error).message}`);
      }
    },
  };
}

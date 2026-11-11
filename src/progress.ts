import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from './db.ts';

/**
 * What a store's running job is doing now, for the dashboard's progress bar (tenants.progress). The provisioner
 * names each step as it starts it (step()); the job says which steps it expects (its plan), so the dashboard can
 * show "Step 3 of 6". A step the job doesn't plan for is skipped over, and one that doesn't happen (an imported
 * site's check, say, on a store made from a template) is left out of the plan.
 */
export type StepKey =
  | 'server'
  | 'version'
  | 'settings'
  | 'domains'
  | 'start'
  | 'backup'
  | 'restore'
  | 'database'
  | 'code'
  | 'configure'
  | 'check'
  | 'mail'
  | 'remove'
  | 'keep';

/** Plain words: the owner and their customers read these. */
const STEP_LABELS: Record<StepKey, string> = {
  server: 'Making room for the site',
  version: 'Switching to the new version',
  settings: 'Saving the new settings',
  domains: 'Updating the web address',
  start: 'Starting the website',
  backup: 'Saving a backup',
  restore: 'Copying the site in',
  database: 'Updating WordPress',
  code: 'Adding the theme and plugins',
  configure: "Putting in the site's settings",
  check: 'Checking the site works',
  mail: 'Turning off its email',
  remove: 'Removing the website and its files',
  keep: 'Keeping its backups in case you want it back',
};

export type Progress = {
  job: string;
  step: StepKey;
  label: string;
  /** 1-based place of the step in the plan. */
  index: number;
  total: number;
  /** Every step of the job in plain words, in order, for a checklist beside the bar. */
  steps: string[];
  startedAt: string;
  stepStartedAt: string;
  /** Set when the job stopped at this step. A retry starts the progress again. */
  failedAt?: string;
};

type Reporter = (key: StepKey) => void;
const current = new AsyncLocalStorage<Reporter>();

/** Called by the provisioner as each step starts. Does nothing outside a job that tracks its progress. */
export function step(key: StepKey): void {
  current.getStore()?.(key);
}

/**
 * Runs a store job, keeping tenants.progress on its current step. Each write is one small UPDATE and never fails
 * the job. On success the progress is cleared (the store's status says Done); on failure it is kept, so the
 * dashboard can say which step stopped (failedAt). A job with no plan clears what an earlier job left.
 */
export async function withProgress<T>(pool: Pool, tenantId: string, job: string, plan: StepKey[], run: () => Promise<T>): Promise<T> {
  const write = (progress: Progress | null) =>
    pool.query('UPDATE tenants SET progress = $2 WHERE id = $1', [tenantId, progress]).then(
      () => undefined,
      (err: unknown) => console.error(`store ${tenantId}: progress not saved: ${(err as Error).message}`),
    );
  if (plan.length === 0) {
    await write(null);
    return run();
  }
  const startedAt = new Date().toISOString();
  let index = 0;
  let last: Progress | undefined;
  // Writes go one after another, so a quick step can't land after the next one.
  let chain: Promise<void> = Promise.resolve();
  const report = (key: StepKey) => {
    // Only forward: the same step again (a retried command) or one already passed changes nothing.
    const at = plan.indexOf(key, index);
    if (at < 0) return;
    index = at + 1;
    const progress: Progress = { job, step: key, label: STEP_LABELS[key], index, total: plan.length, steps: plan.map((k) => STEP_LABELS[k]), startedAt, stepStartedAt: new Date().toISOString() };
    last = progress;
    chain = chain.then(() => write(progress));
  };
  report(plan[0]!);
  let result: T;
  try {
    result = await current.run(report, run);
  } catch (err) {
    await chain;
    if (last) await write({ ...last, failedAt: new Date().toISOString() });
    throw err;
  }
  await chain;
  await write(null);
  return result;
}

/** The steps each store job goes through, in order. */
export function planFor(job: string, opts: { imported?: boolean; safetyBackup?: boolean } = {}): StepKey[] {
  switch (job) {
    case 'tenant.create':
      return opts.imported
        ? ['server', 'start', 'restore', 'database', 'code', 'configure', 'check']
        : ['server', 'start', 'restore', 'code', 'configure'];
    case 'tenant.restore':
      return ['server', 'start', 'restore', 'code', 'configure'];
    case 'tenant.rollback':
      return [...(opts.safetyBackup ? (['backup'] as StepKey[]) : []), 'restore', 'code', 'database', 'configure'];
    case 'tenant.move':
      return ['version', 'start', 'code', 'database'];
    case 'tenant.domains':
      return ['domains', 'start', 'configure'];
    case 'tenant.update':
      return ['settings', 'start', 'configure'];
    case 'tenant.backup':
    case 'tenant.download':
      return ['backup'];
    case 'tenant.delete':
      return ['mail', 'remove', 'keep'];
    case 'tenant.suspend':
      return opts.safetyBackup ? ['backup'] : [];
    default:
      return [];
  }
}

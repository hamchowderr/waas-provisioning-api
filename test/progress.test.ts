import { describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.ts';
import { planFor, step, withProgress, type Progress } from '../src/progress.ts';

/** Records each progress the job writes. */
function recorder() {
  const writes: (Progress | null)[] = [];
  const pool = { query: async (_sql: string, params: unknown[]) => void writes.push(params[1] as Progress | null) } as unknown as Pool;
  return { pool, writes };
}

describe('job progress', () => {
  it('walks a new store through its steps and clears the progress when done', async () => {
    const { pool, writes } = recorder();
    await withProgress(pool, 't1', 'tenant.create', planFor('tenant.create'), async () => {
      step('start');
      step('restore');
      step('restore'); // a retried command: no new write
      step('database'); // not in a template store's plan
      step('code');
      step('configure');
    });
    expect(writes.map((w) => w && `${w.index}/${w.total} ${w.step}`)).toEqual(['1/5 server', '2/5 start', '3/5 restore', '4/5 code', '5/5 configure', null]);
    expect(writes[3]!.label).toBe('Adding the theme and plugins');
  });

  it('keeps the step a job stopped at', async () => {
    const { pool, writes } = recorder();
    await expect(
      withProgress(pool, 't1', 'tenant.move', planFor('tenant.move'), async () => {
        step('start');
        throw new Error('Coolify down');
      }),
    ).rejects.toThrow('Coolify down');
    const last = writes.at(-1)!;
    expect(last.step).toBe('start');
    expect(last.failedAt).toBeTruthy();
  });

  it('clears what an earlier job left when a job has no steps to show', async () => {
    const { pool, writes } = recorder();
    await withProgress(pool, 't1', 'tenant.go-live', planFor('tenant.go-live'), async () => step('configure'));
    expect(writes).toEqual([null]);
  });

  it('plans a moved-in site with its database update and check', () => {
    expect(planFor('tenant.create', { imported: true })).toEqual(['server', 'start', 'restore', 'database', 'code', 'configure', 'check']);
    expect(planFor('tenant.rollback', { safetyBackup: true })[0]).toBe('backup');
  });
});

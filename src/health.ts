import type { PgBoss } from 'pg-boss';
import type { Pool } from './db.ts';
import { QUEUE } from './queue.ts';

export interface Health {
  ok: boolean;
  database: 'ok' | 'down';
  queue: 'ok' | 'down';
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

/** Postgres and the job queue, each given 3 seconds to answer. */
export async function checkHealth(pool: Pool, boss: PgBoss): Promise<Health> {
  const [database, queue] = await Promise.all([
    check(() => pool.query('SELECT 1')),
    check(async () => {
      if (!(await boss.getQueue(QUEUE))) throw new Error('queue missing');
    }),
  ]);
  return { ok: database === 'ok' && queue === 'ok', database, queue };
}

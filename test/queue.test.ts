import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterEach, describe, expect, it } from 'vitest';
import { HEARTBEAT_SECONDS, QUEUE, startBoss } from '../src/queue.ts';
import { TEST_DATABASE_URL } from './helpers.ts';

async function wipe() {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  await admin.end();
}

const jobRow = async (boss: PgBoss, id: string) =>
  ((await boss.getDb().executeSql('SELECT state FROM pgboss.job WHERE id = $1', [id])) as { rows: { state: string }[] }).rows[0]!;

let boss: PgBoss | undefined;
afterEach(async () => {
  await boss?.stop({ graceful: false });
  boss = undefined;
});

describe('provision queue after a restart', () => {
  it('hands a job the API stopped working on back for its next try, without waiting for it to expire', async () => {
    await wipe();
    boss = await startBoss(TEST_DATABASE_URL, { retryDelaySeconds: 0 });
    expect((await boss.getQueue(QUEUE))!.heartbeatSeconds).toBe(HEARTBEAT_SECONDS);

    const id = (await boss.send(QUEUE, { type: 'tenant.domains' }, { singletonKey: 'tenant:x' }))!;
    // Claimed, then the API went away: nothing checks in for it any more.
    expect((await boss.fetch(QUEUE)).map((j) => j.id)).toEqual([id]);
    await boss.getDb().executeSql("UPDATE pgboss.job SET heartbeat_on = now() - interval '5 minutes' WHERE id = $1", [id]);
    await boss.supervise(QUEUE);

    expect((await jobRow(boss, id)).state).toBe('retry');
  });

  it('gives a queue made before the heartbeat the heartbeat', async () => {
    await wipe();
    const old = new PgBoss({ connectionString: TEST_DATABASE_URL, schema: 'pgboss' });
    await old.start();
    await old.createQueue(QUEUE, { policy: 'key_strict_fifo', retryLimit: 3, expireInSeconds: 3600 });
    await old.stop({ graceful: false });

    boss = await startBoss(TEST_DATABASE_URL);
    expect((await boss.getQueue(QUEUE))!.heartbeatSeconds).toBe(HEARTBEAT_SECONDS);
  });
});

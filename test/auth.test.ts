import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CpuWatch } from '../src/cpuwatch.ts';
import { createApp } from '../src/app.ts';
import { createApiKey } from '../src/keys.ts';
import { basic, setup, type TestContext } from './helpers.ts';

let t: TestContext;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.close();
});

describe('Basic auth', () => {
  it('accepts a valid key and secret', async () => {
    expect((await t.call('GET', '/v1/versions')).status).toBe(200);
  });

  it('answers 403, never 401, to every kind of bad credential', async () => {
    const { key } = await createApiKey(t.pool, t.productId);
    const cases = [
      null, // no header
      'Bearer abc',
      'Basic !!!not-base64',
      basic(key, 'wrong-secret'),
      basic('11111111-2222-3333-4444-111111111111', 'some-generated-secret'), // unknown key
      basic('not-a-uuid', 'x'),
      `Basic ${Buffer.from('no-colon').toString('base64')}`,
    ];
    for (const auth of cases) {
      const res = await t.call('GET', '/v1/versions', { auth });
      expect(res.status, String(auth)).toBe(403);
    }
  });

  it('rejects a revoked key', async () => {
    const { key, secret } = await createApiKey(t.pool, t.productId);
    await t.pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [key]);
    expect((await t.call('GET', '/v1/versions', { auth: basic(key, secret) })).status).toBe(403);
  });

  it('keeps products apart', async () => {
    const other = (await t.pool.query("INSERT INTO products (name) VALUES ('Other storefront') RETURNING id")).rows[0].id;
    const { key, secret } = await createApiKey(t.pool, other);
    await t.call('POST', '/v1/versions', { body: { name: 'mine', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
    expect(await (await t.call('GET', '/v1/versions', { auth: basic(key, secret) })).json()).toEqual([]);
  });

  it('leaves /health open, and it checks Postgres and the queue', async () => {
    const res = await t.call('GET', '/health', { auth: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, database: 'ok', queue: 'ok', dbBackup: { status: 'off', lastAttemptAt: null, lastSuccessAt: null, sizeBytes: null, stale: false }, jobs: { ok: true, failedLastDay: 0 }, restoreTest: { ok: true, status: 'off', lastPassedAt: null }, cpu: { ok: true, status: 'off' } });
  });

  it("reports the server's CPU in /health, and an hour over the limit doesn't make it a 503", async () => {
    let tick = 0;
    let now = 0;
    const cpuWatch = new CpuWatch({ busyLimit: 0.45, stealLimit: 0.2, windowMinutes: 60 }, () => `cpu  ${60 * tick} 0 0 ${40 * tick} 0 0 0 0 0 0`, () => now);
    for (; tick <= 60; tick++, now += 60_000) cpuWatch.sample();
    const res = await createApp({ ...t.deps, cpuWatch }).request('/health');
    expect(res.status).toBe(200);
    expect((await res.json()).cpu).toEqual({ ok: false, busy: 0.6, steal: 0, minutes: 60 });
  });

  it('answers 503 from /health when Postgres is unreachable', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none' });
    const res = await createApp({ ...t.deps, pool }).request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, database: 'down', queue: 'ok' });
    await pool.end();
  });
});

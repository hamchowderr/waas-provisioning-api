// The website assistant inside a demo on anypress.io/try (src/demo-assistant.ts): a demo's sign-in, its few
// messages, and the hourly limit on new ones.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMOS_PER_HOUR, MESSAGES_PER_DEMO } from '../src/demo-assistant.ts';
import { setup, type TestContext } from './helpers.ts';

let t: TestContext;

beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.pool.query('DELETE FROM demo_assistants');
});

const start = (body: unknown = { siteType: 'website' }) =>
  t.app.request('/demos/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const usage = (method: 'GET' | 'POST', token?: string) =>
  t.app.request('/demos/assistant/usage', { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe('demo assistant', () => {
  it('gives a demo a sign-in, keeping only its hash', async () => {
    const res = await start();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; limit: number; expiresAt: string };
    expect(body.token).toMatch(/^apdemo_[A-Za-z0-9_-]{43}$/);
    expect(body.limit).toBe(MESSAGES_PER_DEMO);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const { rows } = await t.pool.query('SELECT token_hash, site_type FROM demo_assistants');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toContain(body.token);
    expect(rows[0].site_type).toBe('website');
  });

  it('refuses an unknown site type', async () => {
    expect((await start({ siteType: 'casino' })).status).toBe(400);
    expect((await start({})).status).toBe(400);
  });

  it('counts each message and stops at the demo limit', async () => {
    const { token } = (await (await start()).json()) as { token: string };
    for (let i = 1; i <= MESSAGES_PER_DEMO; i++) {
      const res = await usage('POST', token);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { used: number }).used).toBe(i);
    }
    const over = await usage('POST', token);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ used: MESSAGES_PER_DEMO, limit: MESSAGES_PER_DEMO, error: 'limit' });
    expect(await (await usage('GET', token)).json()).toMatchObject({ used: MESSAGES_PER_DEMO, limit: MESSAGES_PER_DEMO });
  });

  it('refuses no sign-in, a wrong one and an ended one', async () => {
    expect((await usage('GET')).status).toBe(403);
    expect((await usage('POST', `apdemo_${'x'.repeat(43)}`)).status).toBe(403);
    const { token } = (await (await start()).json()) as { token: string };
    await t.pool.query(`UPDATE demo_assistants SET expires_at = now() - interval '1 minute'`);
    expect((await usage('POST', token)).status).toBe(403);
  });

  it('starts only so many demos an hour', async () => {
    await t.pool.query(
      `INSERT INTO demo_assistants (token_hash, site_type, expires_at) SELECT md5(g::text), 'website', now() + interval '1 hour' FROM generate_series(1, $1) g`,
      [DEMOS_PER_HOUR],
    );
    expect((await start()).status).toBe(429);
  });
});

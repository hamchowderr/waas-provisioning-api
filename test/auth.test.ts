import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('leaves /health open', async () => {
    expect((await t.call('GET', '/health', { auth: null })).status).toBe(200);
  });
});

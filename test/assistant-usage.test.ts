// The website assistant's monthly allowance (src/assistant-usage.ts): counted per store with the owner's website
// sign-in token, capped by the store's size, and started again each calendar month.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatusCode, WaasClient } from '../sdk/typescript/src/index.ts';
import { assistantUsage, countAssistantMessage, recordAssistantTokens } from '../src/assistant-usage.ts';
import { createApiKey } from '../src/keys.ts';
import { SIZES } from '../src/plans.ts';
import { OWNER, setup, type TestContext } from './helpers.ts';

const BASE = 'https://api.example.test';
let t: TestContext;
let tenantId: string;
let token: string;

const tokenFor = async (tenant: string, resource = `${BASE}/mcp/site`, expires = "now() + interval '1 hour'") => {
  const value = randomBytes(32).toString('base64url');
  await t.pool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, tenant_id, product_id, scope, resource, legacy_scope, platform_admin, expires_at)
     VALUES ($1, 'access', 'website-assistant-test', $2, $3, 'site:read site:write', $4, false, false, ${expires})`,
    [createHash('sha256').update(value).digest('base64url'), tenant, t.productId, resource],
  );
  return value;
};
const usage = (method: 'GET' | 'POST', bearer?: string) =>
  t.app.request('/oauth/site/assistant-usage', { method, headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });

beforeAll(async () => {
  t = await setup();
  t.deps.config.publicUrl = BASE;
  const { key, secret } = await createApiKey(t.pool, t.productId);
  const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    return t.app.request(`${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body: request.method === 'GET' ? undefined : await request.text() });
  }) as typeof fetch;
  const waas = new WaasClient({ baseUrl: BASE, apiKey: key, apiSecret: secret, fetch: appFetch });
  const version = await waas.versions.create({ name: 'v1', phpVersion: '8.3', wordPressVersion: '7.1', useCustomUpload: true });
  for (let i = 0; (await waas.versions.list({ versionId: version.id }))[0]?.statusCode !== StatusCode.Done; i++) {
    if (i > 150) throw new Error('version never became Done');
    await new Promise((r) => setTimeout(r, 100));
  }
  await waas.versions.setProduction(version.id!);
  await waas.tenants.create({ name: 'usage', externalId: 'usage', ...OWNER });
  tenantId = (await waas.waitForTenant({ externalId: 'usage' }, { intervalMs: 100, timeoutMs: 15_000 })).id!;
  token = await tokenFor(tenantId);
});
afterAll(async () => t?.close());

describe('the website assistant allowance', () => {
  it('counts a message with the owner’s token and reports the plan’s limit', async () => {
    const before = await (await usage('GET', token)).json();
    expect(before).toMatchObject({ used: 0, limit: SIZES.small.assistantMessagesPerMonth });
    const counted = await usage('POST', token);
    expect(counted.status).toBe(200);
    expect(await counted.json()).toMatchObject({ used: 1, limit: SIZES.small.assistantMessagesPerMonth });
    expect(new Date((await (await usage('GET', token)).json()).resetsAt).getUTCDate()).toBe(1);
  });

  it('refuses a message once the month’s allowance is spent, without counting it', async () => {
    const limit = SIZES.small.assistantMessagesPerMonth;
    await t.pool.query(`UPDATE assistant_usage SET messages = $2 WHERE tenant_id = $1`, [tenantId, limit]);
    const refused = await usage('POST', token);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ used: limit, limit, error: 'limit' });
    expect((await assistantUsage(t.pool, tenantId)).used).toBe(limit);
  });

  it('gives a bigger store more', async () => {
    await t.pool.query(`UPDATE tenants SET size = 'large' WHERE id = $1`, [tenantId]);
    expect((await usage('POST', token)).status).toBe(200);
    expect((await assistantUsage(t.pool, tenantId)).limit).toBe(SIZES.large.assistantMessagesPerMonth);
    await t.pool.query(`UPDATE tenants SET size = 'small' WHERE id = $1`, [tenantId]);
  });

  it('starts again each calendar month (UTC)', async () => {
    const next = new Date(Date.UTC(2099, 0, 1, 0, 0, 1));
    expect(await countAssistantMessage(t.pool, tenantId, next)).toMatchObject({ used: 1, resetsAt: '2099-02-01T00:00:00.000Z' });
  });

  it('only answers a website sign-in token', async () => {
    expect((await usage('POST')).status).toBe(403);
    expect((await usage('POST', 'not-a-token')).status).toBe(403);
    expect((await usage('POST', await tokenFor(tenantId, `${BASE}/mcp`))).status).toBe(403);
    expect((await usage('POST', await tokenFor(tenantId, `${BASE}/mcp/site`, "now() - interval '1 minute'"))).status).toBe(403);
  });
});

describe('the website assistant’s tokens', () => {
  const send = (body: unknown, bearer: string | undefined = token) =>
    t.app.request('/oauth/site/assistant-usage/tokens', {
      method: 'POST',
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const month = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const totals = async (when = month()) =>
    (
      await t.pool.query(
        'SELECT messages, input_tokens::int AS input, output_tokens::int AS output, cache_read_tokens::int AS read, cache_write_tokens::int AS write, model_steps AS steps FROM assistant_usage WHERE tenant_id = $1 AND month = $2',
        [tenantId, when],
      )
    ).rows[0];

  it('adds each model step’s tokens to the store’s month, without counting a message', async () => {
    const before = await totals();
    expect((await send({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 9000, cacheWriteTokens: 0 })).status).toBe(204);
    expect((await send({ inputTokens: 800, outputTokens: 150 })).status).toBe(204);
    expect(await totals()).toEqual({
      messages: before.messages,
      input: before.input + 2000,
      output: before.output + 450,
      read: before.read + 9000,
      write: before.write,
      steps: before.steps + 2,
    });
  });

  it('keeps counting after the message allowance is spent, since the message was already allowed', async () => {
    await t.pool.query('UPDATE assistant_usage SET messages = $2 WHERE tenant_id = $1 AND month = $3', [tenantId, SIZES.small.assistantMessagesPerMonth, month()]);
    const before = await totals();
    expect((await send({ inputTokens: 10, outputTokens: 5 })).status).toBe(204);
    expect((await totals()).input).toBe(before.input + 10);
  });

  it('starts a new month with its own row', async () => {
    const next = new Date(Date.UTC(2098, 5, 3));
    await recordAssistantTokens(t.pool, tenantId, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 50 }, next);
    expect(await totals(month(next))).toEqual({ messages: 0, input: 7, output: 3, read: 0, write: 50, steps: 1 });
  });

  it('refuses counts that aren’t whole numbers in range, and anything but a website sign-in token', async () => {
    const before = await totals();
    for (const bad of [null, { inputTokens: -1 }, { outputTokens: 1.5 }, { inputTokens: '9' }, { cacheReadTokens: 3_000_000 }]) expect((await send(bad)).status).toBe(400);
    expect((await send({ inputTokens: 1 }, '')).status).toBe(403);
    expect((await send({ inputTokens: 1 }, await tokenFor(tenantId, `${BASE}/mcp`))).status).toBe(403);
    expect(await totals()).toEqual(before);
  });
});

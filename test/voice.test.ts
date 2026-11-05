// The phone receptionist (src/voice.ts): the platform admin gives a store a number, and the voice agent, holding
// VOICE_AGENT_TOKEN, reads the store behind a called number, calls only its phone routes (signed with the store's
// site key) and logs calls against the month's minutes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatusCode, WaasClient } from '../sdk/typescript/src/index.ts';
import { createApiKey } from '../src/keys.ts';
import { SIZES } from '../src/plans.ts';
import { toE164 } from '../src/voice.ts';
import { OWNER, setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

const AGENT = 'voice-agent-test-token';
const NUMBER = '+12135550100';
let t: TestContext;
let tenantId: string;
let seen: { url: string; method: string; signed: boolean }[] = [];

const storeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  seen.push({ url, method: init?.method ?? 'GET', signed: !!new Headers(init?.headers).get('x-anypress-signature') });
  const body = url.includes('/business') ? { site: { name: 'Rosa Plumbing' }, about: { hours: '8 to 6' } } : { services: [{ id: 3, title: 'Leak repair', minutes: 60 }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const agent = (method: string, path: string, body?: unknown, token = AGENT) =>
  t.app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = (method: string, path: string, body?: unknown) =>
  t.app.request(`/admin${path}`, { method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${TEST_ADMIN_TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  t = await setup();
  t.deps.siteFetch = storeFetch;
  t.deps.config.voiceAgentToken = AGENT;
  const { key, secret } = await createApiKey(t.pool, t.productId);
  const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    return t.app.request(`${url.pathname}${url.search}`, init);
  }) as typeof fetch;
  const waas = new WaasClient({ baseUrl: 'https://api.example.test', apiKey: key, apiSecret: secret, fetch: appFetch });
  const version = await waas.versions.create({ name: 'v1', phpVersion: '8.3', wordPressVersion: '7.1', useCustomUpload: true });
  for (let i = 0; (await waas.versions.list({ versionId: version.id }))[0]?.statusCode !== StatusCode.Done; i++) {
    if (i > 150) throw new Error('version never became Done');
    await new Promise((r) => setTimeout(r, 100));
  }
  await waas.versions.setProduction(version.id!);
  await waas.tenants.create({ ...OWNER, name: 'Rosa Plumbing', externalId: 'voice-1' });
  tenantId = (await waas.waitForTenant({ externalId: 'voice-1' }, { intervalMs: 100, timeoutMs: 15_000 })).id!;
});
afterAll(async () => t?.close());

describe('phone numbers', () => {
  it('are read as E.164', () => {
    expect(toE164('+1 (213) 555-0100')).toBe(NUMBER);
    expect(toE164('2135550100')).toBe(NUMBER);
    expect(toE164('12')).toBeNull();
  });
});

describe('the phone receptionist', () => {
  it('needs the agent token', async () => {
    expect((await agent('GET', `/voice/lines/${encodeURIComponent(NUMBER)}`, undefined, '')).status).toBe(403);
    expect((await agent('GET', `/voice/lines/${encodeURIComponent(NUMBER)}`, undefined, 'wrong')).status).toBe(403);
  });

  it('knows no store for a number nobody has', async () => {
    expect((await agent('GET', `/voice/lines/${encodeURIComponent(NUMBER)}`)).status).toBe(404);
  });

  it('lets the platform admin give a store its number', async () => {
    const res = await admin('PUT', `/voice-lines/${encodeURIComponent(NUMBER)}`, { tenantId, forwardTo: '(213) 555-0199' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ number: NUMBER, tenantId, forwardTo: '+12135550199' });
    expect((await admin('PUT', `/voice-lines/${encodeURIComponent(NUMBER)}`, { tenantId: '00000000-0000-0000-0000-000000000000' })).status).toBe(404);
  });

  it('answers who the number belongs to, with the business profile and minutes', async () => {
    seen = [];
    const res = await agent('GET', `/voice/lines/${encodeURIComponent(NUMBER)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ tenantId, name: 'Rosa Plumbing', forwardTo: '+12135550199', usedMinutes: 0, limitMinutes: SIZES.small.voiceMinutesPerMonth });
    expect(body.business.about.hours).toBe('8 to 6');
    expect(seen[0]).toMatchObject({ method: 'GET', signed: true });
    expect(seen[0]!.url).toMatch(/\/wp-json\/anypress-client\/v1\/site\/business$/);
  });

  it('passes on the store’s phone routes, signed, and nothing else', async () => {
    seen = [];
    const ok = await agent('POST', `/voice/lines/${encodeURIComponent(NUMBER)}/store`, { method: 'GET', path: '/phone/services' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).body.services[0].title).toBe('Leak repair');
    expect(seen[0]!.url).toMatch(/\/site\/phone\/services$/);
    expect(seen[0]!.signed).toBe(true);
    for (const path of ['/pages', '/styles', '/business', '/phone/../pages', '/phone/services/3/../../pages']) {
      expect((await agent('POST', `/voice/lines/${encodeURIComponent(NUMBER)}/store`, { method: 'POST', path })).status).toBe(400);
    }
    expect((await agent('POST', `/voice/lines/${encodeURIComponent(NUMBER)}/store`, { method: 'DELETE', path: '/phone/bookings' })).status).toBe(400);
    expect(seen).toHaveLength(1);
  });

  it('logs calls and counts their minutes', async () => {
    const res = await agent('POST', `/voice/lines/${encodeURIComponent(NUMBER)}/calls`, { caller: '+1 555 010 2000', seconds: 125, outcome: 'booked', summary: 'Leak repair booked' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ usedMinutes: 3 });
    expect((await agent('POST', `/voice/lines/${encodeURIComponent(NUMBER)}/calls`, { seconds: -1, outcome: 'booked' })).status).toBe(400);
    expect((await agent('POST', `/voice/lines/${encodeURIComponent(NUMBER)}/calls`, { seconds: 5, outcome: 'nope' })).status).toBe(400);
    const { rows } = await t.pool.query('SELECT caller, outcome FROM voice_calls WHERE tenant_id = $1', [tenantId]);
    expect(rows).toEqual([{ caller: '+15550102000', outcome: 'booked' }]);
  });

  it('stops answering for a number that is taken away', async () => {
    expect((await admin('DELETE', `/voice-lines/${encodeURIComponent(NUMBER)}`)).status).toBe(204);
    expect((await agent('GET', `/voice/lines/${encodeURIComponent(NUMBER)}`)).status).toBe(404);
  });

  it('is off when the server has no agent token', async () => {
    t.deps.config.voiceAgentToken = undefined;
    expect((await agent('GET', `/voice/lines/${encodeURIComponent(NUMBER)}`)).status).toBe(404);
    t.deps.config.voiceAgentToken = AGENT;
  });
});

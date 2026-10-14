// Drives the TypeScript SDK (sdk/typescript/) against the real app, so a route change the SDK doesn't follow fails here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatusCode, verifyWebhook, WaasApiError, WaasClient, WebhookVerificationError } from '../sdk/typescript/src/index.ts';
import { sign } from '../src/webhooks.ts';
import { createApiKey } from '../src/keys.ts';
import { setup, type TestContext } from './helpers.ts';

let t: TestContext;
let client: WaasClient;
let apiKey: string;
const requests: string[] = [];

/** A fetch that hands the request to the app in-process, as test/helpers.ts does. */
const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
  return t.app.request(`${url.pathname}${url.search}`, init);
}) as typeof fetch;

const fast = { intervalMs: 100, timeoutMs: 15_000 };

beforeAll(async () => {
  t = await setup();
  const created = await createApiKey(t.pool, t.productId);
  apiKey = created.key;
  client = new WaasClient({ baseUrl: 'https://api.example.test/', apiKey: created.key, apiSecret: created.secret, fetch: appFetch });

  const version = await client.versions.create({ name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true });
  for (let i = 0; (await client.versions.list({ versionId: version.id }))[0]?.statusCode !== StatusCode.Done; i++) {
    if (i > 150) throw new Error('version never became Done');
    await new Promise((r) => setTimeout(r, 100));
  }
  await client.versions.setProduction(version.id!);
});
afterAll(async () => {
  await t.close();
});

describe('TypeScript SDK', () => {
  it('creates a store and waits until it is Done', async () => {
    const created = await client.tenants.create({ name: 'SDK store', externalId: 'sdk-1' });
    expect(created).toMatchObject({ externalId: 'sdk-1' });
    expect(requests).toContain('POST /v1/tenants');

    const tenant = await client.waitForTenant({ externalId: 'sdk-1' }, fast);
    expect(tenant).toMatchObject({ externalId: 'sdk-1', statusCode: StatusCode.Done, domainName: created.baseDomain });
    expect(await client.tenants.get({ tenantId: tenant.id! })).toMatchObject({ externalId: 'sdk-1' });
    expect(await client.tenants.get({ externalId: 'no-such-store' })).toBeNull();
    expect((await client.tenants.list()).map((x) => x.externalId)).toContain('sdk-1');
  });

  it('manages domains', async () => {
    const ref = { externalId: 'sdk-1' };
    expect(await client.domains.checkAvailability('shop.sdk-example.com')).toMatchObject({ available: true });
    await client.domains.add(ref, { domainName: 'shop.sdk-example.com' });
    expect((await client.domains.list(ref)).map((d) => d.domainName)).toContain('shop.sdk-example.com');
    expect(requests).toContain('GET /v1/tenants/domains?externalId=sdk-1');
    await client.waitForTenant(ref, fast);
    await client.domains.remove(ref, { domainName: 'shop.sdk-example.com' });
    expect(requests).toContain('DELETE /v1/tenants/domains?externalId=sdk-1&domainName=shop.sdk-example.com');
  });

  it('suspends, backs up and resumes a store', async () => {
    const ref = { externalId: 'sdk-1' };
    await client.waitForTenant(ref, fast);
    expect(await client.tenants.suspend(ref, { takeBackup: false })).toMatchObject({ externalId: 'sdk-1', backupId: null });
    const { backupId } = await client.tenants.createBackup(ref);
    expect((await client.tenants.listBackups(ref)).map((b) => b.id)).toContain(backupId);
    expect(await client.tenants.resume(ref)).toMatchObject({ externalId: 'sdk-1' });
  });

  it('throws WaasApiError with the API message', async () => {
    const error = await client.tenants.create({ name: 'dupe', externalId: 'has space' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaasApiError);
    expect(error).toMatchObject({ status: 400, operationId: 'createTenant' });
    expect((error as WaasApiError).apiMessage).toBeTruthy();

    const wrongSecret = new WaasClient({ baseUrl: 'https://api.example.test', apiKey, apiSecret: 'wrong', fetch: appFetch });
    await expect(wrongSecret.versions.list()).rejects.toMatchObject({ status: 403, apiMessage: 'Invalid API key or secret' });
  });

  it('deletes a store', async () => {
    await client.waitForTenant({ externalId: 'sdk-1' }, fast);
    await expect(client.tenants.delete({ externalId: 'sdk-1' })).resolves.toBeUndefined();
  });

  it('manages webhook endpoints', async () => {
    const created = await client.webhooks.create({ url: 'https://hooks.sdk-example.com/waas', eventTypes: ['tenant.ready'] });
    expect(created.secret).toMatch(/^whsec_/);
    expect((await client.webhooks.list()).map((w) => w.id)).toContain(created.id);
    expect(await client.webhooks.update(created.id, { enabled: false })).toMatchObject({ enabled: false, eventTypes: ['tenant.ready'] });
    expect((await client.webhooks.rotateSecret(created.id)).secret).not.toBe(created.secret);
    const delivery = await client.webhooks.test(created.id);
    expect(delivery).toMatchObject({ eventType: 'webhook.test', endpointId: created.id });
    expect((await client.webhooks.deliveries(created.id)).items.map((d) => d.id)).toContain(delivery.id);
    expect(await client.webhooks.delete(created.id)).toMatchObject({ id: created.id });
  });

  it('verifies webhook signatures', async () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const body = JSON.stringify({ type: 'tenant.ready', timestamp: new Date().toISOString(), data: { tenant: { id: 'x' } } });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { 'webhook-id': 'evt-1', 'webhook-timestamp': String(timestamp), 'webhook-signature': sign(secret, 'evt-1', timestamp, body) };
    expect(await verifyWebhook(secret, headers, body)).toMatchObject({ type: 'tenant.ready' });
    expect(await verifyWebhook(secret, new Headers(headers), body)).toMatchObject({ type: 'tenant.ready' });
    await expect(verifyWebhook(secret, headers, body.replace('ready', 'deleted'))).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(verifyWebhook(secret, headers, body, { now: (timestamp + 600) * 1000 })).rejects.toThrow(/timestamp/);
  });
});

// Outgoing webhooks (src/webhooks.ts): signing, where endpoints may be, the events store jobs send,
// retries, and the /v1 and admin endpoints, validated against openapi/webhooks.yaml and
// openapi/admin/admin-api.yaml.
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApiKey } from '../src/keys.ts';
import { createAjv } from '../src/openapi.ts';
import { Status } from '../src/status.ts';
import { checkEndpointUrl, isPrivateAddress, sign } from '../src/webhooks.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext, OWNER } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webhookSpec: any = parse(readFileSync(new URL('../openapi/webhooks.yaml', import.meta.url), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: webhookSpec.components }, 'webhooks');
ajv.addSchema({ components: adminSpec.components }, 'admin');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schemaOf = (spec: any, id: string, path: string, method: string, status = '200') =>
  ajv.compile(JSON.parse(JSON.stringify(spec.paths[path][method].responses[status].content['application/json'].schema).replaceAll('"#/components', `"${id}#/components`)));
const validate = {
  created: schemaOf(webhookSpec, 'webhooks', '/v1/webhooks', 'post', '201'),
  list: schemaOf(webhookSpec, 'webhooks', '/v1/webhooks', 'get'),
  deliveries: schemaOf(webhookSpec, 'webhooks', '/v1/webhooks/{id}/deliveries', 'get'),
  delivery: schemaOf(webhookSpec, 'webhooks', '/v1/webhooks/{id}/test', 'post'),
  event: ajv.compile({ $ref: 'webhooks#/components/schemas/WebhookEvent' }),
  adminList: schemaOf(adminSpec, 'admin', '/admin/webhooks', 'get'),
  adminDeliveries: schemaOf(adminSpec, 'admin', '/admin/webhooks/deliveries', 'get'),
};
function expectValid(fn: (typeof validate)[keyof typeof validate], value: unknown) {
  expect(fn(value), ajv.errorsText(fn.errors)).toBe(true);
}

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  path: string;
}

let t: TestContext;
let server: Server;
let base: string;
let received: Received[] = [];
/** Paths that answer 500. */
const failing = new Set<string>();
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;

beforeAll(async () => {
  t = await setup();
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body, path: req.url ?? '' });
      res.statusCode = failing.has(req.url ?? '') ? 500 : 204;
      res.end(failing.has(req.url ?? '') ? 'endpoint broke' : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});
afterAll(async () => {
  server.close();
  await t.close();
});
beforeEach(async () => {
  received = [];
  failing.clear();
  await t.pool.query('DELETE FROM webhook_endpoints');
});

async function register(body: object, auth?: string) {
  const res = await t.call('POST', '/v1/webhooks', { body, auth });
  return { status: res.status, body: (await res.json()) as { id: string; secret: string; message?: string } };
}

async function createTenant(name: string) {
  const res = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name } });
  return (await res.json()) as { id: string; externalId: string };
}

/** Checks a request the way a receiver would, with the Standard Webhooks scheme. */
function verify(secret: string, r: Received): boolean {
  const id = r.headers['webhook-id'] as string;
  const timestamp = r.headers['webhook-timestamp'] as string;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${r.body}`).digest('base64');
  return (r.headers['webhook-signature'] as string).split(' ').includes(`v1,${expected}`);
}

describe('signing and URLs', () => {
  it('signs as the Standard Webhooks spec does', () => {
    // The worked example from the Standard Webhooks specification.
    expect(sign('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}')).toBe(
      'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    );
  });

  it('knows private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['191.101.15.236', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('takes only public https URLs unless private ones are allowed', () => {
    const strict = { allowPrivate: false, logDays: 30 };
    expect(checkEndpointUrl('https://hooks.example.com/waas', strict)).toBe('https://hooks.example.com/waas');
    for (const bad of ['http://hooks.example.com/', 'https://localhost/x', 'https://127.0.0.1/', 'https://[::1]/', 'https://10.0.0.5/', 'ftp://x.example/', 'https://u:p@example.com/', 'nonsense']) {
      expect(() => checkEndpointUrl(bad, strict), bad).toThrow();
    }
    expect(checkEndpointUrl('http://127.0.0.1:8080/x', { allowPrivate: true, logDays: 30 })).toBe('http://127.0.0.1:8080/x');
  });
});

describe('endpoints', () => {
  it('registers an endpoint, shows its secret once, and keeps it to its product', async () => {
    const { status, body } = await register({ url: `${base}/a`, description: 'CRM sync', eventTypes: ['tenant.ready'] });
    expect(status).toBe(201);
    expectValid(validate.created, body);
    expect(body.secret).toMatch(/^whsec_/);

    const list = await (await t.call('GET', '/v1/webhooks')).json();
    expectValid(validate.list, list);
    expect(JSON.stringify(list)).not.toContain(body.secret);
    // Encrypted at rest.
    expect(JSON.stringify((await t.pool.query('SELECT * FROM webhook_endpoints')).rows)).not.toContain(body.secret);

    // Another product's key neither sees nor changes it.
    const other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Other') RETURNING id")).rows[0]!.id;
    const key = await createApiKey(t.pool, other);
    const auth = basic(key.key, key.secret);
    expect(await (await t.call('GET', '/v1/webhooks', { auth })).json()).toEqual([]);
    expect((await t.call('DELETE', `/v1/webhooks/${body.id}`, { auth })).status).toBe(404);

    const updated = await t.call('PUT', `/v1/webhooks/${body.id}`, { body: { enabled: false, eventTypes: [] } });
    expect(await updated.json()).toMatchObject({ enabled: false, eventTypes: [], description: 'CRM sync' });

    const rotated = (await (await t.call('POST', `/v1/webhooks/${body.id}/rotate-secret`)).json()) as { secret: string };
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(body.secret);

    expect((await t.call('DELETE', `/v1/webhooks/${body.id}`)).status).toBe(200);
    expect(await (await t.call('GET', '/v1/webhooks')).json()).toEqual([]);
  });

  it('refuses bad input', async () => {
    expect((await register({})).status).toBe(400);
    expect((await register({ url: `${base}/a`, eventTypes: ['tenant.exploded'] })).body.message).toMatch(/Unknown event type/);
    expect((await register({ url: `${base}/a`, enabled: 'yes' })).status).toBe(400);
    expect((await t.call('GET', '/v1/webhooks/not-a-uuid')).status).toBe(400);
    expect((await t.call('GET', '/v1/webhooks', { auth: null })).status).toBe(403);
  });
});

describe('events', () => {
  it('sends a signed tenant.ready when a store is created, only to endpoints that want it', async () => {
    const all = await register({ url: `${base}/all` });
    await register({ url: `${base}/deletes`, eventTypes: ['tenant.deleted'] });
    await register({ url: `${base}/off`, enabled: false });

    const tenant = await createTenant('Hooked');
    const hit = await waitFor(async () => received.find((r) => r.path === '/all' && JSON.parse(r.body).type === 'tenant.ready'));
    expect(verify(all.body.secret, hit)).toBe(true);
    const event = JSON.parse(hit.body);
    expectValid(validate.event, event);
    expect(event.data.tenant).toMatchObject({ id: tenant.id, externalId: tenant.externalId, statusCode: Status.Done });
    expect(hit.headers['content-type']).toBe('application/json');

    // The delete reaches the endpoint that wants only deletes, with the store as it was.
    expect((await t.call('DELETE', `/v1/tenants?tenantId=${tenant.id}`)).status).toBe(200);
    const deleted = await waitFor(async () => received.find((r) => r.path === '/deletes'));
    expect(JSON.parse(deleted.body)).toMatchObject({ type: 'tenant.deleted', data: { tenant: { id: tenant.id } } });
    expect(received.filter((r) => r.path === '/deletes')).toHaveLength(1);
    expect(received.filter((r) => r.path === '/off')).toHaveLength(0);

    const deliveries = await (await t.call('GET', `/v1/webhooks/${all.body.id}/deliveries`)).json();
    expectValid(validate.deliveries, deliveries);
    expect((deliveries as { items: { status: string; eventType: string }[] }).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: 'tenant.ready', status: 'delivered' })]),
    );
  });

  it('sends nothing, and records nothing, for a product with no endpoints', async () => {
    const before = (await t.pool.query('SELECT count(*)::int AS n FROM webhook_events')).rows[0].n;
    const tenant = await createTenant('Quiet');
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?tenantId=${tenant.id}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM webhook_events')).rows[0].n).toBe(before);
  });

  it('sends a test event, retries a failing endpoint, marks it failed, and sends it again on request', async () => {
    failing.add('/broken');
    const { body } = await register({ url: `${base}/broken` });
    const res = await t.call('POST', `/v1/webhooks/${body.id}/test`);
    const delivery = (await res.json()) as { id: string };
    expectValid(validate.delivery, delivery);

    // The tests allow 2 retries: 3 attempts, then failed.
    const failed = await waitFor(async () => {
      const { rows } = await t.pool.query('SELECT * FROM webhook_deliveries WHERE id = $1', [delivery.id]);
      return rows[0]?.status === 'failed' ? rows[0] : null;
    }, 30000);
    expect(failed).toMatchObject({ attempts: 3, response_status: 500, response_body: 'endpoint broke', error: 'HTTP 500' });
    const attempts = received.filter((r) => r.path === '/broken');
    expect(attempts).toHaveLength(3);
    // The same event id on every attempt, so a receiver can drop repeats.
    expect(new Set(attempts.map((r) => r.headers['webhook-id'])).size).toBe(1);
    expect(JSON.parse(attempts[0]!.body)).toMatchObject({ type: 'webhook.test', data: { endpointId: body.id } });

    failing.clear();
    const retried = await t.call('POST', `/v1/webhooks/deliveries/${delivery.id}/retry`);
    expect(await retried.json()).toMatchObject({ status: 'pending', attempts: 0 });
    // Still pending: not again until it settles.
    await waitFor(async () => (await t.pool.query("SELECT 1 FROM webhook_deliveries WHERE id = $1 AND status = 'delivered'", [delivery.id])).rowCount);
    expect(received.filter((r) => r.path === '/broken')).toHaveLength(4);
  });
});

describe('admin', () => {
  it('lists every endpoint with how its deliveries went, and its deliveries', async () => {
    failing.add('/admin-broken');
    const created = await t.call('POST', '/admin/webhooks', { auth: ADMIN, body: { productId: t.productId, url: `${base}/admin-broken` } });
    expect(created.status).toBe(201);
    const endpoint = (await created.json()) as { id: string; secret: string };
    expect(endpoint.secret).toMatch(/^whsec_/);
    const test = (await (await t.call('POST', `/admin/webhooks/${endpoint.id}/test`, { auth: ADMIN })).json()) as { id: string };
    await waitFor(async () => (await t.pool.query("SELECT 1 FROM webhook_deliveries WHERE id = $1 AND status = 'failed'", [test.id])).rowCount, 30000);

    const list = await (await t.call('GET', `/admin/webhooks?productId=${t.productId}`, { auth: ADMIN })).json();
    expectValid(validate.adminList, list);
    expect(list).toEqual([expect.objectContaining({ id: endpoint.id, productName: 'Example storefront', last24Hours: { sent: 1, failed: 1 }, pending: 0 })]);

    const deliveries = await (await t.call('GET', `/admin/webhooks/deliveries?status=failed&endpointId=${endpoint.id}`, { auth: ADMIN })).json();
    expectValid(validate.adminDeliveries, deliveries);
    expect(deliveries).toMatchObject({ total: 1, items: [{ id: test.id, eventType: 'webhook.test', url: `${base}/admin-broken`, productName: 'Example storefront' }] });

    expect((await t.call('PUT', `/admin/webhooks/${endpoint.id}`, { auth: ADMIN, body: { enabled: false } })).status).toBe(200);
    expect((await t.call('GET', '/admin/webhooks', { auth: t.auth })).status).toBe(403);
    expect((await t.call('DELETE', `/admin/webhooks/${endpoint.id}`, { auth: ADMIN })).status).toBe(200);
  });
});

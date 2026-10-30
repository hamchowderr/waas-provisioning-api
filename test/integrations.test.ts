// Drives the n8n node, the Zapier app and the Make app (integrations/) against the real app over HTTP,
// webhook deliveries included, so a route or payload change they don't follow fails here.
// Needs `npm ci` in integrations/n8n and integrations/zapier, and `npm run build` in integrations/n8n.
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

const root = new URL('../integrations/', import.meta.url);
const requireFrom = (dir: string) => createRequire(new URL(`${dir}/package.json`, root));
const n8n = {
  node: requireFrom('n8n')('./dist/nodes/AnyPress/AnyPress.node.js'),
  trigger: requireFrom('n8n')('./dist/nodes/AnyPressTrigger/AnyPressTrigger.node.js'),
  shared: requireFrom('n8n')('./dist/nodes/AnyPress/shared.js'),
};
const zapierRequire = requireFrom('zapier');
const zapierCore = zapierRequire('zapier-platform-core');
const ZapierApp = zapierRequire('./index.js');
// Zapier's request logging patches node:http in-process, which here would also catch the API's own webhook deliveries.
const appTester = zapierCore.createAppTester({ ...ZapierApp, flags: { skipHttpPatch: true } });

let t: TestContext;
let api: ServerType;
let apiUrl: string;
let receiver: Server;
let receiverUrl: string;
/** Webhook requests the API sent to the receiver, raw. */
const received: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];

let storefrontKey: { key: string; secret: string };
let partnerKey: { key: string; secret: string };
let resellerId: string;

async function admin(method: string, path: string, body?: unknown) {
  const res = await t.call(method, path, { body, auth: `Bearer ${TEST_ADMIN_TOKEN}` });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  return res.json() as Promise<any>;
}

beforeAll(async () => {
  t = await setup();
  // The API, served over real HTTP: the Zapier app and the n8n helpers make their own requests.
  await new Promise<void>((resolve) => {
    api = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      apiUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  // The storefront's own key for n8n, and a partner key whose account holds the same storefront for Zapier.
  const [key, secret] = Buffer.from(t.auth.slice('Basic '.length), 'base64').toString().split(':') as [string, string];
  storefrontKey = { key, secret };
  const reseller = await admin('POST', '/admin/resellers', { name: 'Integration Partners', productIds: [t.productId] });
  resellerId = reseller.id;
  const partner = await admin('POST', `/admin/resellers/${resellerId}/keys`, { label: 'Zapier' });
  partnerKey = { key: partner.id, secret: partner.secret };

  const version = (await (await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } })).json()) as any;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${version.id}`)).json()) as any[])[0]?.statusCode === 1);
  expect((await t.call('PUT', '/v1/versions/production', { body: { versionId: version.id } })).status).toBe(200);
});

afterAll(async () => {
  await new Promise((resolve) => receiver?.close(resolve));
  await new Promise((resolve) => api?.close(resolve));
  await t.close();
});

/** Waits for the receiver to get an event of this type at this path, and takes it. */
async function delivery(path: string, type: string) {
  const typeOf = (body: string) => {
    try {
      return JSON.parse(body).type;
    } catch {
      return undefined;
    }
  };
  const found = await waitFor(async () => received.find((r) => r.path === path && typeOf(r.body) === type));
  received.splice(received.indexOf(found), 1);
  return found;
}

/** Whether the create job for this site asks to email its owner. */
async function notifyFlag(externalId: string) {
  const { rows } = await t.pool.query(
    "SELECT j.data->'notifyOwner' AS flag FROM pgboss.job j JOIN tenants x ON x.id::text = j.data->>'tenantId' WHERE j.data->>'type' = 'tenant.create' AND x.external_id = $1",
    [externalId],
  );
  return (rows[0]?.flag ?? undefined) as boolean | undefined;
}

// ---------------------------------------------------------------- n8n

/** What n8n's httpRequestWithAuthentication does with the AnyPress API credential, failing as NodeApiError does. */
async function n8nRequest(credentials: Record<string, string>, options: any) {
  const url = new URL(options.url);
  for (const [k, v] of Object.entries(options.qs ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: options.method,
    headers: { Authorization: basic(credentials.apiKey!, credentials.apiSecret!), 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${text}`), { httpCode: String(res.status) });
  return text ? JSON.parse(text) : undefined;
}

function n8nContext(params: Record<string, unknown>, staticData: Record<string, unknown> = {}) {
  const credentials = { apiKey: storefrontKey.key, apiSecret: storefrontKey.secret, baseUrl: `${apiUrl}/` };
  const node = { id: '1', name: 'AnyPress', type: 'n8n-nodes-anypress.anyPress', typeVersion: 1, position: [0, 0], parameters: {} };
  return {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (name: string, _i?: unknown, fallback?: unknown) => (name in params ? params[name] : (fallback ?? (typeof _i === 'string' ? _i : undefined))),
    getCredentials: async () => credentials,
    getNode: () => node,
    continueOnFail: () => false,
    getWorkflowStaticData: () => staticData,
    getNodeWebhookUrl: () => `${receiverUrl}/n8n`,
    getWorkflow: () => ({ name: 'New client sites' }),
    helpers: {
      httpRequestWithAuthentication: (_type: string, options: unknown) => n8nRequest(credentials, options),
      returnJsonArray: (items: unknown[]) => items.map((json) => ({ json })),
    },
  };
}

async function runNode(params: Record<string, unknown>) {
  const node = new n8n.node.AnyPress();
  const [items] = await node.execute.call(n8nContext({ resource: 'site', storefront: '', ...params }));
  return items[0].json;
}

describe('n8n node', () => {
  const staticData: Record<string, unknown> = {};
  const triggerParams = { storefront: '', events: ['tenant.ready', 'tenant.suspended'] };

  it('checks the credential the way its test request does, for both kinds of key', async () => {
    for (const k of [storefrontKey, partnerKey]) {
      const res = await fetch(`${apiUrl}/v1/basesnapshots`, { headers: { Authorization: basic(k.key, k.secret) } });
      expect(res.status).toBe(200);
    }
  });

  it('registers its webhook, and finds it again', async () => {
    const hooks = new n8n.trigger.AnyPressTrigger().webhookMethods.default;
    const ctx = n8nContext(triggerParams, staticData);
    expect(await hooks.checkExists.call(ctx)).toBe(false);
    expect(await hooks.create.call(ctx)).toBe(true);
    expect(staticData).toMatchObject({ webhookId: expect.any(String), webhookSecret: expect.stringMatching(/^whsec_/) });
    expect(await hooks.checkExists.call(ctx)).toBe(true);

    const endpoints = (await (await t.call('GET', '/v1/webhooks')).json()) as any[];
    expect(endpoints).toContainEqual(
      expect.objectContaining({ id: staticData.webhookId, url: `${receiverUrl}/n8n`, eventTypes: ['tenant.ready', 'tenant.suspended'], description: 'n8n: New client sites' }),
    );
  });

  it('creates a site, and the trigger passes on the signed tenant.ready', async () => {
    const created = await runNode({ operation: 'create', name: 'Rose and Fern', externalId: 'n8n-1', email: 'owner@roseandfern.example', waitUntilReady: false, additionalFields: { size: 'medium' } });
    expect(created).toMatchObject({ externalId: 'n8n-1', baseDomain: expect.any(String) });

    const hit = await delivery('/n8n', 'tenant.ready');
    const trigger = new n8n.trigger.AnyPressTrigger();
    let status = 200;
    const response = { status: (s: number) => ((status = s), { json: () => undefined }) };
    const webhookCtx = (body: string) => ({
      ...n8nContext(triggerParams, staticData),
      getRequestObject: () => ({ headers: hit.headers, body: JSON.parse(body), rawBody: Buffer.from(body) }),
      getResponseObject: () => response,
    });

    const result = await trigger.webhook.call(webhookCtx(hit.body));
    expect(result.workflowData[0][0].json).toMatchObject({
      event: 'tenant.ready',
      eventId: hit.headers['webhook-id'],
      externalId: 'n8n-1',
      name: 'Rose and Fern',
      size: 'medium',
      statusCode: 1,
      url: `https://${created.baseDomain}`,
    });

    // A changed body no longer matches its signature: 401, and nothing starts.
    const forged = await trigger.webhook.call(webhookCtx(hit.body.replace('Rose and Fern', 'Someone Else')));
    expect(forged).toEqual({ noWebhookResponse: true });
    expect(status).toBe(401);
  });

  it('passes on Notify the Owner only when it is on', async () => {
    await runNode({ operation: 'create', name: 'Quiet Site', externalId: 'n8n-quiet', email: 'quiet@example.com', waitUntilReady: false, additionalFields: {} });
    await runNode({ operation: 'create', name: 'Told Site', externalId: 'n8n-told', email: 'told@example.com', waitUntilReady: false, additionalFields: { notifyOwner: true } });
    expect(await notifyFlag('n8n-quiet')).toBeUndefined();
    expect(await notifyFlag('n8n-told')).toBe(true);
  });

  it('waits until ready, and answers a repeated create with the same site', async () => {
    const again = await runNode({ operation: 'create', name: 'Rose and Fern', externalId: 'n8n-1', email: 'owner@roseandfern.example', waitUntilReady: true, additionalFields: { size: 'medium' } });
    expect(again).toMatchObject({ externalId: 'n8n-1', statusCode: 1, url: expect.stringMatching(/^https:\/\//) });
  });

  it('gets, suspends, resumes and deletes the site', async () => {
    const site = await runNode({ operation: 'get', findBy: 'externalId', ref: 'n8n-1' });
    expect(site).toMatchObject({ externalId: 'n8n-1', name: 'Rose and Fern' });
    expect(await runNode({ operation: 'get', findBy: 'tenantId', siteId: site.id })).toMatchObject({ externalId: 'n8n-1' });
    await expect(runNode({ operation: 'get', findBy: 'externalId', ref: 'no-such-site' })).rejects.toThrow('No site found');

    expect(await runNode({ operation: 'suspend', findBy: 'externalId', ref: 'n8n-1', takeBackup: false })).toMatchObject({ externalId: 'n8n-1' });
    await delivery('/n8n', 'tenant.suspended');
    expect(await runNode({ operation: 'get', findBy: 'externalId', ref: 'n8n-1' })).toMatchObject({ isSuspended: true });
    expect(await runNode({ operation: 'resume', findBy: 'tenantId', siteId: site.id })).toMatchObject({ externalId: 'n8n-1' });
    await waitFor(async () => (await runNode({ operation: 'get', findBy: 'externalId', ref: 'n8n-1' })).isSuspended === false);
    await waitFor(async () => (await runNode({ operation: 'get', findBy: 'externalId', ref: 'n8n-1' })).statusCode === 1);
    expect(await runNode({ operation: 'delete', findBy: 'externalId', ref: 'n8n-1' })).toEqual({ deleted: true, externalId: 'n8n-1' });
  });

  it('removes its webhook when the workflow is turned off', async () => {
    const hooks = new n8n.trigger.AnyPressTrigger().webhookMethods.default;
    const ctx = n8nContext(triggerParams, staticData);
    const id = staticData.webhookId;
    expect(await hooks.delete.call(ctx)).toBe(true);
    expect(staticData.webhookId).toBeUndefined();
    expect((await t.call('GET', `/v1/webhooks/${id}`)).status).toBe(404);
  });

  it('verifies signatures like the API signs them', () => {
    const { verifySignature } = n8n.shared;
    const secret = `whsec_${Buffer.alloc(24, 1).toString('base64')}`;
    const now = 1_760_000_000;
    const body = '{"type":"webhook.test"}';
    const sig = createHmac('sha256', Buffer.alloc(24, 1)).update(`id-1.${now}.${body}`).digest('base64');
    const headers = { 'webhook-id': 'id-1', 'webhook-timestamp': String(now), 'webhook-signature': `v1,${sig}` };
    expect(verifySignature(secret, headers, body, now)).toBe(true);
    expect(verifySignature(secret, headers, body, now + 301)).toBe(false);
    expect(verifySignature(secret, { ...headers, 'webhook-signature': `v1,${sig.slice(1)}x` }, body, now)).toBe(false);
  });
});

// ---------------------------------------------------------------- Zapier

describe('Zapier app', () => {
  const authData = () => ({ apiKey: partnerKey.key, apiSecret: partnerKey.secret, baseUrl: apiUrl });
  let subscribeData: any;

  it('tests the connection and labels it, for both kinds of key', async () => {
    expect(await appTester(ZapierApp.authentication.test, { authData: authData() })).toEqual({ kind: 'Partner key', name: 'Integration Partners' });
    const own = await appTester(ZapierApp.authentication.test, { authData: { apiKey: storefrontKey.key, apiSecret: storefrontKey.secret, baseUrl: apiUrl } });
    expect(own).toMatchObject({ kind: 'Storefront key' });
    await expect(appTester(ZapierApp.authentication.test, { authData: { apiKey: storefrontKey.key, apiSecret: 'wrong', baseUrl: apiUrl } })).rejects.toThrow('did not accept');
  });

  it("lists a partner key's storefronts, and none for a storefront key", async () => {
    const list = await appTester(ZapierApp.triggers.storefronts.operation.perform, { authData: authData() });
    expect(list).toEqual([{ id: t.productId, name: 'Example storefront' }]);
    const own = await appTester(ZapierApp.triggers.storefronts.operation.perform, {
      authData: { apiKey: storefrontKey.key, apiSecret: storefrontKey.secret, baseUrl: apiUrl },
    });
    expect(own).toEqual([]);
  });

  it('subscribes the Zap, and passes on the signed tenant.ready', async () => {
    const trigger = ZapierApp.triggers.site_event.operation;
    subscribeData = await appTester(trigger.performSubscribe, {
      authData: authData(),
      targetUrl: `${receiverUrl}/zapier`,
      inputData: { storefront: t.productId, event: 'tenant.ready' },
    });
    expect(subscribeData).toMatchObject({ id: expect.any(String), secret: expect.stringMatching(/^whsec_/), eventTypes: ['tenant.ready'] });

    const created = await appTester(ZapierApp.creates.create_site.operation.perform, {
      authData: authData(),
      inputData: { storefront: t.productId, name: 'Kettle and Crumb', externalId: 'zap-1', email: 'hi@kettle.example', role: 'administrator', size: 'small' },
    });
    expect(created).toMatchObject({ externalId: 'zap-1', url: `https://${created.baseDomain}` });

    const hit = await delivery('/zapier', 'tenant.ready');
    // Zapier hands hook headers over in Camel-Case with an Http- prefix.
    const rawHeaders = Object.fromEntries(
      Object.entries(hit.headers).map(([k, v]) => [`Http-${k.replace(/(^|-)([a-z])/g, (_m, d, c) => d + c.toUpperCase())}`, v]),
    );
    const bundle = (content: string) => ({ authData: authData(), subscribeData, rawRequest: { headers: rawHeaders, content }, cleanedRequest: JSON.parse(content) });
    const items = await appTester(trigger.perform, bundle(hit.body));
    expect(items).toEqual([
      expect.objectContaining({ id: hit.headers['webhook-id'], event: 'tenant.ready', externalId: 'zap-1', name: 'Kettle and Crumb', url: `https://${created.baseDomain}` }),
    ]);
    expect(await appTester(trigger.perform, bundle(hit.body.replace('Kettle', 'Kettlebell')))).toEqual([]);

    const samples = await appTester(trigger.performList, { authData: authData(), inputData: { storefront: t.productId, event: 'tenant.ready' } });
    expect(samples[0]).toMatchObject({ event: 'tenant.ready', siteId: expect.any(String) });
  });

  it('finds, suspends, resumes and deletes the site', async () => {
    const inputData = { storefront: t.productId, externalId: 'zap-1' };
    const [site] = await appTester(ZapierApp.searches.find_site.operation.perform, { authData: authData(), inputData });
    expect(site).toMatchObject({ externalId: 'zap-1', url: expect.stringMatching(/^https:\/\//) });
    expect(await appTester(ZapierApp.searches.find_site.operation.perform, { authData: authData(), inputData: { storefront: t.productId, externalId: 'nope' } })).toEqual([]);

    // A partner key without a storefront gets the API's own explanation.
    await expect(appTester(ZapierApp.searches.find_site.operation.perform, { authData: authData(), inputData: { externalId: 'zap-1' } })).rejects.toThrow('productId is required');

    expect(await appTester(ZapierApp.creates.suspend_site.operation.perform, { authData: authData(), inputData: { ...inputData, takeBackup: false } })).toMatchObject({
      externalId: 'zap-1',
      scheduled: true,
    });
    await waitFor(async () => (await appTester(ZapierApp.searches.find_site.operation.perform, { authData: authData(), inputData }))[0]?.isSuspended);
    await waitFor(async () => (await appTester(ZapierApp.searches.find_site.operation.perform, { authData: authData(), inputData }))[0]?.statusCode === 1);
    expect(await appTester(ZapierApp.creates.resume_site.operation.perform, { authData: authData(), inputData: { storefront: t.productId, siteId: site.id } })).toMatchObject({ tenantId: site.id });
    await waitFor(async () => (await appTester(ZapierApp.searches.find_site.operation.perform, { authData: authData(), inputData }))[0]?.isSuspended === false);
    await waitFor(async () => (await appTester(ZapierApp.searches.find_site.operation.perform, { authData: authData(), inputData }))[0]?.statusCode === 1);
    expect(await appTester(ZapierApp.creates.delete_site.operation.perform, { authData: authData(), inputData })).toMatchObject({ externalId: 'zap-1', scheduled: true });
  });

  it('passes on Notify the Owner only when it is on', async () => {
    const create = (externalId: string, extra: object) =>
      appTester(ZapierApp.creates.create_site.operation.perform, { authData: authData(), inputData: { storefront: t.productId, name: 'Zap Notify', externalId, email: 'z@example.com', ...extra } });
    await create('zap-quiet', { notifyOwner: false });
    await create('zap-told', { notifyOwner: true });
    expect(await notifyFlag('zap-quiet')).toBeUndefined();
    expect(await notifyFlag('zap-told')).toBe(true);
  });

  it('unsubscribes the Zap', async () => {
    await appTester(ZapierApp.triggers.site_event.operation.performUnsubscribe, { authData: authData(), subscribeData, inputData: { storefront: t.productId } });
    expect((await t.call('GET', `/v1/webhooks/${subscribeData.id}`)).status).toBe(404);
    // A second unsubscribe, for an endpoint already gone, is fine.
    await appTester(ZapierApp.triggers.site_event.operation.performUnsubscribe, { authData: authData(), subscribeData, inputData: { storefront: t.productId } });
  });
});

// ---------------------------------------------------------------- Make

describe('Make app', () => {
  const makeDir = new URL('make/', root);
  const readJsonc = (rel: string) =>
    JSON.parse(
      readFileSync(new URL(rel, makeDir), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n'),
    );
  const app = readJsonc('makecomapp.json');
  const spec = parse(readFileSync(new URL('../openapi/waas-provisioning-api.yaml', import.meta.url), 'utf8'));
  const hooks = parse(readFileSync(new URL('../openapi/webhooks.yaml', import.meta.url), 'utf8'));

  it('lists every code file it has, and every file it lists exists and parses', () => {
    const listed = new Set<string>(Object.values(app.generalCodeFiles).filter(Boolean) as string[]);
    for (const group of Object.values(app.components) as Record<string, any>[]) {
      for (const component of Object.values(group)) {
        for (const file of Object.values(component.codeFiles ?? {})) if (file) listed.add(file as string);
      }
    }
    for (const file of listed) if (file.endsWith('json') || file.endsWith('jsonc')) expect(() => readJsonc(file), file).not.toThrow();
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)).map((x) => `${f}/${x}`) : [f]));
    const onDisk = walk(makeDir.pathname).filter((f) => !['makecomapp.json', '.gitignore', 'deploy.mjs'].includes(f));
    expect(onDisk.sort()).toEqual([...listed].sort());
  });

  it('sends only fields the API knows, and asks only for events it sends', () => {
    const create = readJsonc(app.components.module.createSite.codeFiles.communication);
    const known = Object.keys(spec.components.schemas.CreateTenantParams.properties);
    for (const field of Object.keys(create.body)) expect(known, field).toContain(field);

    const params = readJsonc(app.components.webhook.siteEvents.codeFiles.params);
    const events = hooks.components.schemas.WebhookEventType.enum as string[];
    for (const option of params[0].options) expect(events).toContain(option.value);
    expect(params[0].default).toEqual(['tenant.ready']);

    // The same event list in all three.
    const n8nEvents = n8n.shared.SITE_EVENTS.map((e: { value: string }) => e.value).sort();
    expect(params[0].options.map((o: { value: string }) => o.value).sort()).toEqual(n8nEvents);
    expect(Object.keys(ZapierApp.triggers.site_event.operation.inputFields[1].choices).sort()).toEqual(n8nEvents);
  });

  it('calls only routes the API has', () => {
    const paths = new Set(Object.keys(spec.paths).map((p) => p.replace(/^\/v1/, '')));
    paths.add('/webhooks').add('/webhooks/{id}');
    for (const [id, module] of Object.entries(app.components.module) as [string, any][]) {
      const url = readJsonc(module.codeFiles.communication).url.replace(/\{\{[^}]+\}\}/g, '{id}');
      expect(paths, id).toContain(url);
    }
    const detach = readJsonc(app.components.webhook.siteEvents.codeFiles.detach).url.replace(/\{\{[^}]+\}\}/g, '{id}');
    expect(paths).toContain(detach);
  });
});

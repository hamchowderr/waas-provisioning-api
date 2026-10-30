// The AnyPress app for HighLevel (src/highlevel.ts): its key headers, actions, trigger subscriptions,
// the OAuth install, and trigger deliveries with the sub-account's token, against a fake HighLevel.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../src/keys.ts';
import { Status } from '../src/status.ts';
import { setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let t: TestContext;
let server: Server;
let base: string;
let received: Received[] = [];
let keyHeaders: Record<string, string>;

beforeAll(async () => {
  t = await setup();
  // HighLevel: its OAuth token calls and the triggers' targetUrl.
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      const form = new URLSearchParams(body);
      if (req.url === '/oauth/token' && form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code') return res.writeHead(400).end('{"error":"invalid_grant"}');
        return res.end(JSON.stringify({ access_token: 'agency-token', refresh_token: 'agency-refresh', expires_in: 86399, userType: 'Company', companyId: 'company-1' }));
      }
      if (req.url === '/oauth/locationToken') {
        if (req.headers.authorization !== 'Bearer agency-token') return res.writeHead(401).end('{}');
        return res.end(JSON.stringify({ access_token: `location-token-${form.get('locationId')}`, expires_in: 86399, userType: 'Location', companyId: form.get('companyId'), locationId: form.get('locationId') }));
      }
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.deps.config.webhooks!.highlevel = { clientId: 'client-1', clientSecret: 'client-secret', apiUrl: base };

  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });

  const { key, secret } = await createApiKey(t.pool, t.productId);
  keyHeaders = { 'X-AnyPress-Key': key, 'X-AnyPress-Secret': secret };
});
afterAll(async () => {
  server.close();
  await t.close();
});

const app = (method: string, path: string, body?: unknown, headers: Record<string, string> = keyHeaders) =>
  t.call(method, path, { body, auth: null, headers });

const ready = (siteId: string) =>
  waitFor(async () => ((await (await t.call('GET', `/v1/tenants?tenantId=${siteId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);

describe('signing in', () => {
  it('takes the key and secret as headers on /v1/apps only', async () => {
    const account = await app('GET', '/v1/apps/account');
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({ id: t.productId, name: 'Example storefront', type: 'storefront' });
    expect((await app('GET', '/v1/tenants')).status).toBe(403);
    expect((await app('GET', '/v1/apps/account', undefined, { ...keyHeaders, 'X-AnyPress-Secret': 'wrong' })).status).toBe(403);
    expect(await (await app('GET', '/v1/apps/storefronts')).json()).toEqual({ options: [{ label: 'Example storefront', value: t.productId }] });
  });
});

describe('actions', () => {
  let siteId: string;

  it('creates a site named by the contact, once per contact', async () => {
    const call = { data: { name: 'Rose and Fern', email: 'owner@roseandfern.example' }, extras: { locationId: 'loc-1', contactId: 'contact42', workflowId: 'wf-1' }, meta: { key: 'create_site', version: '1' } };
    const res = await app('POST', '/v1/apps/actions/create-site', call);
    expect(res.status).toBe(200);
    const site = (await res.json()) as Record<string, unknown>;
    expect(site).toMatchObject({ externalId: 'contact42', name: 'Rose and Fern' });
    expect(site.url).toBe(`https://${site.domainName}`);
    siteId = site.siteId as string;
    // The workflow ran twice: the same site.
    expect(((await (await app('POST', '/v1/apps/actions/create-site', call)).json()) as { siteId: string }).siteId).toBe(siteId);
    await ready(siteId);
  });

  it('gets, suspends, resumes and deletes it', async () => {
    const got = await app('POST', '/v1/apps/actions/get-site', { data: { externalId: 'contact42' } });
    expect(await got.json()).toMatchObject({ siteId, statusName: 'Done', isSuspended: false });
    expect((await app('POST', '/v1/apps/actions/suspend-site', { data: { siteId } })).status).toBe(200);
    await ready(siteId);
    expect((await (await app('POST', '/v1/apps/actions/get-site', { data: { siteId } })).json()) as { isSuspended: boolean }).toMatchObject({ isSuspended: true });
    expect((await app('POST', '/v1/apps/actions/resume-site', { data: { siteId } })).status).toBe(200);
    await ready(siteId);
    const deleted = await app('POST', '/v1/apps/actions/delete-site', { data: { externalId: 'contact42' } });
    expect(await deleted.json()).toMatchObject({ siteId, deleted: true });
  });

  it('answers what is wrong', async () => {
    expect((await app('POST', '/v1/apps/actions/create-site', { data: {} })).status).toBe(400);
    expect((await app('POST', '/v1/apps/actions/get-site', { data: {} })).status).toBe(400);
    expect((await app('POST', '/v1/apps/actions/get-site', { data: { externalId: 'nobody' } })).status).toBe(404);
    expect((await app('POST', '/v1/apps/actions/launch-rocket', { data: {} })).status).toBe(404);
  });

  it('takes a partner key with the storefront it names', async () => {
    const admin = await t.call('POST', '/admin/resellers', { auth: `Bearer ${TEST_ADMIN_TOKEN}`, body: { name: 'Agency', productIds: [t.productId], billingEmail: 'billing@agency.example' } });
    const resellerId = ((await admin.json()) as { id: string }).id;
    const { key, secret } = await createApiKey(t.pool, { resellerId });
    const partner = { 'X-AnyPress-Key': key, 'X-AnyPress-Secret': secret };
    expect(await (await app('GET', '/v1/apps/account', undefined, partner)).json()).toMatchObject({ id: resellerId, type: 'partner' });
    expect(await (await app('GET', '/v1/apps/storefronts', undefined, partner)).json()).toEqual({ options: [{ label: 'Example storefront', value: t.productId }] });
    expect((await app('POST', '/v1/apps/actions/get-site', { data: { externalId: 'x' } }, partner)).status).toBe(400);
    const other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Someone else') RETURNING id")).rows[0]!.id;
    expect((await app('POST', '/v1/apps/actions/get-site', { data: { externalId: 'x', storefront: other } }, partner)).status).toBe(403);
    const named = await app('POST', '/v1/apps/actions/create-site', { data: { name: 'Partner Site', email: 'owner@example.com', storefront: t.productId }, extras: { contactId: 'contact77' } }, partner);
    expect(named.status).toBe(200);
    const header = await app('POST', '/v1/apps/actions/get-site', { data: { externalId: 'contact77' } }, { ...partner, 'X-AnyPress-Storefront': t.productId });
    expect(await header.json()).toMatchObject({ name: 'Partner Site' });
    await ready(((await named.json()) as { siteId: string }).siteId);
  });

  it("passes on Notify the Owner only when it is yes", async () => {
    const flag = async (contactId: string) =>
      (await t.pool.query("SELECT j.data->'notifyOwner' AS flag FROM pgboss.job j JOIN tenants x ON x.id::text = j.data->>'tenantId' WHERE j.data->>'type' = 'tenant.create' AND x.external_id = $1", [contactId])).rows[0]?.flag ?? undefined;
    for (const [contactId, notifyOwner] of [['ghl-quiet', 'no'], ['ghl-told', 'yes']]) {
      const res = await app('POST', '/v1/apps/actions/create-site', { data: { name: 'Notify Site', email: 'n@example.com', notifyOwner }, extras: { contactId } });
      expect(res.status).toBe(200);
      await ready(((await res.json()) as { siteId: string }).siteId);
    }
    expect(await flag('ghl-quiet')).toBeUndefined();
    expect(await flag('ghl-told')).toBe(true);
  });
});

describe('install and triggers', () => {
  it('keeps the agency token from the install', async () => {
    const bad = await t.app.request('/apps/oauth/callback?code=bad-code');
    expect(bad.status).toBe(400);
    const res = await t.app.request('/apps/oauth/callback?code=good-code');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('AnyPress is connected');
    const { rows } = await t.pool.query("SELECT * FROM highlevel_tokens WHERE user_type = 'Company'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ company_id: 'company-1' });
    expect(rows[0].access_token).not.toContain('agency-token');
    const exchange = received.find((r) => r.path === '/oauth/token' && r.body.includes('good-code'))!;
    expect(new URLSearchParams(exchange.body).get('client_secret')).toBe('client-secret');
  });

  it('sends a ready site to the trigger with the sub-account token, and stops when it is removed', async () => {
    received = [];
    const subscribe = (eventType: string, filters: unknown[] = []) =>
      app('POST', '/v1/apps/triggers', {
        triggerData: { id: 'trigger-1', key: 'site_event', eventType, targetUrl: `${base}/workflows-marketplace/triggers/execute/abc/trigger-1`, filters },
        meta: { key: 'site_event', version: '1' },
        extras: { locationId: 'loc-9', companyId: 'company-1', workflowId: 'wf-9' },
      });
    expect((await subscribe('CREATED')).status).toBe(200);
    expect((await subscribe('UPDATED', [{ field: 'event', operator: '==', value: 'ready' }])).status).toBe(200);
    const { rows } = await t.pool.query("SELECT event_types FROM webhook_endpoints WHERE kind = 'highlevel'");
    expect(rows).toEqual([{ event_types: ['tenant.ready'] }]);

    const created = await app('POST', '/v1/apps/actions/create-site', { data: { name: 'Trigger Site', email: 'owner@example.com' }, extras: { contactId: 'contact9' } });
    const siteId = ((await created.json()) as { siteId: string }).siteId;
    const hit = await waitFor(async () => received.find((r) => r.path.endsWith('/trigger-1')));
    expect(hit.headers.authorization).toBe('Bearer location-token-loc-9');
    expect(JSON.parse(hit.body)).toMatchObject({ event: 'tenant.ready', siteId, externalId: 'contact9', name: 'Trigger Site', url: expect.stringMatching(/^https:\/\//) });
    // The sub-account token was made from the agency's and kept.
    expect((await t.pool.query("SELECT 1 FROM highlevel_tokens WHERE user_type = 'Location' AND location_id = 'loc-9'")).rowCount).toBe(1);

    expect((await subscribe('DELETED')).status).toBe(200);
    expect((await t.pool.query("SELECT 1 FROM webhook_endpoints WHERE kind = 'highlevel'")).rowCount).toBe(0);
  });

  it('never sends the token anywhere but HighLevel', async () => {
    t.deps.config.webhooks!.highlevel = { clientId: 'client-1', clientSecret: 'client-secret', apiUrl: 'https://services.leadconnectorhq.example' };
    received = [];
    await app('POST', '/v1/apps/triggers', {
      triggerData: { id: 'trigger-2', eventType: 'CREATED', targetUrl: `${base}/elsewhere`, filters: [] },
      extras: { locationId: 'loc-9', companyId: 'company-1' },
    });
    await app('POST', '/v1/apps/actions/create-site', { data: { name: 'Elsewhere Site', email: 'owner@example.com' }, extras: { contactId: 'contact10' } });
    const hit = await waitFor(async () => received.find((r) => r.path === '/elsewhere' && JSON.parse(r.body).event === 'tenant.ready'));
    expect(hit.headers.authorization).toBeUndefined();
    t.deps.config.webhooks!.highlevel = { clientId: 'client-1', clientSecret: 'client-secret', apiUrl: base };
  });
});

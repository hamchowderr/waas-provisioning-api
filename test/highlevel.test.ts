// The AnyPress app for HighLevel (src/highlevel.ts): its key headers, actions, trigger subscriptions,
// the OAuth install, and trigger deliveries with the sub-account's token, against a fake HighLevel.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SITE_LINK_ROUTE } from '../src/highlevel.ts';
import { createApiKey } from '../src/keys.ts';
import { signSiteRequest, siteKey, siteKeyMaster } from '../src/sitekeys.ts';
import { Status } from '../src/status.ts';
import { setup, TEST_ADMIN_TOKEN, TEST_SECRETS_KEY, waitFor, type TestContext } from './helpers.ts';

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

  it('says when the install sent no key, or something that is not a key', async () => {
    const none = await app('POST', '/v1/apps/actions/create-site', { data: {} }, {});
    expect(none.status).toBe(403);
    expect(((await none.json()) as { message: string }).message).toMatch(/has no API key for this account/);
    const pasted = await app('GET', '/v1/apps/account', undefined, { 'X-AnyPress-Key': '{{userData.api_key}}', 'X-AnyPress-Secret': 'x' });
    expect(((await pasted.json()) as { message: string }).message).toMatch(/is not an AnyPress API key/);
    const wrong = await app('GET', '/v1/apps/account', undefined, { ...keyHeaders, 'X-AnyPress-Secret': 'wrong' });
    expect(((await wrong.json()) as { message: string }).message).toBe('Invalid API key or secret');
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

  it("makes the storefront a HighLevel agency's, whose sites get the HighLevel site type", async () => {
    expect((await t.pool.query('SELECT highlevel_agency FROM products WHERE id = $1', [t.productId])).rows[0].highlevel_agency).toBe(true);
    const roles = async (id: string) => (await t.pool.query('SELECT php_constants FROM tenants WHERE id = $1', [id])).rows[0].php_constants.ANYPRESS_TENANT_ROLES;
    expect(await roles(siteId)).toEqual({ value: 'highlevel', isPrivate: false });
    // Create site's siteType picks another one.
    const other = await app('POST', '/v1/apps/actions/create-site', { data: { name: 'Typed', email: 'typed@example.com', siteType: 'website' }, extras: { locationId: 'loc-1', contactId: 'contact43' } });
    const typedId = ((await other.json()) as { siteId: string }).siteId;
    expect(await roles(typedId)).toEqual({ value: 'website', isPrivate: false });
    await ready(typedId);
    expect((await app('POST', '/v1/apps/actions/delete-site', { data: { siteId: typedId } })).status).toBe(200);
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

  it('moves a trigger to the new storefront when the same sub-account reinstalls with another key', async () => {
    const other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Old storefront') RETURNING id")).rows[0]!.id;
    const old = await createApiKey(t.pool, other);
    const oldHeaders = { 'X-AnyPress-Key': old.key, 'X-AnyPress-Secret': old.secret };
    const subscribe = (headers: Record<string, string>, locationId: string, eventType = 'CREATED') =>
      app('POST', '/v1/apps/triggers', {
        triggerData: { id: 'trigger-moved', eventType, targetUrl: `${base}/workflows-marketplace/triggers/execute/abc/trigger-moved`, filters: [] },
        extras: { locationId, companyId: 'company-1' },
      }, headers);
    expect((await subscribe(oldHeaders, 'loc-moved')).status).toBe(200);
    // Another sub-account can't take it.
    expect((await subscribe(keyHeaders, 'loc-stranger')).status).toBe(403);
    // The same sub-account, now on this storefront, takes it over.
    expect((await subscribe(keyHeaders, 'loc-moved', 'UPDATED')).status).toBe(200);
    const { rows } = await t.pool.query("SELECT product_id FROM webhook_endpoints WHERE highlevel_trigger_id = 'trigger-moved'");
    expect(rows).toEqual([{ product_id: t.productId }]);
    expect((await subscribe(keyHeaders, 'loc-moved', 'DELETED')).status).toBe(200);
    expect((await t.pool.query("SELECT 1 FROM webhook_endpoints WHERE highlevel_trigger_id = 'trigger-moved'")).rowCount).toBe(0);
  });

  it("keeps each sub-account to its own sites, and its trigger to their events", async () => {
    received = [];
    const subscribe = (id: string, locationId: string) =>
      app('POST', '/v1/apps/triggers', {
        triggerData: { id, key: 'site_event', eventType: 'CREATED', targetUrl: `${base}/workflows-marketplace/triggers/execute/abc/${id}`, filters: [] },
        extras: { locationId, companyId: 'company-1', workflowId: 'wf' },
      });
    expect((await subscribe('trigger-a', 'loc-a')).status).toBe(200);
    expect((await subscribe('trigger-b', 'loc-b')).status).toBe(200);

    const made = await app('POST', '/v1/apps/actions/create-site', {
      data: { name: 'Sub-account Site', email: 'owner@example.com' },
      extras: { contactId: 'contact-a1', locationId: 'loc-a', companyId: 'company-1' },
    });
    const siteId = ((await made.json()) as { siteId: string }).siteId;
    const { rows } = await t.pool.query('SELECT highlevel_location_id, highlevel_company_id FROM tenants WHERE id = $1', [siteId]);
    expect(rows[0]).toEqual({ highlevel_location_id: 'loc-a', highlevel_company_id: 'company-1' });

    await waitFor(async () => received.find((r) => r.path.endsWith('/trigger-a')));
    await ready(siteId);
    expect(received.some((r) => r.path.endsWith('/trigger-b'))).toBe(false);

    // Another sub-account can't see or change it; its own can, and so can a call that names no sub-account.
    const other = await app('POST', '/v1/apps/actions/suspend-site', { data: { siteId }, extras: { locationId: 'loc-b' } });
    expect(other.status).toBe(404);
    expect((await app('POST', '/v1/apps/actions/get-site', { data: { siteId }, extras: { locationId: 'loc-a' } })).status).toBe(200);
    expect((await app('POST', '/v1/apps/actions/delete-site', { data: { siteId }, extras: { locationId: 'loc-a' } })).status).toBe(200);
    await t.pool.query("DELETE FROM webhook_endpoints WHERE kind = 'highlevel'");
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

describe("a HighLevel site's CRM link", () => {
  const keyOf = (storeId: string) => siteKey(siteKeyMaster(TEST_SECRETS_KEY), storeId);
  const ask = (site: string, key: string | null) => {
    const raw = JSON.stringify({ site });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers['X-AnyPress-Signature'] = signSiteRequest(key, 'POST', SITE_LINK_ROUTE, raw);
    return t.call('POST', SITE_LINK_ROUTE, { auth: null, headers, body: raw });
  };
  const make = async (name: string, extras: Record<string, string>) => {
    const made = await app('POST', '/v1/apps/actions/create-site', { data: { name, email: 'owner@example.com' }, extras });
    const siteId = ((await made.json()) as { siteId: string }).siteId;
    await ready(siteId);
    const [site] = (await (await t.call('GET', `/v1/tenants?tenantId=${siteId}`)).json()) as { domainName: string }[];
    return { siteId, domain: site!.domainName };
  };

  it("gives a sub-account's site that sub-account and its token, signed requests only", async () => {
    const { siteId, domain } = await make('Linked Site', { contactId: 'contact-c1', locationId: 'loc-c', companyId: 'company-1' });
    expect((await ask(domain, null)).status).toBe(403);
    expect((await ask(domain, keyOf('another-store'))).status).toBe(403);

    const res = await ask(domain.toUpperCase(), keyOf(siteId));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const answer = (await res.json()) as { crm: string; locationId: string; accessToken: string; expiresAt: string };
    expect(answer).toMatchObject({ crm: 'highlevel', locationId: 'loc-c', accessToken: 'location-token-loc-c' });
    expect(new Date(answer.expiresAt).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  it('answers crm null for a site with no sub-account', async () => {
    const { siteId, domain } = await make('Unlinked Site', { contactId: 'contact-c2' });
    const res = await ask(domain, keyOf(siteId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ crm: null });
  });
});

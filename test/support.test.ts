// Support tickets (src/support.ts, docs/support.md): the person signed in files a ticket with whoever helps them.
// The desk here is a fake AnyPress Host that checks the signature the way its SupportDesk does; toSend is stubbed.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WaasClient } from '../sdk/typescript/src/index.ts';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createWaasMcpServer } from '../mcp/src/server.ts';
import { Status } from '../src/status.ts';
import { generateSecret, sign } from '../src/webhooks.ts';
import { setup, waitFor, type TestContext, OWNER } from './helpers.ts';

const MAIL = { key: 'tsend_test_key', from: 'support@app.waas.example', plainFrom: 'no-reply@app.waas.example', brand: 'AnyPress', supportEmail: 'support@app.waas.example' };
const DESK = 'https://shop.waas.example';

let t: TestContext;
let secret: string;
let tenantId: string;
let userId: string;
const realFetch = globalThis.fetch;
const emails: any[] = [];
const deskCalls: { body: any; signatureOk: boolean }[] = [];
let deskAnswer: (body: any) => { status: number; body: unknown } = () => ({ status: 500, body: null });

/** AnyPress Host's check (WebhookReceiver::verify): HMAC over "<id>.<timestamp>.<body>" with the endpoint's secret. */
const signatureOk = (headers: Headers, body: string) =>
  headers.get('webhook-signature') === sign(secret, headers.get('webhook-id')!, Number(headers.get('webhook-timestamp')), body) &&
  Math.abs(Date.now() / 1000 - Number(headers.get('webhook-timestamp'))) < 300;

/** A /v1 call as a signed-in person (as the MCP server and the dashboard make them). */
const as = (internalAuth: { productId: string; userId?: string; storeTenantId?: string }, method: string, path: string, body?: unknown) =>
  t.app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { internalAuth });

beforeAll(async () => {
  t = await setup();
  t.deps.config.auth = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789', brand: 'AnyPress', mail: MAIL };
  t.deps.config.support = { deskUrl: DESK };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.tosend.com/')) return realFetch(input, init);
    emails.push(JSON.parse(String(init!.body)));
    return new Response(JSON.stringify({ message_id: 'm1' }), { status: 200 });
  });
  t.deps.supportFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(`${DESK}/wp-json/anypress-host/v1/support`);
    const text = String(init!.body);
    const body = JSON.parse(text);
    deskCalls.push({ body, signatureOk: signatureOk(new Headers(init!.headers), text) });
    const answer = deskAnswer(body);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  // The shop's AnyPress Host registered its webhook endpoint, as it does when it connects.
  secret = generateSecret();
  await t.pool.query('INSERT INTO webhook_endpoints (product_id, url, secret) VALUES ($1, $2, $3)', [t.productId, `${DESK}/wp-json/anypress-host/v1/webhook`, t.deps.secrets.encrypt(secret)]);

  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  const created = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Rose Florist', externalId: 'rose' } });
  expect(created.status).toBe(200);
  tenantId = ((await created.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', '/v1/tenants?externalId=rose')).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);

  userId = (await t.pool.query(`INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('Dana Seller', 'Dana@Seller.example', true) RETURNING id`)).rows[0].id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

const TICKET = { id: 41, title: 'Booking page error', status: 'new', createdAt: '2026-11-10T03:20:00+00:00', updatedAt: '2026-11-10T03:20:00+00:00', url: `${DESK}/support/?ticket_id=41` };

describe('support tickets', () => {
  it('needs a signed-in person: an API key alone gets 400', async () => {
    const res = await t.call('POST', '/v1/support/tickets', { body: { title: 'Help', content: 'Please' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/signed-in person/);
  });

  it('files a website owner’s ticket at the desk, signed, as the store’s owner email, with the store’s details', async () => {
    deskCalls.splice(0);
    deskAnswer = () => ({ status: 201, body: { ticket: TICKET } });
    const res = await as({ productId: t.productId, storeTenantId: tenantId }, 'POST', '/v1/support/tickets', { title: 'Booking page error', content: 'It says Something went wrong.' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sentTo: 'desk', ticket: TICKET });
    expect(deskCalls).toHaveLength(1);
    const call = deskCalls[0]!;
    expect(call.signatureOk).toBe(true);
    expect(call.body).toMatchObject({ action: 'open', customer: { email: 'owner@example.com', name: 'Rose Florist owner' }, title: 'Booking page error' });
    expect(call.body.content).toContain('It says Something went wrong.');
    expect(call.body.content).toContain('Website: Rose Florist');
    expect(call.body.content).toContain(`Store id: ${tenantId} (rose)`);
    expect(call.body.content).toContain('(website owner)');
  });

  it('lists, reads, replies to and closes a dashboard user’s own tickets through the desk', async () => {
    deskCalls.splice(0);
    deskAnswer = (body) =>
      body.action === 'list' ? { status: 200, body: { tickets: [TICKET] } } : body.ticketId === 41 ? { status: 200, body: { ticket: { ...TICKET, messages: [] } } } : { status: 404, body: { code: 'not_found' } };
    const who = { productId: t.productId, userId };
    expect(await (await as(who, 'GET', '/v1/support/tickets')).json()).toEqual([TICKET]);
    expect((await as(who, 'GET', '/v1/support/tickets/41')).status).toBe(200);
    expect((await as(who, 'POST', '/v1/support/tickets/41/replies', { content: 'Still broken' })).status).toBe(200);
    expect((await as(who, 'POST', '/v1/support/tickets/41/close')).status).toBe(200);
    expect((await as(who, 'GET', '/v1/support/tickets/7')).status).toBe(404);
    expect(deskCalls.map((c) => [c.body.action, c.body.customer.email, c.body.ticketId, c.body.content])).toEqual([
      ['list', 'dana@seller.example', undefined, undefined],
      ['get', 'dana@seller.example', 41, undefined],
      ['reply', 'dana@seller.example', 41, 'Still broken'],
      ['close', 'dana@seller.example', 41, undefined],
      ['get', 'dana@seller.example', 7, undefined],
    ]);
    expect(deskCalls.every((c) => c.signatureOk)).toBe(true);
  });

  it('emails the ticket to the support address when the desk does not answer', async () => {
    emails.splice(0);
    deskAnswer = () => ({ status: 500, body: null });
    const res = await as({ productId: t.productId, userId }, 'POST', '/v1/support/tickets?externalId=rose', { title: 'Down', content: 'The site is down' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sentTo: 'email', email: 'support@app.waas.example', helper: 'AnyPress' });
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: [{ email: 'support@app.waas.example' }], reply_to: { email: 'dana@seller.example', name: 'Dana Seller' }, subject: 'Support request: Down' });
    expect(emails[0].text).toContain('Website: Rose Florist');
  });

  it('sends a reseller’s client to the reseller first, by email under its brand', async () => {
    emails.splice(0);
    deskCalls.splice(0);
    const resellerId = (await t.pool.query("INSERT INTO resellers (name) VALUES ('Summit Partners') RETURNING id")).rows[0].id;
    await t.pool.query('UPDATE products SET reseller_id = $1 WHERE id = $2', [resellerId, t.productId]);
    await t.pool.query("INSERT INTO dashboard_brands (reseller_id, name, support_email) VALUES ($1, 'Summit Web Studio', 'help@summit.example')", [resellerId]);
    try {
      const res = await as({ productId: t.productId, storeTenantId: tenantId }, 'POST', '/v1/support/tickets', { title: 'Help', content: 'My menu vanished' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ sentTo: 'email', email: 'help@summit.example', helper: 'Summit Web Studio' });
      expect(deskCalls).toEqual([]);
      expect(emails[0]).toMatchObject({ to: [{ email: 'help@summit.example' }], from: { name: 'Summit Web Studio support' }, reply_to: { email: 'owner@example.com' } });

      // The reseller itself, signed in to the dashboard, still files with the platform.
      deskAnswer = () => ({ status: 201, body: { ticket: TICKET } });
      const own = await as({ productId: t.productId, userId }, 'POST', '/v1/support/tickets', { title: 'Billing', content: 'Question about my bill' });
      expect(await own.json()).toMatchObject({ sentTo: 'desk' });
    } finally {
      await t.pool.query('UPDATE products SET reseller_id = NULL WHERE id = $1', [t.productId]);
    }
  });

  it('offers the support tool to a store’s own connection, acting on its owner’s tickets', async () => {
    deskCalls.splice(0);
    deskAnswer = (body) => (body.action === 'list' ? { status: 200, body: { tickets: [TICKET] } } : { status: 201, body: { ticket: TICKET } });
    const waas = new WaasClient({
      baseUrl: 'http://in-process',
      apiKey: 'mcp',
      apiSecret: 'mcp',
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        return t.app.request(`${url.pathname}${url.search}`, init, { internalAuth: { productId: t.productId, storeTenantId: tenantId } });
      }) as typeof fetch,
    });
    const handler = createMcpHandler(() => createWaasMcpServer(waas, { scopes: ['site:read', 'site:write'], store: { tenantId } }));
    const authInfo = { token: 'test', clientId: 'test', scopes: ['site:read', 'site:write'] };
    const transport = new StreamableHTTPClientTransport(new URL('https://api.example.test/mcp/site'), {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => handler.fetch(new Request(input, init), { authInfo })) as typeof fetch,
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain('support');
    expect(tools).not.toContain('get_stores');
    const result = (await client.callTool({ name: 'support', arguments: { action: 'list' } })) as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text)).toEqual([TICKET]);
    expect(deskCalls[0]!.body.customer.email).toBe('owner@example.com');
    await client.close();
  });
});

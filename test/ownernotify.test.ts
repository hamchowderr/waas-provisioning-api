import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Status } from '../src/status.ts';
import { setup, waitFor, type TestContext, OWNER, TEST_ADMIN_TOKEN } from './helpers.ts';

const MAIL = { key: 'tsend_test_key', from: 'support@app.waas.example', plainFrom: 'no-reply@app.waas.example', brand: 'AnyPress' };

let t: TestContext;
const sent: { to: string; url: string; body: any }[] = [];
const realFetch = globalThis.fetch;

async function makeStore(name: string, extra: object = {}): Promise<string> {
  const res = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name, ...extra } });
  expect(res.status).toBe(200);
  const { externalId } = (await res.json()) as { externalId: string };
  const done = await waitFor(async () => {
    const tenant = ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as { id: string; statusCode: number }[])[0];
    return tenant?.statusCode === Status.Done ? tenant : null;
  });
  // The email goes out right after the store is marked done.
  await new Promise((r) => setTimeout(r, 300));
  return done.id;
}

const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
const notify = (tenantId: string, body: object) => t.call('POST', `/admin/tenants/${tenantId}/notify-owner`, { auth: ADMIN, body });

beforeAll(async () => {
  t = await setup();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.tosend.com/')) return realFetch(input, init);
    const body = JSON.parse(String(init!.body));
    sent.push({ to: body.to[0].email, url: /href="([^"]+)"/.exec(body.html)![1]!.replaceAll('&amp;', '&'), body });
    return new Response(JSON.stringify({ message_id: 'm1' }), { status: 200 });
  });
  t.deps.config.auth = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789', mail: MAIL };
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

describe("emailing the owner that their website is ready", () => {
  it('sends nothing unless asked, and records that none went', async () => {
    sent.splice(0);
    const tenantId = await makeStore('Quiet Shop');
    expect(sent).toEqual([]);
    const detail = (await (await t.call('GET', `/admin/tenants/${tenantId}`, { auth: ADMIN })).json()) as { ownerNotifiedAt: string | null };
    expect(detail.ownerNotifiedAt).toBeNull();
  });

  it('sends the owner one email with a link to set their password when notifyOwner is true', async () => {
    sent.splice(0);
    await makeStore('Rose Florist', { notifyOwner: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('owner@example.com');
    expect(sent[0]!.body.subject).toBe('Your website Rose Florist is ready');
    expect(sent[0]!.body.from).toEqual({ email: MAIL.from, name: 'AnyPress' });
    expect(sent[0]!.url).toMatch(/\/wp-login\.php\?action=rp&key=.+&login=owner$/);
    expect(sent[0]!.body.text).toContain('Your username is owner.');
  });

  it('records the email a create sent', async () => {
    const tenantId = await makeStore('Recorded Florist', { notifyOwner: true });
    const detail = (await (await t.call('GET', `/admin/tenants/${tenantId}`, { auth: ADMIN })).json()) as { ownerNotifiedTo: string | null; ownerNotifiedAt: string | null };
    expect(detail.ownerNotifiedTo).toBe('owner@example.com');
    expect(detail.ownerNotifiedAt).not.toBeNull();
  });

  it("sends in the storefront's brand, without the platform's name", async () => {
    await t.pool.query("INSERT INTO dashboard_brands (product_id, name, support_email) VALUES ($1, 'Summit Sites', 'help@summit.example')", [t.productId]);
    sent.splice(0);
    await makeStore('Summit Bakery', { notifyOwner: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.from).toEqual({ email: MAIL.plainFrom, name: 'Summit Sites' });
    expect(sent[0]!.body.text).not.toContain('AnyPress');
    expect(sent[0]!.body.text).toContain('help@summit.example');
  });

  it('refuses a notifyOwner that is not true or false', async () => {
    const res = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Odd', notifyOwner: 'yes' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/notifyOwner/);
  });
});

describe('sending the website-ready email later', () => {
  it('sends it for a store made without it, with a fresh set-password link', async () => {
    await t.pool.query('DELETE FROM dashboard_brands WHERE product_id = $1', [t.productId]);
    const tenantId = await makeStore('Later Bakery');
    sent.splice(0);
    const res = await notify(tenantId, { email: ' Owner@Example.com ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenantId, email: 'owner@example.com', sent: true });
    const detail = (await (await t.call('GET', `/admin/tenants/${tenantId}`, { auth: ADMIN })).json()) as { ownerNotifiedAt: string | null; ownerNotifiedTo: string | null };
    expect(detail.ownerNotifiedTo).toBe('owner@example.com');
    expect(Date.now() - Date.parse(detail.ownerNotifiedAt!)).toBeLessThan(60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('owner@example.com');
    expect(sent[0]!.body.subject).toBe('Your website Later Bakery is ready');
    expect(sent[0]!.url).toMatch(/\/wp-login\.php\?action=rp&key=.+&login=owner$/);
    expect(sent[0]!.body.text).toContain('Your username is owner.');
  });

  it("refuses an email the store has no WordPress user for, or that isn't an email", async () => {
    const tenantId = await makeStore('Wrong Owner Shop');
    sent.splice(0);
    const wrong = await notify(tenantId, { email: 'someone@example.com' });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { message: string }).message).toMatch(/no WordPress user/);
    expect((await notify(tenantId, { email: 'nope' })).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("sends to the owner's email the store was made with when none is given, and shows it on the store", async () => {
    const tenantId = await makeStore('Default Owner Shop');
    const before = (await (await t.call('GET', `/admin/tenants/${tenantId}`, { auth: ADMIN })).json()) as { ownerEmail: string | null };
    expect(before.ownerEmail).toBe('owner@example.com');
    sent.splice(0);
    const res = await notify(tenantId, {});
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(['owner@example.com']);
  });

  it('refuses a suspended store, and answers 404 for one that does not exist', async () => {
    const tenantId = await makeStore('Paused Shop');
    await t.pool.query('UPDATE tenants SET is_suspended = true WHERE id = $1', [tenantId]);
    expect((await notify(tenantId, { email: 'owner@example.com' })).status).toBe(409);
    expect((await notify('00000000-0000-4000-8000-000000000000', { email: 'owner@example.com' })).status).toBe(404);
  });
});

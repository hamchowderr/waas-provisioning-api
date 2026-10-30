import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Status } from '../src/status.ts';
import { setup, waitFor, type TestContext, OWNER } from './helpers.ts';

const MAIL = { key: 'tsend_test_key', from: 'support@app.waas.example', plainFrom: 'no-reply@app.waas.example', brand: 'AnyPress' };

let t: TestContext;
const sent: { to: string; url: string; body: any }[] = [];
const realFetch = globalThis.fetch;

async function makeStore(name: string, extra: object = {}) {
  const res = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name, ...extra } });
  expect(res.status).toBe(200);
  const { externalId } = (await res.json()) as { externalId: string };
  await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  // The email goes out right after the store is marked done.
  await new Promise((r) => setTimeout(r, 300));
}

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
  it('sends nothing unless asked', async () => {
    sent.splice(0);
    await makeStore('Quiet Shop');
    expect(sent).toEqual([]);
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

// Prospect finder results into a seller's CRM (src/prospectcrm.ts): the storefront's FluentCRM through a job and
// the store agent, and HighLevel through the seller's workflow webhook. Responses are validated against
// openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAjv } from '../src/openapi.ts';
import { crmInput, highLevelWebhook } from '../src/prospectcrm.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');
const valid = (name: string, value: unknown) => {
  const validate = ajv.compile({ $ref: `admin#/components/schemas/${name}` });
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
};

let t: TestContext;
let sellerProduct: string;
let storefrontId: string;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
const WEBHOOK = 'https://services.leadconnectorhq.com/hooks/loc123/webhook-trigger/abc-def';
const posted: Array<{ url: string; body: any }> = [];
let hlAnswer: () => Response = () => new Response('ok');

const settings = async () => (await t.call('GET', `/admin/products/${sellerProduct}/prospects/crm`, { auth: ADMIN })).json() as Promise<any>;
const add = (body: unknown) => t.call('POST', `/admin/products/${sellerProduct}/prospects/crm`, { auth: ADMIN, body });

const grace = { id: 'p-grace', name: 'Grace Church', type: 'Church', phone: '(614) 555-0100', email: 'Office@GraceChurch.example', website: 'https://gracechurch.example', address: '1 Main St, Columbus, OH', mapsUrl: 'https://maps.google.com/?cid=1', rating: 4.8, reviews: 120, hours: ['Sunday: 9:00 AM – 1:00 PM'], socials: [{ network: 'facebook', url: 'https://facebook.com/grace' }, { network: 'myspace', url: 'https://myspace.com/x' }] };
const hope = { id: 'p-hope', name: 'Hope Chapel', phone: '(614) 555-0101', email: null, website: null };

beforeAll(async () => {
  t = await setup();
  // The seller's product and its ready-made storefront: a store of the storefront product named after it.
  t.deps.config.storefrontProductId = t.productId;
  sellerProduct = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Seller') RETURNING id")).rows[0]!.id;
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => (await t.pool.query('SELECT status FROM versions WHERE id = $1', [versionId])).rows[0]?.status === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  const store = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Seller storefront' } });
  storefrontId = ((await store.json()) as { id: string }).id;
  await waitFor(async () => (await t.pool.query('SELECT status FROM tenants WHERE id = $1', [storefrontId])).rows[0]?.status === Status.Done);
  t.deps.crmFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return hlAnswer();
  }) as typeof fetch;
});
afterAll(async () => t?.close());

describe('reading what the dashboard sends', () => {
  it('keeps only usable fields, drops unknown networks and bad emails, and dedupes', () => {
    const input = crmInput({ prospects: [grace, { ...grace }, { ...hope, email: 'not an email' }], group: 'Churches', targets: ['fluentcrm', 'nope'] });
    expect(input.targets).toEqual(['fluentcrm']);
    expect(input.prospects).toHaveLength(2);
    expect(input.prospects[0]).toMatchObject({ email: 'office@gracechurch.example', socials: [{ network: 'facebook', url: 'https://facebook.com/grace' }] });
    expect(input.prospects[1]!.email).toBeNull();
    expect(() => crmInput({ prospects: [], targets: ['fluentcrm'] })).toThrow(/at least one/);
    expect(() => crmInput({ prospects: [grace], targets: [] })).toThrow(/FluentCRM, HighLevel/);
  });

  it("takes only HighLevel's own webhook addresses", () => {
    expect(highLevelWebhook(` ${WEBHOOK} `)).toBe(WEBHOOK);
    for (const bad of ['http://services.leadconnectorhq.com/hooks/x', 'https://evil.example/hooks/x', 'https://services.leadconnectorhq.com/v2/contacts', 'https://u:p@services.leadconnectorhq.com/hooks/x', 'nope']) {
      expect(() => highLevelWebhook(bad)).toThrow();
    }
  });
});

describe('sending prospects to a CRM', () => {
  it('says FluentCRM is only on ready-made storefronts, and HighLevel needs a webhook', async () => {
    await t.pool.query("UPDATE tenants SET external_id = 'not-a-storefront' WHERE id = $1", [storefrontId]);
    const before = await settings();
    valid('ProspectCrm', before);
    expect(before).toMatchObject({ fluentcrm: { available: false }, highlevel: { connected: false } });
    const res = await add({ prospects: [grace], targets: ['fluentcrm', 'highlevel'] });
    const body = (await res.json()) as any;
    valid('ProspectCrmResult', body);
    expect(body.fluentcrm.unavailable).toMatch(/ready-made/);
    expect(body.highlevel.unavailable).toMatch(/webhook/);
    await t.pool.query('UPDATE tenants SET external_id = $2 WHERE id = $1', [storefrontId, `storefront-${sellerProduct}`]);
    expect((await settings()).fluentcrm).toEqual({ available: true, reason: null });
  });

  it("writes businesses with an email into the storefront's FluentCRM once, tagged by group", async () => {
    const res = await add({ prospects: [grace, hope], group: 'Churches', targets: ['fluentcrm'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    valid('ProspectCrmResult', body);
    expect(body.fluentcrm).toEqual({ queued: 1, already: 0, noEmail: 1, unavailable: null });
    await waitFor(async () => (await t.pool.query("SELECT status FROM prospect_crm WHERE place_id = 'p-grace'")).rows[0]?.status === Status.Done);
    const crm = t.provisioner.stores.get(storefrontId)!.crm!;
    expect(Object.keys(crm)).toEqual(['office@gracechurch.example']);
    expect(crm['office@gracechurch.example']).toMatchObject({ name: 'Grace Church', tags: ['Prospect', 'Prospect: Churches'], website: 'https://gracechurch.example' });
    // What was sent isn't kept once it's in.
    expect((await t.pool.query("SELECT contact FROM prospect_crm WHERE place_id = 'p-grace'")).rows[0].contact).toBeNull();
    // Again: already there, nothing queued.
    expect(((await (await add({ prospects: [grace], targets: ['fluentcrm'] })).json()) as any).fluentcrm).toMatchObject({ queued: 0, already: 1 });
  });

  it('marks search results that are in a CRM already', async () => {
    t.deps.config.prospects = { apiKey: 'k', searchesPerMonth: 10 };
    t.deps.placesFetch = (async () => Response.json({ places: [{ id: 'p-grace', displayName: { text: 'Grace Church' } }, { id: 'p-new', displayName: { text: 'New Life' } }] })) as typeof fetch;
    const res = await t.call('POST', `/admin/products/${sellerProduct}/prospects/search`, { auth: ADMIN, body: { query: 'church', location: 'Columbus' } });
    const found = ((await res.json()) as any).prospects;
    for (const p of found) valid('Prospect', p);
    expect(found.map((p: any) => [p.id, p.inCrm])).toEqual([
      ['p-grace', ['fluentcrm']],
      ['p-new', []],
    ]);
  });

  it('keeps the HighLevel webhook, checks it, and posts each business to it', async () => {
    expect((await t.call('PUT', `/admin/products/${sellerProduct}/prospects/crm/highlevel`, { auth: ADMIN, body: { webhook: 'https://evil.example/x' } })).status).toBe(400);
    const set = await t.call('PUT', `/admin/products/${sellerProduct}/prospects/crm/highlevel`, { auth: ADMIN, body: { webhook: WEBHOOK } });
    expect(((await set.json()) as any).highlevel).toEqual({ connected: true });
    // Encrypted at rest.
    expect((await t.pool.query('SELECT highlevel_webhook FROM prospect_crm_settings WHERE product_id = $1', [sellerProduct])).rows[0].highlevel_webhook).not.toContain('leadconnector');

    const res = await add({ prospects: [grace, hope], group: 'Churches', targets: ['highlevel'] });
    const body = (await res.json()) as any;
    valid('ProspectCrmResult', body);
    expect(body.highlevel).toEqual({ sent: 2, already: 0, failed: 0, unavailable: null });
    expect(posted.map((p) => p.url)).toEqual([WEBHOOK, WEBHOOK]);
    const first = posted.find((p) => p.body.prospectId === 'p-grace')!.body;
    expect(first).toMatchObject({ companyName: 'Grace Church', email: 'office@gracechurch.example', phone: '(614) 555-0100', facebook: 'https://facebook.com/grace', tags: 'Prospect,Prospect: Churches', source: 'Prospect finder' });
    // Phone-only businesses go to HighLevel too.
    expect(posted.find((p) => p.body.prospectId === 'p-hope')!.body).toMatchObject({ email: '', phone: '(614) 555-0101' });
    expect(((await (await add({ prospects: [grace], targets: ['highlevel'] })).json()) as any).highlevel).toMatchObject({ sent: 0, already: 1 });
  });

  it("says so when HighLevel takes none, and lets them be sent again", async () => {
    hlAnswer = () => new Response('no', { status: 404 });
    const fresh = { id: 'p-fresh', name: 'Fresh Start' };
    expect((await add({ prospects: [fresh], targets: ['highlevel'] })).status).toBe(502);
    hlAnswer = () => new Response('ok');
    expect(((await (await add({ prospects: [fresh], targets: ['highlevel'] })).json()) as any).highlevel).toMatchObject({ sent: 1, already: 0 });
    // Removing the webhook.
    const off = await t.call('DELETE', `/admin/products/${sellerProduct}/prospects/crm/highlevel`, { auth: ADMIN });
    expect(((await off.json()) as any).highlevel).toEqual({ connected: false });
  });

  it('is only for the platform admin and the storefront itself', async () => {
    expect((await t.call('GET', `/admin/products/${sellerProduct}/prospects/crm`)).status).toBe(403);
  });
});

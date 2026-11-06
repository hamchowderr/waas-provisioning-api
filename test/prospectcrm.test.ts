// Prospect finder results into a seller's CRM (src/prospectcrm.ts): the storefront's FluentCRM through a job and
// the store agent, and HighLevel through the seller's workflow webhook. Responses are validated against
// openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAjv } from '../src/openapi.ts';
import { mailboxInput } from '../src/outreach.ts';
import { automationInput, emailHtml } from '../src/outreachautomation.ts';
import { crmInput, highLevelWebhook } from '../src/prospectcrm.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

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
    expect((await t.call('GET', `/admin/products/${sellerProduct}/prospects/mailbox`)).status).toBe(403);
  });
});

describe("the seller's own mailbox for prospect emails", () => {
  const BOX = { host: 'smtp.gmail.com', port: 587, user: 'Sam@Seller.example', pass: 'abcd efgh ijkl mnop', name: 'Sam at Seller', daily: 25 };
  const mailbox = async () => (await t.call('GET', `/admin/products/${sellerProduct}/prospects/mailbox`, { auth: ADMIN })).json() as Promise<any>;
  const put = (body: unknown) => t.call('PUT', `/admin/products/${sellerProduct}/prospects/mailbox`, { auth: ADMIN, body });
  const onStore = () => t.provisioner.stores.get(storefrontId)!.outreachMailbox;

  it('checks what it is given, and never takes the store relay', () => {
    expect(mailboxInput(BOX)).toEqual({ host: 'smtp.gmail.com', port: 587, user: 'Sam@Seller.example', pass: 'abcd efgh ijkl mnop', from: 'sam@seller.example', name: 'Sam at Seller', daily: 25 });
    expect(mailboxInput({ ...BOX, port: undefined, daily: undefined })).toMatchObject({ port: 587, daily: 30 });
    for (const bad of [{ host: 'smtp.tosend.com' }, { host: 'not a host' }, { pass: '' }, { user: '' }, { daily: 500 }, { port: 0 }, { from: 'nope' }]) {
      expect(() => mailboxInput({ ...BOX, ...bad })).toThrow();
    }
  });

  it('starts with none', async () => {
    const box = await mailbox();
    valid('ProspectMailbox', box);
    expect(box).toEqual({ state: 'none', error: null, mailbox: null, unavailable: null });
  });

  it('signs in from the storefront, keeps it there, and forgets the password', async () => {
    const res = await put(BOX);
    expect(res.status).toBe(202);
    valid('ProspectMailbox', await res.json());
    await waitFor(async () => (await mailbox()).state === 'connected');
    const box = await mailbox();
    valid('ProspectMailbox', box);
    expect(box.mailbox).toEqual({ host: 'smtp.gmail.com', port: 587, user: 'Sam@Seller.example', from: 'sam@seller.example', name: 'Sam at Seller', daily: 25 });
    expect(JSON.stringify(box)).not.toContain('abcd');
    expect(onStore()).toMatchObject({ host: 'smtp.gmail.com', pass: 'abcd efgh ijkl mnop', daily: 25 });
    const row = (await t.pool.query('SELECT mailbox, mailbox_pass FROM prospect_crm_settings WHERE product_id = $1', [sellerProduct])).rows[0];
    expect(row.mailbox_pass).toBeNull();
    expect(JSON.stringify(row.mailbox)).not.toContain('abcd');
  });

  it("says why when the mail server won't let it in, and keeps the old one off the store", async () => {
    t.provisioner.refusedMailHosts.add('smtp.office365.com');
    await put({ ...BOX, host: 'smtp.office365.com' });
    await waitFor(async () => (await mailbox()).state === 'failed');
    expect((await mailbox()).error).toMatch(/535/);
    expect(onStore()!.host).toBe('smtp.gmail.com');
  });

  it('takes it off the storefront', async () => {
    const res = await t.call('DELETE', `/admin/products/${sellerProduct}/prospects/mailbox`, { auth: ADMIN });
    expect(res.status).toBe(202);
    await waitFor(async () => (await mailbox()).state === 'none');
    expect(onStore()).toBeUndefined();
  });

  it('is only for ready-made storefronts', async () => {
    await t.pool.query("UPDATE tenants SET external_id = 'not-a-storefront' WHERE id = $1", [storefrontId]);
    expect((await mailbox()).unavailable).toMatch(/ready-made/);
    expect((await put(BOX)).status).toBe(400);
    await t.pool.query('UPDATE tenants SET external_id = $2 WHERE id = $1', [storefrontId, `storefront-${sellerProduct}`]);
  });
});

describe("a group's outreach plan as a draft FluentCRM automation", () => {
  const PLAN = {
    group: 'Churches',
    note: 'Turn it on when your mailbox is connected.',
    emails: [
      { day: 1, subject: 'A simpler website for {{contact.first_name}}', body: 'Hi there,\n\nI help churches like {{contact.first_name}}.\n\nSam\nSummit Sites' },
      { day: 4, subject: 'Re: A simpler website', body: 'See https://demo.example/church.' },
    ],
  };
  const list = async () => (await t.call('GET', `/admin/products/${sellerProduct}/prospects/automations`, { auth: ADMIN })).json() as Promise<any>;

  it('turns the plain text into paragraphs, safely', () => {
    expect(emailHtml('Hi <b>there</b>,\n\nSee https://x.example/a.\nSam')).toBe('<p>Hi &lt;b&gt;there&lt;/b&gt;,</p>\n<p>See <a href="https://x.example/a">https://x.example/a</a>.<br>Sam</p>');
    expect(automationInput(PLAN).automation).toMatchObject({ title: 'Outreach: Churches', tag: 'Prospect: Churches' });
    for (const bad of [{ group: '' }, { emails: [] }, { emails: [{ day: 4, subject: 'a', body: 'b' }, { day: 1, subject: 'a', body: 'b' }] }, { emails: [{ day: 1, subject: '', body: 'b' }] }]) {
      expect(() => automationInput({ ...PLAN, ...bad })).toThrow();
    }
  });

  it('makes it on the storefront once, and links to it', async () => {
    const empty = await list();
    valid('ProspectAutomations', empty);
    expect(empty.automations).toEqual([]);
    const res = await t.call('POST', `/admin/products/${sellerProduct}/prospects/automations`, { auth: ADMIN, body: PLAN });
    expect(res.status).toBe(202);
    await waitFor(async () => (await list()).automations[0]?.state === 'added');
    const after = await list();
    valid('ProspectAutomations', after);
    expect(after.automations[0]).toMatchObject({ group: 'Churches', title: 'Outreach: Churches', funnelId: 1 });
    expect(after.automations[0].editUrl).toMatch(/^https:\/\/.+\/wp-admin\/admin\.php\?page=fluentcrm-admin#\/funnels\/1\/edit$/);
    const made = t.provisioner.stores.get(storefrontId)!.automations!['Outreach: Churches']!;
    expect(made.emails.map((e) => e.day)).toEqual([1, 4]);
    expect(made.emails[0]!.body).toContain('<p>I help churches like {{contact.first_name}}.</p>');
    // Again: the storefront keeps the one it has.
    await t.call('POST', `/admin/products/${sellerProduct}/prospects/automations`, { auth: ADMIN, body: { ...PLAN, emails: [PLAN.emails[0]] } });
    await waitFor(async () => (await list()).automations[0]?.state === 'added');
    expect(t.provisioner.stores.get(storefrontId)!.automations!['Outreach: Churches']!.emails).toHaveLength(2);
    // What was sent isn't kept once it's made.
    expect((await t.pool.query('SELECT automation FROM prospect_automations WHERE product_id = $1', [sellerProduct])).rows[0].automation).toBeNull();
  });
});

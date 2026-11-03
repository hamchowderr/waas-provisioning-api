// Setup checklists (src/setup.ts): each storefront's and reseller's steps, ticked from what the API holds.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAjv } from '../src/openapi.ts';
import { isOwnDomain } from '../src/setup.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');
const validateSetup = ajv.compile(
  JSON.parse(JSON.stringify(adminSpec.paths['/admin/setup'].get.responses['200'].content['application/json'].schema).replaceAll('"#/components', '"admin#/components')),
);

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;

async function getSetup(): Promise<any> {
  const res = await t.call('GET', '/admin/setup', { auth: ADMIN });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(validateSetup(body), ajv.errorsText(validateSetup.errors)).toBe(true);
  return body;
}

const stepsOf = (s: any) => Object.fromEntries(s.steps.map((st: any) => [st.key, st.state]));

beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.close();
});

describe('isOwnDomain', () => {
  const config = { storesDomain: 'stores.waas.example', platformDomain: 'waas.example' };
  it('tells the customer\'s own domain from an address the platform gave', () => {
    expect(isOwnDomain('https://shop.example.com', config)).toBe(true);
    expect(isOwnDomain('shop.example.com/', config)).toBe(true);
    expect(isOwnDomain('https://t-1234abcd.stores.waas.example', config)).toBe(false);
    expect(isOwnDomain('https://seller.waas.example', config)).toBe(false);
    expect(isOwnDomain('http://1-2-3-4.sslip.io', config)).toBe(false);
    expect(isOwnDomain('http://10.0.0.5', config)).toBe(false);
    expect(isOwnDomain(null, config)).toBe(false);
  });
});

describe('setup checklists', () => {
  it('starts a new storefront with only what the platform did for it', async () => {
    const { storefronts } = await getSetup();
    const mine = storefronts.find((s: any) => s.productId === t.productId);
    expect(mine.total).toBe(10);
    // No application (the platform made it), so that step is done; the key hasn't been used yet.
    expect(stepsOf(mine)).toMatchObject({ approved: 'done', 'shop-connected': 'todo', 'starting-site': 'todo', plans: 'not-reported', 'first-store': 'todo' });
    expect(mine.next).toBe('Shop connected');
    expect(mine.stuck).toBe(false);
  });

  it('ticks steps as the shop connects, picks a version and builds a store on its own', async () => {
    const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
    const versionId = ((await res.json()) as { id: string }).id;
    await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    await t.call('PUT', '/v1/versions/production', { body: { versionId } });
    const created = (await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'First' } })).json()) as { externalId: string };
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${created.externalId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    await t.pool.query(
      `INSERT INTO plugin_installs (product_id, slug, site, version, channel) VALUES ($1, 'wpcs-waas-host', 'https://t-1234abcd.stores.waas.example', '2.8.0', 'stable')`,
      [t.productId],
    );

    let mine = (await getSetup()).storefronts.find((s: any) => s.productId === t.productId);
    expect(stepsOf(mine)).toMatchObject({
      'shop-connected': 'done',
      'starting-site': 'done',
      'self-building': 'done',
      'first-store': 'done',
      'own-domain': 'todo',
    });
    expect(mine.steps.find((s: any) => s.key === 'own-domain').detail).toBe('Your shop still runs on a test address');

    // The shop moves to its own domain.
    await t.pool.query(
      `INSERT INTO plugin_installs (product_id, slug, site, version, channel, last_seen) VALUES ($1, 'wpcs-waas-host', 'https://shop.example.com', '2.8.0', 'stable', now() + interval '1 minute')`,
      [t.productId],
    );
    mine = (await getSetup()).storefronts.find((s: any) => s.productId === t.productId);
    expect(stepsOf(mine)['own-domain']).toBe('done');
    expect(mine.shopSite).toBe('https://shop.example.com');
    expect(mine.done).toBe(6);
  });

  it('marks a storefront stuck after a week with no progress', async () => {
    const stale = (await t.pool.query("INSERT INTO products (name, created_at) VALUES ('Quiet storefront', now() - interval '10 days') RETURNING id")).rows[0].id;
    const quiet = (await getSetup()).storefronts.find((s: any) => s.productId === stale);
    expect(quiet.stuck).toBe(true);
  });

  it('gives a reseller its own steps and counts its storefronts that are ready', async () => {
    const partner = (await t.pool.query("INSERT INTO products (name) VALUES ('Partner storefront') RETURNING id")).rows[0].id;
    const res = await t.call('POST', '/admin/resellers', { auth: ADMIN, body: { name: 'Partner', productIds: [partner], billingEmail: 'billing@example.com' } });
    expect(res.status).toBe(201);
    const resellerId = ((await res.json()) as { id: string }).id;
    const { resellers } = await getSetup();
    const reseller = resellers.find((r: any) => r.resellerId === resellerId);
    expect(stepsOf(reseller)).toEqual({ billing: 'done', 'partner-key': 'todo', 'storefronts-ready': 'todo' });
    expect(reseller.storefronts).toEqual({ ready: 0, total: 1 });
    expect(reseller.steps[2].detail).toBe('0 of 1 storefronts ready');
  });

  it('is for the platform admin only on /admin', async () => {
    expect((await t.call('GET', '/admin/setup', { auth: t.auth })).status).toBe(403);
  });
});

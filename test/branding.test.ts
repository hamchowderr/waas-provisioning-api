// Dashboard branding (docs/branding.md): a storefront's and a reseller's name, logo, icon, color and
// support address, at /admin and /account, the public images, and the look GET /account hands the
// dashboard. Admin answers are checked against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { testUtils } from 'better-auth/plugins';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { createAjv } from '../src/openapi.ts';
import { setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

const AUTH: AuthConfig = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789' };

let t: TestContext;
let app: ReturnType<typeof createApp>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let helpers: any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');

/** Calls the admin API; a 2xx JSON answer must match the spec. */
async function admin(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const raw = body instanceof Uint8Array;
  const res = await app.request(`/admin${path}`, {
    method,
    headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': raw ? 'image/png' : 'application/json', ...headers },
    body: body === undefined ? undefined : raw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
  });
  if (res.ok) {
    const opPath = Object.keys(adminSpec.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(`/admin${path}`))!;
    const schema = adminSpec.paths[opPath][method.toLowerCase()].responses[String(res.status)].content['application/json'].schema;
    const validate = ajv.compile(JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"admin#/components/')));
    const json = await res.clone().json();
    expect(validate(json), `${method} ${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
  return res;
}

const asUser = (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { Cookie: cookie, 'X-Session-Auth': '1', 'Content-Type': body instanceof Uint8Array ? 'image/png' : 'application/json', ...extra },
    body: body === undefined ? undefined : body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
  });

async function signedIn(email: string): Promise<{ userId: string; cookie: string }> {
  const user = await helpers.saveUser(helpers.createUser({ email, name: email.split('@')[0], emailVerified: true }));
  const { headers } = await helpers.login({ userId: user.id });
  return { userId: user.id, cookie: (headers as Headers).get('cookie')! };
}

/** Adds the user straight to the product's or reseller's organization with `role`. */
async function join(userId: string, owner: { productId: string } | { resellerId: string }, role: string) {
  const column = 'productId' in owner ? '"productId"' : '"resellerId"';
  const id = 'productId' in owner ? owner.productId : owner.resellerId;
  const { rows } = await t.pool.query(
    `INSERT INTO auth.organization (name, slug, "createdAt", ${column}) VALUES ('Team', $1::text, now(), $1::uuid)
     ON CONFLICT (${column}) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [id],
  );
  await t.pool.query(`INSERT INTO auth.member ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, now())`, [rows[0].id, userId, role]);
}

// The smallest valid PNG header is enough: the type is read from the first bytes.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let resellerId: string;
let bakery: string;
let salon: string;

beforeAll(async () => {
  t = await setup();
  const auth = createAuth(t.pool, AUTH, [testUtils()]);
  helpers = ((await auth.$context) as unknown as { test: unknown }).test;
  t.deps.config.auth = AUTH;
  t.deps.config.publicUrl = 'https://api.waas.example';
  t.deps.auth = auth;
  app = createApp(t.deps);
  const product = async (name: string) => (await t.pool.query<{ id: string }>('INSERT INTO products (name) VALUES ($1) RETURNING id', [name])).rows[0]!.id;
  bakery = await product('BakerySites');
  salon = await product('SalonPages');
  const res = await admin('POST', '/resellers', { name: 'Partner Co', productIds: [bakery, salon] });
  resellerId = ((await res.json()) as { id: string }).id;
});

afterAll(() => t.close());

describe('branding (admin)', () => {
  it('starts empty, and sets, normalizes and clears fields', async () => {
    const empty = await (await admin('GET', `/products/${t.productId}/branding`)).json();
    expect(empty).toMatchObject({ name: null, color: null, supportEmail: null, logoUrl: null, iconUrl: null });
    const set = await admin('PUT', `/products/${t.productId}/branding`, { name: ' Jane Designs ', color: '#1D4ED8', supportEmail: 'Help@Jane.example' });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ name: 'Jane Designs', color: '#1d4ed8', supportEmail: 'help@jane.example' });
    // Fields left out stay; null clears.
    const cleared = await (await admin('PUT', `/products/${t.productId}/branding`, { color: null })).json();
    expect(cleared).toMatchObject({ name: 'Jane Designs', color: null, supportEmail: 'help@jane.example' });
  });

  it('refuses bad values and unknown owners', async () => {
    expect((await admin('PUT', `/products/${t.productId}/branding`, { color: 'blue' })).status).toBe(400);
    expect((await admin('PUT', `/products/${t.productId}/branding`, { name: 'x'.repeat(61) })).status).toBe(400);
    expect((await admin('PUT', `/products/${t.productId}/branding`, { supportEmail: 'nope' })).status).toBe(400);
    expect((await admin('GET', '/products/00000000-0000-4000-8000-000000000000/branding')).status).toBe(404);
    expect((await admin('GET', '/resellers/00000000-0000-4000-8000-000000000000/branding')).status).toBe(404);
    expect((await app.request(`/admin/products/${t.productId}/branding`)).status).toBe(403);
  });

  it('takes a logo, serves it publicly, and removes it', async () => {
    const res = await admin('PUT', `/products/${t.productId}/branding/logo`, PNG);
    expect(res.status).toBe(200);
    const { logoUrl } = (await res.json()) as { logoUrl: string };
    expect(logoUrl).toMatch(/^https:\/\/api\.waas\.example\/branding\/[0-9a-f-]{36}\/logo\?v=\d+$/);
    const image = await app.request(new URL(logoUrl).pathname);
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    // The icon is a separate image.
    expect((await app.request(new URL(logoUrl).pathname.replace('/logo', '/icon'))).status).toBe(404);
    const removed = await (await admin('DELETE', `/products/${t.productId}/branding/logo`)).json();
    expect(removed.logoUrl).toBeNull();
    expect((await app.request(new URL(logoUrl).pathname)).status).toBe(404);
  });

  it('refuses SVG, empty and oversized images whatever the request says', async () => {
    expect((await admin('PUT', `/products/${t.productId}/branding/logo`, SVG)).status).toBe(400);
    expect((await admin('PUT', `/products/${t.productId}/branding/icon`, new Uint8Array())).status).toBe(400);
    const big = new Uint8Array(64 * 1024 + 1);
    big.set(PNG);
    expect((await admin('PUT', `/products/${t.productId}/branding/icon`, big)).status).toBe(400);
    expect((await admin('PUT', `/products/${t.productId}/branding/logo`, big)).status).toBe(200);
  });

  it("fills a storefront's empty fields from its reseller's", async () => {
    await admin('PUT', `/resellers/${resellerId}/branding`, { name: 'Partner Co', color: '#111111', supportEmail: 'help@partner.example' });
    await admin('PUT', `/resellers/${resellerId}/branding/icon`, PNG);
    await admin('PUT', `/products/${bakery}/branding`, { name: 'BakerySites', color: '#d97706' });
    const view = await (await admin('GET', `/products/${bakery}/branding`)).json();
    expect(view).toMatchObject({ name: 'BakerySites', color: '#d97706', supportEmail: null, iconUrl: null });
    expect(view.shown).toMatchObject({ name: 'BakerySites', color: '#d97706', supportEmail: 'help@partner.example' });
    expect(view.shown.iconUrl).toMatch(/\/icon\?v=/);
    // A storefront that set nothing shows the reseller's look.
    const other = await (await admin('GET', `/products/${salon}/branding`)).json();
    expect(other.shown).toMatchObject({ name: 'Partner Co', color: '#111111' });
  });
});

describe('branding (signed in)', () => {
  it("lets an owner brand their own storefront, and GET /account hands the dashboard the look", async () => {
    const owner = await signedIn('owner@jane.example');
    await join(owner.userId, { productId: t.productId }, 'owner');
    const set = await asUser(owner.cookie, 'PUT', `/account/products/${t.productId}/branding`, { name: 'Jane Designs Studio', color: '#0f766e' });
    expect(set.status).toBe(200);
    expect((await asUser(owner.cookie, 'PUT', `/account/products/${t.productId}/branding/icon`, PNG)).status).toBe(200);
    const me = await (await asUser(owner.cookie, 'GET', '/account')).json();
    expect(me.brand).toMatchObject({ name: 'Jane Designs Studio', color: '#0f766e', supportEmail: 'help@jane.example' });
    expect(me.brand.iconUrl).toMatch(/\/icon\?v=/);
  });

  it("keeps members to looking, and other storefronts and resellers out of reach", async () => {
    const member = await signedIn('member@jane.example');
    await join(member.userId, { productId: t.productId }, 'member');
    expect((await asUser(member.cookie, 'GET', `/account/products/${t.productId}/branding`)).status).toBe(200);
    expect((await asUser(member.cookie, 'PUT', `/account/products/${t.productId}/branding`, { name: 'Mine now' })).status).toBe(403);
    expect((await asUser(member.cookie, 'GET', `/account/products/${bakery}/branding`)).status).toBe(404);
    expect((await asUser(member.cookie, 'GET', `/account/resellers/${resellerId}/branding`)).status).toBe(404);
  });

  it("shows a reseller's team each storefront's own look as they switch", async () => {
    const lead = await signedIn('lead@partner.example');
    await join(lead.userId, { resellerId }, 'owner');
    const onBakery = await (await asUser(lead.cookie, 'GET', '/account', undefined, { 'X-Product-Id': bakery })).json();
    expect(onBakery.brand).toMatchObject({ name: 'BakerySites', color: '#d97706' });
    const onSalon = await (await asUser(lead.cookie, 'GET', '/account', undefined, { 'X-Product-Id': salon })).json();
    expect(onSalon.brand).toMatchObject({ name: 'Partner Co', color: '#111111' });
    // They brand the storefront they picked.
    const res = await asUser(lead.cookie, 'PUT', `/account/products/${salon}/branding`, { name: 'SalonPages' }, { 'X-Product-Id': salon });
    expect(res.status).toBe(200);
    expect((await res.json()).shown).toMatchObject({ name: 'SalonPages', color: '#111111' });
  });

  it('gives no brand to a storefront nobody branded', async () => {
    const plain = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Plain') RETURNING id")).rows[0]!.id;
    const someone = await signedIn('someone@plain.example');
    await join(someone.userId, { productId: plain }, 'owner');
    expect((await (await asUser(someone.cookie, 'GET', '/account')).json()).brand).toBeNull();
  });
});

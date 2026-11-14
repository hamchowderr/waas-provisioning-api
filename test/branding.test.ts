import { createHash } from 'node:crypto';
// Dashboard branding (docs/branding.md): a storefront's and a reseller's name, logo, icon, color and
// support address, at /admin and /account, the public images, and the look GET /account hands the
// dashboard. Admin answers are checked against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { testUtils } from 'better-auth/plugins';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { demoZip, latestClientZip, latestDemoZip } from '../src/branding.ts';
import { createAjv } from '../src/openapi.ts';
import { setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

const AUTH: AuthConfig = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789', brand: 'AnyPress' };

let t: TestContext;
let app: ReturnType<typeof createApp>;
let helpers: any;

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
    // The storefront switcher's list carries it, and prefers the icon once there is one.
    const mark = async () =>
      ((await (await admin('GET', '/overview')).json()) as { products: { id: string; markUrl: string | null }[] }).products.find(
        (p) => p.id === t.productId,
      )?.markUrl;
    expect(await mark()).toBe(logoUrl);
    const { iconUrl } = (await (await admin('PUT', `/products/${t.productId}/branding/icon`, PNG)).json()) as { iconUrl: string };
    expect(await mark()).toBe(iconUrl);
    await admin('DELETE', `/products/${t.productId}/branding/icon`);
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

  it('keeps a shop link, refusing anything but http and https', async () => {
    expect((await admin('PUT', `/products/${salon}/branding`, { shopUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await admin('PUT', `/products/${salon}/branding`, { shopUrl: `https://x.example/${'a'.repeat(500)}` })).status).toBe(400);
    const set = await (await admin('PUT', `/resellers/${resellerId}/branding`, { shopUrl: 'https://partner.example/buy' })).json();
    expect(set.shopUrl).toBe('https://partner.example/buy');
    const view = await (await admin('GET', `/products/${salon}/branding`)).json();
    expect(view.shopUrl).toBeNull();
    expect(view.shown.shopUrl).toBe('https://partner.example/buy');
  });
});

describe('demo page look (public)', () => {
  const demo = (id: string) => app.request(`/branding/demo/${id}`);

  it("answers a storefront's look with its reseller's filling the gaps, and where to buy", async () => {
    const res = await demo(salon);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const body = await res.json();
    expect(body).toMatchObject({ name: 'Partner Co', shopUrl: 'https://partner.example/buy' });
    expect(body.brand).toMatchObject({ color: '#111111', supportEmail: 'help@partner.example' });
    await admin('PUT', `/products/${salon}/branding`, { shopUrl: 'https://salon.example' });
    expect((await (await demo(salon)).json()).shopUrl).toBe('https://salon.example');
  });

  it("answers a reseller's own look", async () => {
    const body = await (await demo(resellerId)).json();
    expect(body).toMatchObject({ name: 'Partner Co', shopUrl: 'https://partner.example/buy' });
    expect(body.brand.iconUrl).toMatch(/\/icon\?v=/);
  });

  it('uses the storefront name when nobody branded it, and 404s for anything else', async () => {
    const plain = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Plain Sites') RETURNING id")).rows[0]!.id;
    expect(await (await demo(plain)).json()).toEqual({ name: 'Plain Sites', brand: null, shopUrl: null });
    expect((await demo('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await demo('not-a-uuid')).status).toBe(404);
  });
});

describe('demo page zips (public)', () => {
  it('downloads only the theme and Blocks release zips, once each, and lets any site read them', async () => {
    const urls: string[] = [];
    const download = (async (url: string) => {
      urls.push(url);
      return new Response(url.includes('v9.9.9') ? 'missing' : 'PK zip', { status: url.includes('v9.9.9') ? 404 : 200 });
    }) as typeof fetch;
    expect((await demoZip('anypress-theme-v0.10.0.zip', download))?.toString()).toBe('PK zip');
    expect((await demoZip('anypress-theme-v0.10.0.zip', download))?.toString()).toBe('PK zip');
    expect(await demoZip('anypress-blocks-v0.4.0.zip', download)).not.toBeNull();
    expect(await demoZip('anypress-blocks-v9.9.9.zip', download)).toBeNull();
    for (const bad of ['anypress-theme-main.zip', 'other-v1.0.0.zip', '../anypress-theme-v1.0.0.zip', 'anypress-theme-v1.0.0.zip?x']) expect(await demoZip(bad, download)).toBeNull();
    expect(urls).toEqual([
      'https://github.com/hamchowderr/anypress-theme/releases/download/v0.10.0/anypress.zip',
      'https://github.com/hamchowderr/anypress-blocks/releases/download/v0.4.0/anypress-blocks.zip',
      'https://github.com/hamchowderr/anypress-blocks/releases/download/v9.9.9/anypress-blocks.zip',
    ]);
    const res = await app.request('/branding/demo-files/not-a-zip.zip');
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('serves AnyPress Client’s latest stable release for the site-type blueprints, checked against its manifest', async () => {
    const zip = Buffer.from('PK client zip');
    const sha256 = createHash('sha256').update(zip).digest('hex');
    const manifest = { slug: 'anypress-client', version: '2.25.0', zip: 'releases/anypress-client/2.25.0/anypress-client.zip', sha256, signature: `${'A'.repeat(86)}==` };
    const releases = { getJson: async () => manifest, presignGet: async (key: string) => `https://r2.example/${key}` };
    const asked: string[] = [];
    const download = (async (url: string) => (asked.push(url), new Response(zip))) as typeof fetch;
    expect((await latestClientZip(releases, download))?.toString()).toBe('PK client zip');
    expect((await latestClientZip(releases, download))?.toString()).toBe('PK client zip');
    expect(asked).toEqual(['https://r2.example/releases/anypress-client/2.25.0/anypress-client.zip']);
    const tampered = { ...releases, getJson: async () => ({ ...manifest, version: '2.25.1', zip: 'releases/anypress-client/2.25.1/anypress-client.zip' }) };
    expect(await latestClientZip(tampered, (async () => new Response('something else')) as typeof fetch)).toBeNull();
    expect(await latestClientZip({ ...releases, getJson: async () => null }, download)).toBeNull();
  });
});

describe('newest demo zips (public)', () => {
  it('serves the newest theme and Blocks release under a name without a version', async () => {
    const urls: string[] = [];
    const download = (async (url: string) => {
      urls.push(url);
      return new Response('PK zip');
    }) as typeof fetch;
    const asked: string[] = [];
    const latest = async (repo: string) => {
      asked.push(repo);
      return repo === 'anypress-theme' ? 'v0.21.0' : 'v0.5.1';
    };
    expect((await latestDemoZip('anypress-theme.zip', latest, download))?.toString()).toBe('PK zip');
    expect((await latestDemoZip('anypress-theme.zip', latest, download))?.toString()).toBe('PK zip');
    expect(await latestDemoZip('anypress-blocks.zip', latest, download)).not.toBeNull();
    for (const bad of ['anypress-client.zip', 'anypress-theme', '../anypress-theme.zip']) expect(await latestDemoZip(bad, latest, download)).toBeNull();
    // GitHub is asked once per repository while the tag is fresh, and each release is downloaded once.
    expect(asked).toEqual(['anypress-theme', 'anypress-blocks']);
    expect(urls).toEqual([
      'https://github.com/hamchowderr/anypress-theme/releases/download/v0.21.0/anypress.zip',
      'https://github.com/hamchowderr/anypress-blocks/releases/download/v0.5.1/anypress-blocks.zip',
    ]);
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

// Applications to sell (src/applications.ts): the public form's POST /applications and the platform
// admin's review at /admin/applications. Responses are validated against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { APPLICATIONS_PER_HOUR } from '../src/applications.ts';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { createAjv } from '../src/openapi.ts';
import { Status } from '../src/status.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

const AUTH: AuthConfig = {
  url: 'https://app.waas.example',
  secret: 'test-auth-secret-not-a-secret-0123456789',
  mail: { key: 'test-key', from: 'no-reply@anypress.example', brand: 'AnyPress' },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');

let t: TestContext;
let app: ReturnType<typeof createApp>;
const sent: { to: string; subject: string; text: string }[] = [];

/** Calls the API; a 2xx JSON answer must match the admin spec. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown, admin = true): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: { ...(admin ? { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (res.ok) {
    const opPath = Object.keys(adminSpec.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path.split('?')[0]!))!;
    const schema = adminSpec.paths[opPath][method.toLowerCase()].responses[String(res.status)].content['application/json'].schema;
    const validate = ajv.compile(
      JSON.parse(
        JSON.stringify(schema).replaceAll('"#/components/', '"admin#/components/').replaceAll('"../waas-provisioning-api.yaml#/components', '"spec#/components'),
      ),
    );
    expect(validate(json), `${method} ${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
  return { status: res.status, json };
}

const apply = (body: Record<string, unknown>) => call('POST', '/applications', body, false);
const form = (over: Record<string, unknown> = {}) => ({
  name: 'Ada Lovelace',
  email: 'Ada@Agency.example',
  business: 'Analytical Agency',
  website: 'agency.example',
  clients: 'Restaurants and salons in our city',
  expectedSites: '3-9',
  wantsStorefront: false,
  ...over,
});

beforeAll(async () => {
  t = await setup();
  t.deps.config.auth = AUTH;
  t.deps.config.applicationNotify = ['owner@platform.example'];
  t.deps.auth = createAuth(t.pool, AUTH);
  app = createApp(t.deps);

  // The storefront product, with a production version, for approvals that build a storefront.
  const created = await t.call('POST', '/admin/products', { body: { name: 'Storefronts' }, auth: `Bearer ${TEST_ADMIN_TOKEN}` });
  const { product, key } = (await created.json()) as { product: { id: string }; key: { id: string; secret: string } };
  const auth = basic(key.id, key.secret);
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true }, auth });
  const versionId = ((await res.json()) as { id: string }).id;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`, { auth })).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId }, auth });
  t.deps.config.storefrontProductId = product.id;

  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.tosend.com/')) return realFetch(input, init);
    const body = JSON.parse(String(init!.body));
    sent.push({ to: body.to[0].email, subject: body.subject, text: body.text });
    return new Response('{"id":"e1"}', { status: 200 });
  });
});

afterEach(async () => {
  sent.splice(0);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

describe('applying', () => {
  it('takes an application without sign-in and emails the applicant and the platform admin', async () => {
    const res = await apply(form());
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ id: expect.any(String), status: 'pending' });
    expect(sent).toEqual([
      { to: 'ada@agency.example', subject: 'We got your AnyPress application', text: expect.stringContaining('Analytical Agency') },
      {
        to: 'owner@platform.example',
        subject: 'New seller application: Analytical Agency',
        text: expect.stringContaining(`${AUTH.url}/applications/${res.json.id}`),
      },
    ]);
    const { json } = await call('GET', `/admin/applications/${res.json.id}`);
    expect(json).toMatchObject({ email: 'ada@agency.example', website: 'https://agency.example/', status: 'pending', productId: null });
  });

  it('keeps one waiting application per email address', async () => {
    const res = await apply(form({ email: 'ada@agency.example' }));
    expect(res.status).toBe(409);
  });

  it('refuses missing or bad fields, and a storefront address that is taken', async () => {
    expect((await apply(form({ email: 'nope' }))).status).toBe(400);
    expect((await apply(form({ business: '' }))).status).toBe(400);
    expect((await apply(form({ expectedSites: 'lots' }))).status).toBe(400);
    expect((await apply(form({ wantsStorefront: 'yes' }))).status).toBe(400);
    expect((await apply(form({ website: 'not a site' }))).status).toBe(400);
    expect((await apply(form({ email: 'x@agency.example', wantsStorefront: true, storefrontSubdomain: 'Bad_Name' }))).status).toBe(400);
    // www is reserved on the platform domain.
    const taken = await apply(form({ email: 'x@agency.example', wantsStorefront: true, storefrontSubdomain: 'www' }));
    expect(taken.status).toBe(400);
    expect(taken.json.message).toMatch(/taken/);
  });

  it('is not part of the admin API for customers', async () => {
    expect((await call('GET', '/admin/applications', undefined, false)).status).toBe(403);
  });
});

describe('reviewing', () => {
  it('lists applications by status', async () => {
    const { json: pending } = await call('GET', '/admin/applications?status=pending');
    expect(pending.map((a: { email: string }) => a.email)).toContain('ada@agency.example');
    expect((await call('GET', '/admin/applications?status=maybe')).status).toBe(400);
  });

  it('approves: a product with 3 stores, its owner invited by email', async () => {
    const { json: list } = await call('GET', '/admin/applications?status=pending');
    const id = list.find((a: { email: string }) => a.email === 'ada@agency.example').id;
    const res = await call('POST', `/admin/applications/${id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ application: { status: 'approved' }, storefront: null, storefrontError: null, invitation: { emailed: true } });
    const productId = res.json.productId;
    const products = (await (await t.call('GET', '/admin/products', { auth: `Bearer ${TEST_ADMIN_TOKEN}` })).json()) as { id: string; name: string; maxTenants: number }[];
    expect(products.find((p) => p.id === productId)).toMatchObject({ name: 'Analytical Agency', maxTenants: 3 });
    const org = (await (await t.call('GET', `/admin/products/${productId}/organization`, { auth: `Bearer ${TEST_ADMIN_TOKEN}` })).json()) as any;
    expect(org.invitations).toEqual([expect.objectContaining({ email: 'ada@agency.example', role: 'owner' })]);
    expect(sent).toEqual([
      {
        to: 'ada@agency.example',
        subject: 'Your AnyPress application is approved',
        text: expect.stringContaining(`${AUTH.url}/invite/${res.json.invitation.id}`),
      },
    ]);
    expect((await call('POST', `/admin/applications/${id}/approve`, {})).status).toBe(409);
    expect((await call('POST', `/admin/applications/${id}/decline`)).status).toBe(409);
    expect((await call('GET', `/admin/applications/${id}`)).json).toMatchObject({ productId, status: 'approved', dateDecided: expect.any(String) });
  });

  it('builds the ready-made storefront the applicant asked for', async () => {
    const applied = await apply(form({ email: 'grace@shop.example', business: 'Hopper Sites', wantsStorefront: true, storefrontSubdomain: 'hopper' }));
    expect(applied.status).toBe(201);
    const res = await call('POST', `/admin/applications/${applied.json.id}/approve`, { maxTenants: 10 });
    expect(res.json.storefrontError).toBeNull();
    expect(res.json.storefront).toMatchObject({ externalId: `storefront-${res.json.productId}`, domainName: 'hopper.waas.example' });
    expect(sent.at(-1)!.text).toContain('https://hopper.waas.example');
    await waitFor(async () => t.provisioner.stores.get(res.json.storefront.id)?.user);
    expect(t.provisioner.stores.get(res.json.storefront.id)!.user).toMatchObject({ email: 'grace@shop.example', role: 'administrator' });
  });

  it('keeps the approval when the storefront fails, and says why', async () => {
    const applied = await apply(form({ email: 'linus@kernel.example', business: 'Kernel Sites' }));
    const saved = t.deps.config.storefrontProductId;
    t.deps.config.storefrontProductId = undefined;
    try {
      const res = await call('POST', `/admin/applications/${applied.json.id}/approve`, { storefront: true });
      expect(res.status).toBe(200);
      expect(res.json.storefront).toBeNull();
      expect(res.json.storefrontError).toMatch(/STOREFRONT_PRODUCT_ID/);
    } finally {
      t.deps.config.storefrontProductId = saved;
    }
  });

  it('declines and emails the applicant, after which they may apply again', async () => {
    const applied = await apply(form({ email: 'mallory@spam.example', business: 'Spam Co' }));
    const res = await call('POST', `/admin/applications/${applied.json.id}/decline`);
    expect(res.json).toMatchObject({ application: { status: 'declined', productId: null }, emailed: true });
    expect(sent.at(-1)).toMatchObject({ to: 'mallory@spam.example', subject: 'Your AnyPress application' });
    expect((await apply(form({ email: 'mallory@spam.example', business: 'Spam Co' }))).status).toBe(201);
  });

  it('answers 404 for an unknown application', async () => {
    expect((await call('GET', '/admin/applications/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await call('POST', '/admin/applications/nope/approve', {})).status).toBe(404);
  });
});

it('takes a limited number of applications per hour', async () => {
  await t.pool.query(
    `INSERT INTO seller_applications (name, email, business, clients, expected_sites, wants_storefront, status)
     SELECT 'x', 'flood' || g || '@example.com', 'x', 'x', '1-2', false, 'declined' FROM generate_series(1, $1) g`,
    [APPLICATIONS_PER_HOUR],
  );
  const res = await apply(form({ email: 'late@example.com' }));
  expect(res.status).toBe(429);
});

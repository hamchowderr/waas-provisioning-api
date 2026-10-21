// Self-service API keys: /v1/keys (openapi/api-keys.yaml) and the admin equivalents
// (openapi/admin/admin-api.yaml). Responses are validated against those specs.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApiKey } from '../src/keys.ts';
import { createAjv } from '../src/openapi.ts';
import { basic, setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (path: string): any => parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const keysSpec = load('../openapi/api-keys.yaml');
const adminSpec = load('../openapi/admin/admin-api.yaml');
const ajv = createAjv();
ajv.addSchema({ components: keysSpec.components }, 'keys');
ajv.addSchema({ components: adminSpec.components }, 'admin');

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;

/** Calls the API and validates a JSON response against the spec that documents the path. */
async function call(method: string, path: string, { auth, body, status = 200 }: { auth?: string; body?: unknown; status?: number } = {}): Promise<any> {
  const res = await t.call(method, path, { auth, body });
  const text = await res.text();
  expect(res.status, `${method} ${path}: ${text}`).toBe(status);
  const [spec, prefix] = path.startsWith('/admin') ? [adminSpec, 'admin'] : [keysSpec, 'keys'];
  const opPath = Object.keys(spec.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path))!;
  let responses = spec.paths[opPath][method.toLowerCase()].responses[String(status)];
  if (responses.$ref) responses = spec.components.responses[responses.$ref.split('/').pop()];
  const schema = JSON.parse(
    JSON.stringify(responses.content['application/json'].schema)
      .replaceAll('"#/components', `"${prefix}#/components`)
      .replaceAll('"../api-keys.yaml#/components', '"keys#/components'),
  );
  const parsed = JSON.parse(text);
  const validate = ajv.compile(schema);
  expect(validate(parsed), `${method} ${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  return { body: parsed, headers: res.headers };
}

const signsIn = async (auth: string) => (await t.call('GET', '/v1/keys', { auth })).status === 200;

beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.close();
});

describe('self-service keys (/v1/keys)', () => {
  it('lists the storefront\'s keys without secrets, marking the one in use', async () => {
    const { body } = await call('GET', '/v1/keys');
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ state: 'active', isCurrent: true, revokedAt: null });
    expect(body[0].lastUsedAt).not.toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/secret|scrypt/);
  });

  it('creates a key whose secret is shown once and works', async () => {
    const { body: key, headers } = await call('POST', '/v1/keys', { body: { label: '  CI deploys  ' }, status: 201 });
    expect(headers.get('cache-control')).toBe('no-store');
    expect(key).toMatchObject({ label: 'CI deploys', state: 'active' });
    expect(key.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await signsIn(basic(key.id, key.secret))).toBe(true);
    const stored = (await t.pool.query('SELECT secret_hash FROM api_keys WHERE id = $1', [key.id])).rows[0].secret_hash;
    expect(stored).not.toContain(key.secret);
    // Listed afterwards without the secret.
    const { body: list } = await call('GET', '/v1/keys');
    expect(list.find((k: any) => k.id === key.id)).not.toHaveProperty('secret');
  });

  it('never writes a secret to the request log', async () => {
    const { body: key } = await call('POST', '/v1/keys', { status: 201 });
    const { rows } = await t.pool.query('SELECT * FROM api_requests');
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(key.secret);
  });

  it('rotates a key: the new one works now, the old one until its grace period ends', async () => {
    const { body: old } = await call('POST', '/v1/keys', { body: { label: 'Storefront' }, status: 201 });
    const oldAuth = basic(old.id, old.secret);
    const { body } = await call('POST', `/v1/keys/${old.id}/rotate`, { auth: oldAuth, body: { graceHours: 2 }, status: 201 });
    expect(body.key).toMatchObject({ label: 'Storefront', state: 'active' });
    expect(body.replaced).toMatchObject({ id: old.id, state: 'expiring' });
    expect(new Date(body.replaced.revokedAt).getTime() - Date.now()).toBeGreaterThan(110 * 60_000);
    expect(await signsIn(oldAuth)).toBe(true);
    expect(await signsIn(basic(body.key.id, body.key.secret))).toBe(true);
    // Only active keys rotate.
    await call('POST', `/v1/keys/${old.id}/rotate`, { status: 409 });
    // Once the grace period is over, the old key is refused.
    await t.pool.query("UPDATE api_keys SET revoked_at = now() - interval '1 second' WHERE id = $1", [old.id]);
    expect(await signsIn(oldAuth)).toBe(false);
  });

  it('rotates with no grace period: the old key stops at once', async () => {
    const { body: old } = await call('POST', '/v1/keys', { status: 201 });
    const { body } = await call('POST', `/v1/keys/${old.id}/rotate`, { body: { graceHours: 0 }, status: 201 });
    expect(body.replaced.state).toBe('revoked');
    expect(await signsIn(basic(old.id, old.secret))).toBe(false);
  });

  it('revokes a key, but never the last active one', async () => {
    const product = (await t.pool.query("INSERT INTO products (name) VALUES ('Solo agency') RETURNING id")).rows[0].id;
    const first = await createApiKey(t.pool, product);
    const auth = basic(first.key, first.secret);
    await call('DELETE', `/v1/keys/${first.key}`, { auth, status: 409 });
    const { body: second } = await call('POST', '/v1/keys', { auth, status: 201 });
    // The key in use can go once another one is active.
    const { body: revoked } = await call('DELETE', `/v1/keys/${first.key}`, { auth, status: 200 });
    expect(revoked.state).toBe('revoked');
    expect(await signsIn(auth)).toBe(false);
    // Revoking again changes nothing.
    const auth2 = basic(second.id, second.secret);
    expect((await call('DELETE', `/v1/keys/${first.key}`, { auth: auth2 })).body.revokedAt).toBe(revoked.revokedAt);
  });

  it('only reaches the storefront\'s own keys', async () => {
    const product = (await t.pool.query("INSERT INTO products (name) VALUES ('Other agency') RETURNING id")).rows[0].id;
    const other = await createApiKey(t.pool, product);
    await call('DELETE', `/v1/keys/${other.key}`, { status: 404 });
    await call('POST', `/v1/keys/${other.key}/rotate`, { status: 404 });
    await call('DELETE', '/v1/keys/not-a-uuid', { status: 404 });
    const { body } = await call('GET', '/v1/keys');
    expect(body.map((k: any) => k.id)).not.toContain(other.key);
  });

  it('checks labels, grace periods and the key limit', async () => {
    await call('POST', '/v1/keys', { body: { label: 'x'.repeat(101) }, status: 400 });
    await call('POST', '/v1/keys', { body: { label: 5 }, status: 400 });
    const { body: keys } = await call('GET', '/v1/keys');
    const active = keys.find((k: any) => k.state === 'active');
    await call('POST', `/v1/keys/${active.id}/rotate`, { body: { graceHours: 721 }, status: 400 });
    await call('POST', `/v1/keys/${active.id}/rotate`, { body: { graceHours: 1.5 }, status: 400 });
    const product = (await t.pool.query("INSERT INTO products (name) VALUES ('Busy agency') RETURNING id")).rows[0].id;
    const first = await createApiKey(t.pool, product);
    const auth = basic(first.key, first.secret);
    for (let i = 1; i < 20; i++) await call('POST', '/v1/keys', { auth, status: 201 });
    await call('POST', '/v1/keys', { auth, status: 409 });
  });

  it('refuses requests without a working key', async () => {
    await call('GET', '/v1/keys', { auth: ADMIN, status: 403 });
  });
});

describe('admin keys and new sellers', () => {
  it('creates a seller with its first key, which can sign in', async () => {
    const { body, headers } = await call('POST', '/admin/products', { auth: ADMIN, body: { name: ' Acme Agency ', maxTenants: 10, keyLabel: 'Storefront' }, status: 201 });
    expect(headers.get('cache-control')).toBe('no-store');
    expect(body.product).toMatchObject({ name: 'Acme Agency', maxTenants: 10, tenantCount: 0 });
    expect(body.key).toMatchObject({ label: 'Storefront', state: 'active' });
    expect(await signsIn(basic(body.key.id, body.key.secret))).toBe(true);
    await call('POST', '/admin/products', { auth: ADMIN, body: { name: '' }, status: 400 });
    await call('POST', '/admin/products', { auth: ADMIN, body: { name: 'X', maxTenants: -1 }, status: 400 });
    await call('POST', '/admin/products', { auth: t.auth, body: { name: 'Nope' }, status: 403 });
  });

  it('lists, creates, rotates and revokes any product\'s keys, the last one included', async () => {
    const { body: seller } = await call('POST', '/admin/products', { auth: ADMIN, body: { name: 'Beta Agency' }, status: 201 });
    const base = `/admin/products/${seller.product.id}/keys`;
    const { body: list } = await call('GET', base, { auth: ADMIN });
    expect(list.map((k: any) => k.id)).toEqual([seller.key.id]);
    const { body: extra } = await call('POST', base, { auth: ADMIN, body: { label: 'Spare' }, status: 201 });
    const { body: rotated } = await call('POST', `${base}/${seller.key.id}/rotate`, { auth: ADMIN, status: 201 });
    expect(rotated.replaced.state).toBe('expiring');
    // Default grace period: 24 hours.
    expect(new Date(rotated.replaced.revokedAt).getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    for (const id of [extra.id, rotated.key.id, seller.key.id]) {
      expect((await call('DELETE', `${base}/${id}`, { auth: ADMIN })).body.state).toBe('revoked');
    }
    expect(await signsIn(basic(rotated.key.id, rotated.key.secret))).toBe(false);
    await call('GET', '/admin/products/00000000-0000-0000-0000-000000000000/keys', { auth: ADMIN, status: 404 });
    await call('DELETE', `/admin/products/${t.productId}/keys/${seller.key.id}`, { auth: ADMIN, status: 404 });
  });
});

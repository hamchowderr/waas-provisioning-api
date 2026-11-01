// "Log in to WordPress" (src/wplogin.ts): POST /admin/tenants/{id}/wp-login and
// /admin/products/{id}/storefront/wp-login answer a one-time link signed with the store's site key, checked
// here the way WaaS Client's AdminLogin (and WaaS Host's, on a storefront) check it. A store whose plugin
// is older than the login route gets its plain login page instead.
import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { siteKey, siteKeyMaster } from '../src/sitekeys.ts';
import { adminLoginLink } from '../src/wplogin.ts';
import { OWNER, setup, TEST_ADMIN_TOKEN, TEST_SECRETS_KEY, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
const master = siteKeyMaster(TEST_SECRETS_KEY);
let tenantId: string;
let mainDomain: string;

/** What the store answers the unsigned probe: 403 from a current plugin, 404 "no route" from an older one. */
let probeStatus = 403;
const probes: string[] = [];

beforeAll(async () => {
  t = await setup();
  t.deps.siteFetch = (async (input: string | URL | Request) => {
    probes.push(String(input));
    return new Response('{}', { status: probeStatus });
  }) as typeof fetch;
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === 1);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Bakery', externalId: 'bakery' } });
  const tenant = await waitFor(async () => {
    const body = (await (await t.call('GET', '/v1/tenants?externalId=bakery')).json()) as any;
    const found = Array.isArray(body) ? body[0] : body;
    return found?.statusCode === 1 ? found : null;
  });
  tenantId = tenant.id;
  mainDomain = tenant.domainName;
});
afterAll(async () => {
  await t.close();
});

/** WaaS Client's check (Api\AdminLogin::link_is_valid): t, n, s over t\nn\nLOGIN\nroute\nsha256(''), with the store's key. */
function linkIsValid(url: string, storeId: string, plugin: 'waas-client' | 'waas-host'): boolean {
  const link = new URL(url);
  const route = `/${plugin}/v1/admin-login`;
  if (link.pathname !== `/wp-json${route}`) return false;
  const [time, nonce, signature] = ['t', 'n', 's'].map((name) => link.searchParams.get(name) ?? '');
  const payload = [time, nonce, 'LOGIN', route, createHash('sha256').update('').digest('hex')].join('\n');
  return (
    /^[0-9a-f]{32}$/.test(nonce!) &&
    Math.abs(Date.now() / 1000 - Number(time)) <= 300 &&
    signature === createHmac('sha256', siteKey(master, storeId)).update(payload).digest('hex')
  );
}

const login = (path: string) => t.call('POST', path, { auth: ADMIN });

describe('log in to WordPress', () => {
  it('matches the plugins\' test vectors', () => {
    const key = 'k3y-k3y-k3y-k3y-k3y-k3y-k3y-k3y-k3y';
    const at = 1_700_000_000_000;
    const nonce = '0123456789abcdef0123456789abcdef';
    // waas-plugins: packages/waas-client/tests/Unit/Api/AdminLoginTest.php and the same in waas-host.
    expect(new URL(adminLoginLink(key, 'shop.example', 'waas-client', at, nonce)).searchParams.get('s')).toBe(
      '6486411be7303040243e70df68d39270a7caefc8ea53b9cf4c1804c6f97ed04a',
    );
    expect(new URL(adminLoginLink(key, 'shop.example', 'waas-host', at, nonce)).searchParams.get('s')).toBe(
      'a721a0ffe6377f67c3fada1086080e2dfe78b430254aca20cc1ef8465e9c6e5e',
    );
  });

  it('answers a signed link to the store\'s wp-admin, different every time', async () => {
    const res = await login(`/admin/tenants/${tenantId}/wp-login`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; oneClick: boolean; expiresAt: string };
    expect(body.oneClick).toBe(true);
    expect(new URL(body.url).host).toBe(mainDomain);
    expect(linkIsValid(body.url, tenantId, 'waas-client')).toBe(true);
    expect(linkIsValid(body.url, 'another-store', 'waas-client')).toBe(false);
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect(probes.at(-1)).toBe(`https://${mainDomain}/wp-json/waas-client/v1/admin-login`);
    const again = (await (await login(`/admin/tenants/${tenantId}/wp-login`)).json()) as { url: string };
    expect(again.url).not.toBe(body.url);
  });

  it('answers the login page when the store\'s plugin is older than the login route', async () => {
    probeStatus = 404;
    try {
      const body = (await (await login(`/admin/tenants/${tenantId}/wp-login`)).json()) as any;
      expect(body).toEqual({ url: `https://${mainDomain}/wp-admin/`, oneClick: false, expiresAt: null });
    } finally {
      probeStatus = 403;
    }
  });

  it('refuses a suspended store, and needs the admin token or a session', async () => {
    await t.pool.query('UPDATE tenants SET is_suspended = true WHERE id = $1', [tenantId]);
    try {
      const res = await login(`/admin/tenants/${tenantId}/wp-login`);
      expect(res.status).toBe(409);
    } finally {
      await t.pool.query('UPDATE tenants SET is_suspended = false WHERE id = $1', [tenantId]);
    }
    expect((await t.call('POST', `/admin/tenants/${tenantId}/wp-login`)).status).toBe(403);
    expect((await login('/admin/tenants/00000000-0000-4000-8000-000000000000/wp-login')).status).toBe(404);
  });

  it('logs in to a ready-made storefront through WaaS Host', async () => {
    const seller = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Seller') RETURNING id")).rows[0]!.id;
    expect((await login(`/admin/products/${seller}/storefront/wp-login`)).status).toBe(404);
    // The store above stands in for the seller's storefront: a store of the storefront product named after the seller.
    await t.pool.query('UPDATE tenants SET external_id = $2 WHERE id = $1', [tenantId, `storefront-${seller}`]);
    t.deps.config.storefrontProductId = t.productId;
    try {
      const res = await login(`/admin/products/${seller}/storefront/wp-login`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string; oneClick: boolean };
      expect(body.oneClick).toBe(true);
      expect(linkIsValid(body.url, tenantId, 'waas-host')).toBe(true);
    } finally {
      t.deps.config.storefrontProductId = undefined;
    }
  });
});

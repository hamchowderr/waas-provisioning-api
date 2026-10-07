// Plugin update checks (waas-hw4): /v1/plugins/{slug}/update and the admin installs and pins.
// Responses are validated against openapi/plugin-updates.yaml and openapi/admin/admin-api.yaml.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApp } from '../src/app.ts';
import { createApiKey } from '../src/keys.ts';
import { createAjv } from '../src/openapi.ts';
import { channelKey, manifestKey, parseManifest, S3ReleaseStore, type PluginSlug, type ReleaseStore } from '../src/releases.ts';
import { basic, setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updatesSpec: any = parse(readFileSync(new URL('../openapi/plugin-updates.yaml', import.meta.url), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: updatesSpec.components }, 'updates');
ajv.addSchema({ components: adminSpec.components }, 'admin');
const validRelease = ajv.compile({ $ref: 'updates#/components/schemas/PluginRelease' });
const validInstalls = ajv.compile(
  JSON.parse(JSON.stringify(adminSpec.paths['/admin/plugins'].get.responses['200'].content['application/json'].schema).replaceAll('"#/components', '"admin#/components')),
);
const validPin = ajv.compile({ $ref: 'admin#/components/schemas/PluginPin' });

/** Releases in memory; package URLs are recognisable fakes. */
class MemoryReleases implements ReleaseStore {
  objects = new Map<string, unknown>();
  failing = false;
  async getJson(key: string) {
    if (this.failing) throw new Error('S3 GET failed: HTTP 500');
    return this.objects.get(key) ?? null;
  }
  presignGet(key: string, expiresIn: number) {
    return `https://releases.test/${key}?X-Amz-Expires=${expiresIn}`;
  }
}

// A real signature, as the release workflow makes it, so the shape checks match production.
const { privateKey } = generateKeyPairSync('ed25519');
function release(slug: PluginSlug, version: string, extra: object = {}) {
  const sha256 = createHash('sha256').update(`${slug} ${version}`).digest('hex');
  const signature = sign(null, Buffer.from(`waas-release-v1\n${slug}\n${version}\n${sha256}`), privateKey).toString('base64');
  return { slug, version, zip: `releases/${slug}/${version}/${slug}.zip`, sha256, signature, requires: '6.4', requiresPhp: '8.1', tested: '6.8', releasedAt: '2026-10-07T12:00:00.000Z', ...extra };
}

let t: TestContext;
let app: ReturnType<typeof createApp>;
const store = new MemoryReleases();
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;

function call(method: string, path: string, auth: string = t.auth, body?: unknown) {
  return app.request(path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const check = (query: string, slug = 'wpcs-waas-host', auth?: string) => call('GET', `/v1/plugins/${slug}/update?${query}`, auth);

beforeAll(async () => {
  t = await setup();
  app = createApp({ ...t.deps, releases: store });
  store.objects.set(channelKey('wpcs-waas-host', 'stable'), release('wpcs-waas-host', '2.3.0', { changelog: '* Our own update channel' }));
  store.objects.set(channelKey('wpcs-waas-host', 'beta'), release('wpcs-waas-host', '2.4.0-beta.1'));
  store.objects.set(manifestKey('wpcs-waas-host', '2.3.0'), release('wpcs-waas-host', '2.3.0'));
  store.objects.set(manifestKey('wpcs-waas-host', '2.2.8'), release('wpcs-waas-host', '2.2.8'));
});
afterAll(async () => {
  await t.close();
});

describe('GET /v1/plugins/{slug}/update', () => {
  it('returns the stable release with a short-lived package URL', async () => {
    const res = await check('version=2.2.7&site=https://Shop.Example.com/&wp=6.8.1&php=8.3.12');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validRelease(body), ajv.errorsText(validRelease.errors)).toBe(true);
    expect(body).toMatchObject({ slug: 'wpcs-waas-host', version: '2.3.0', channel: 'stable', pinned: false, packageExpiresIn: 600, requiresPhp: '8.1', changelog: '* Our own update channel' });
    expect(body.package).toBe('https://releases.test/releases/wpcs-waas-host/2.3.0/wpcs-waas-host.zip?X-Amz-Expires=600');
  });

  it('serves the beta channel when asked', async () => {
    const body = await (await check('version=2.3.0&channel=beta')).json();
    expect(body.version).toBe('2.4.0-beta.1');
    expect(body.channel).toBe('beta');
  });

  it('records the version each site reports, one row per site', async () => {
    await check('version=2.2.7&site=https://shop.example.com&wp=6.8.1&php=8.3.12');
    await check('version=2.3.0&site=https://shop.example.com/&wp=6.8.2&php=8.3.12');
    const { rows } = await t.pool.query("SELECT * FROM plugin_installs WHERE product_id = $1 AND site = 'https://shop.example.com'", [t.productId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'wpcs-waas-host', version: '2.3.0', channel: 'stable', wp_version: '6.8.2', php_version: '8.3.12' });
  });

  it('rejects a bad query', async () => {
    expect((await check('channel=stable')).status).toBe(400); // no version
    expect((await check('version=latest')).status).toBe(400);
    expect((await check('version=2.2.7&channel=nightly')).status).toBe(400);
    expect((await check('version=2.2.7&site=ftp://x.example')).status).toBe(400);
    expect((await check('version=2.2.7&site=not a url')).status).toBe(400);
  });

  it('404s an unknown plugin and a channel with nothing released', async () => {
    expect((await check('version=1.0.0', 'akismet')).status).toBe(404);
    const res = await check('version=0.1.0', 'waas-payments');
    expect(res.status).toBe(404);
    expect((await res.json()).message).toBe('No stable release of waas-payments');
  });

  it('treats a malformed or mismatched manifest as no release', async () => {
    const key = channelKey('wpcs-waas-client', 'stable');
    for (const bad of [
      { ...release('wpcs-waas-client', '2.3.0'), sha256: 'nothex' },
      { ...release('wpcs-waas-client', '2.3.0'), signature: 'c2hvcnQ=' },
      release('wpcs-waas-host', '2.3.0'), // another plugin's manifest
      { ...release('wpcs-waas-client', '2.3.0'), zip: 'releases/wpcs-waas-host/2.3.0/wpcs-waas-host.zip' },
      { ...release('wpcs-waas-client', '2.3.0'), version: 'v2.3' },
    ]) {
      store.objects.set(key, bad);
      expect((await check('version=2.2.7', 'wpcs-waas-client')).status).toBe(404);
    }
    store.objects.delete(key);
  });

  it('403s bad credentials and never records them', async () => {
    const before = (await t.pool.query('SELECT count(*)::int AS n FROM plugin_installs')).rows[0].n;
    expect((await check('version=2.2.7', 'wpcs-waas-host', basic(crypto.randomUUID(), 'wrong'))).status).toBe(403);
    expect((await check('version=2.2.7', 'wpcs-waas-host', ADMIN)).status).toBe(403);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM plugin_installs')).rows[0].n).toBe(before);
  });

  it('503s when updates are not configured or the store is down, but still records the version', async () => {
    const res = await t.app.request('/v1/plugins/waas-payments/update?version=0.1.0&site=https://unconfigured.example', { headers: { Authorization: t.auth } });
    expect(res.status).toBe(503);
    expect((await t.pool.query("SELECT version FROM plugin_installs WHERE site = 'https://unconfigured.example'")).rows[0].version).toBe('0.1.0');

    store.failing = true;
    try {
      expect((await check('version=2.2.7')).status).toBe(503);
    } finally {
      store.failing = false;
    }
  });
});

describe('pins', () => {
  let other: string;
  let otherAuth: string;
  beforeAll(async () => {
    other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Other storefront') RETURNING id")).rows[0]!.id;
    const { key, secret } = await createApiKey(t.pool, other);
    otherAuth = basic(key, secret);
  });

  it('holds one product at a release; others follow the channel', async () => {
    const res = await call('PUT', `/admin/products/${t.productId}/plugins/wpcs-waas-host/pin`, ADMIN, { version: '2.2.8' });
    expect(res.status).toBe(200);
    const pin = await res.json();
    expect(validPin(pin), ajv.errorsText(validPin.errors)).toBe(true);
    expect(pin).toMatchObject({ productId: t.productId, slug: 'wpcs-waas-host', version: '2.2.8' });

    const pinned = await (await check('version=2.2.7&channel=beta')).json();
    expect(pinned).toMatchObject({ version: '2.2.8', pinned: true });
    expect(pinned.package).toContain('/wpcs-waas-host/2.2.8/');
    expect((await (await check('version=2.2.7', 'wpcs-waas-host', otherAuth)).json()).version).toBe('2.3.0');
  });

  it('refuses a pin to a release that does not exist, or a bad version, slug or product', async () => {
    expect((await call('PUT', `/admin/products/${t.productId}/plugins/wpcs-waas-host/pin`, ADMIN, { version: '9.9.9' })).status).toBe(400);
    expect((await call('PUT', `/admin/products/${t.productId}/plugins/wpcs-waas-host/pin`, ADMIN, { version: 'latest' })).status).toBe(400);
    expect((await call('PUT', `/admin/products/${t.productId}/plugins/akismet/pin`, ADMIN, { version: '2.3.0' })).status).toBe(404);
    expect((await call('PUT', `/admin/products/${crypto.randomUUID()}/plugins/wpcs-waas-host/pin`, ADMIN, { version: '2.3.0' })).status).toBe(404);
    expect((await call('PUT', `/admin/products/${t.productId}/plugins/wpcs-waas-host/pin`, t.auth, { version: '2.3.0' })).status).toBe(403);
  });

  it('lists installs and pins for the dashboard', async () => {
    await check('version=2.2.7&site=https://other.example', 'wpcs-waas-host', otherAuth);
    const res = await call('GET', `/admin/plugins?slug=wpcs-waas-host`, ADMIN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validInstalls(body), ajv.errorsText(validInstalls.errors)).toBe(true);
    expect(body.installs.map((i: { site: string }) => i.site)).toEqual(expect.arrayContaining(['https://shop.example.com', 'https://other.example']));
    expect(body.pins).toEqual([expect.objectContaining({ productId: t.productId, version: '2.2.8' })]);

    const only = await (await call('GET', `/admin/plugins?productId=${other}`, ADMIN)).json();
    expect(only.installs.every((i: { productId: string }) => i.productId === other)).toBe(true);
    expect(only.pins).toEqual([]);
  });

  it('unpinning puts the product back on its channel', async () => {
    expect((await call('DELETE', `/admin/products/${t.productId}/plugins/wpcs-waas-host/pin`, ADMIN)).status).toBe(200);
    expect((await call('DELETE', `/admin/products/${t.productId}/plugins/wpcs-waas-host/pin`, ADMIN)).status).toBe(200);
    expect(await (await check('version=2.2.7')).json()).toMatchObject({ version: '2.3.0', pinned: false });
  });

  it('a pinned release that vanished from the bucket is a 404, not the channel', async () => {
    await call('PUT', `/admin/products/${t.productId}/plugins/wpcs-waas-host/pin`, ADMIN, { version: '2.2.8' });
    store.objects.delete(manifestKey('wpcs-waas-host', '2.2.8'));
    expect((await check('version=2.2.7')).status).toBe(404);
    await call('DELETE', `/admin/products/${t.productId}/plugins/wpcs-waas-host/pin`, ADMIN);
  });
});

describe('S3ReleaseStore', () => {
  const config = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'waas-releases', region: 'auto', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-secret' };

  it('reads JSON, returns null for a missing or unparseable object, and caches for a minute', async () => {
    const calls: string[] = [];
    const bodies: Record<string, Response> = {};
    const fetchImpl = (async (url: string) => {
      calls.push(new URL(url).pathname);
      const path = new URL(url).pathname;
      if (path.endsWith('/stable.json')) return new Response(JSON.stringify({ version: '2.3.0' }));
      if (path.endsWith('/broken.json')) return new Response('{nope');
      return bodies[path] ?? new Response('', { status: 404 });
    }) as typeof fetch;
    let now = 0;
    const s = new S3ReleaseStore(config, fetchImpl, () => now);
    expect(await s.getJson('releases/wpcs-waas-host/channels/stable.json')).toEqual({ version: '2.3.0' });
    expect(await s.getJson('releases/wpcs-waas-host/channels/stable.json')).toEqual({ version: '2.3.0' });
    expect(calls).toEqual(['/waas-releases/releases/wpcs-waas-host/channels/stable.json']);
    now = 61_000;
    await s.getJson('releases/wpcs-waas-host/channels/stable.json');
    expect(calls).toHaveLength(2);
    expect(await s.getJson('releases/x/missing.json')).toBeNull();
    expect(await s.getJson('releases/x/broken.json')).toBeNull();
  });

  it('throws when the bucket answers with an error, so the route can 503', async () => {
    const s = new S3ReleaseStore(config, (async () => new Response('', { status: 500 })) as typeof fetch);
    await expect(s.getJson('releases/wpcs-waas-host/channels/stable.json')).rejects.toThrow('HTTP 500');
  });

  it('presigns GETs of the zip without exposing the secret', () => {
    const url = new URL(new S3ReleaseStore(config).presignGet('releases/wpcs-waas-host/2.3.0/wpcs-waas-host.zip', 600));
    expect(url.pathname).toBe('/waas-releases/releases/wpcs-waas-host/2.3.0/wpcs-waas-host.zip');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.toString()).not.toContain('not-a-secret');
  });
});

describe('parseManifest', () => {
  it('accepts what the release workflow writes and checks the version it was asked for', () => {
    const m = release('waas-payments', '0.2.0');
    expect(parseManifest(m, 'waas-payments')).toMatchObject({ version: '0.2.0' });
    expect(parseManifest(m, 'waas-payments', '0.2.0')).not.toBeNull();
    expect(parseManifest(m, 'waas-payments', '0.3.0')).toBeNull();
    expect(parseManifest(null, 'waas-payments')).toBeNull();
    expect(parseManifest('x', 'waas-payments')).toBeNull();
  });
});

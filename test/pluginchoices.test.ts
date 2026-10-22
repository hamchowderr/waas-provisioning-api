// Plugin choices (docs/plugin-choices.md): /v1/plugin-choices, the admin and account routes, and how a
// version build gets them. wordpress.org is replaced with a fake directory.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { createApiKey } from '../src/keys.ts';
import { createAjv } from '../src/openapi.ts';
import { Status } from '../src/status.ts';
import { toPlugin, type WpOrg } from '../src/wporg.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';
import { pluginZip } from './zip.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spec: any = parse(readFileSync(new URL('../openapi/plugin-choices.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: spec.components }, 'choices');
const validSearch = ajv.compile({ $ref: 'choices#/components/schemas/PluginSearchResult' });
const validChoice = ajv.compile({ $ref: 'choices#/components/schemas/PluginChoice' });
const validUpload = ajv.compile({ $ref: 'choices#/components/schemas/PluginUpload' });

const zip = (slug: string, version: string) => new Uint8Array(Buffer.from(`PK fake zip of ${slug} ${version}`));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A directory with a few plugins; counts downloads. */
class FakeWpOrg implements WpOrg {
  downloads: string[] = [];
  down = false;
  plugins: Record<string, { name: string; version: string; versions: string[] }> = {
    'contact-form-7': { name: 'Contact Form 7', version: '6.1.2', versions: ['6.0.0', '6.1.2'] },
    'wp-super-cache': { name: 'WP Super Cache', version: '3.0.1', versions: ['3.0.1'] },
    'the-events-calendar': { name: 'The Events Calendar &amp; More', version: '6.15.0', versions: ['6.15.0'] },
  };
  private info(slug: string) {
    const p = this.plugins[slug]!;
    return toPlugin({ slug, name: p.name, version: p.version, icons: { '2x': `https://ps.w.org/${slug}/assets/icon-256x256.png` }, rating: 90, active_installs: 1000, last_updated: '2026-09-01 4:47pm GMT', tested: '7.1', requires_php: '7.4' });
  }
  async search(query: string, page: number) {
    if (this.down) throw new Error('HTTP 502');
    const plugins = Object.keys(this.plugins).filter((s) => s.includes(query) || this.plugins[s]!.name.toLowerCase().includes(query)).map((s) => this.info(s));
    return { page, pages: 1, results: plugins.length, plugins };
  }
  async plugin(slug: string) {
    if (this.down) throw new Error('HTTP 502');
    return this.plugins[slug] ? { ...this.info(slug), versions: this.plugins[slug]!.versions } : null;
  }
  async download(slug: string, version: string) {
    this.downloads.push(`${slug}@${version}`);
    const body = zip(slug, version);
    return { body, sha256: sha(body) };
  }
}

let t: TestContext;
let wporg: FakeWpOrg;
let app: ReturnType<typeof createApp>;
const call = (method: string, path: string, body?: unknown, auth: string = t.auth) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  t = await setup();
  wporg = new FakeWpOrg();
  app = createApp({ ...t.deps, wporg });
});
afterAll(async () => {
  await t.close();
});

describe('plugin choices', () => {
  it('searches wordpress.org and marks plugins stores cannot have', async () => {
    const res = await call('GET', '/v1/plugin-choices/search?q=cache');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(validSearch(body), JSON.stringify(validSearch.errors)).toBe(true);
    expect(body.plugins).toEqual([
      expect.objectContaining({ slug: 'wp-super-cache', name: 'WP Super Cache', icon: 'https://ps.w.org/wp-super-cache/assets/icon-256x256.png', blocked: 'Page caching is part of the hosting.' }),
    ]);
    expect((await call('GET', '/v1/plugin-choices/search?q=e')).status).toBe(400);
    wporg.down = true;
    expect((await call('GET', '/v1/plugin-choices/search?q=forms')).status).toBe(503);
    wporg.down = false;
  });

  it('adds a plugin pinned to its newest version and keeps its zip', async () => {
    const res = await call('PUT', '/v1/plugin-choices/contact-form-7', { siteTypes: ['website'] });
    expect(res.status).toBe(200);
    const choice = (await res.json()) as any;
    expect(validChoice(choice), JSON.stringify(validChoice.errors)).toBe(true);
    expect(choice).toMatchObject({ slug: 'contact-form-7', name: 'Contact Form 7', action: 'add', version: '6.1.2', sha256: sha(zip('contact-form-7', '6.1.2')), siteTypes: ['website'], shared: false });
    expect(t.provisioner.pluginPackages.has('contact-form-7@6.1.2')).toBe(true);
    // Saving it again without a new version doesn't download it again.
    await call('PUT', '/v1/plugin-choices/contact-form-7', { siteTypes: [] });
    expect(wporg.downloads.filter((d) => d === 'contact-form-7@6.1.2')).toHaveLength(1);
    // An older version on request; one wordpress.org doesn't have is refused.
    expect(((await (await call('PUT', '/v1/plugin-choices/contact-form-7', { version: '6.0.0' })).json()) as any).version).toBe('6.0.0');
    expect((await call('PUT', '/v1/plugin-choices/contact-form-7', { version: '5.0.0' })).status).toBe(400);
    // Names come without HTML entities.
    expect(((await (await call('PUT', '/v1/plugin-choices/the-events-calendar', {})).json()) as any).name).toBe('The Events Calendar & More');
  });

  it('refuses blocked, unknown and malformed plugins', async () => {
    const blocked = await call('PUT', '/v1/plugin-choices/wp-super-cache', {});
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as any).message).toContain('Page caching is part of the hosting');
    expect((await call('PUT', '/v1/plugin-choices/waas-client', {})).status).toBe(400);
    expect((await call('PUT', '/v1/plugin-choices/not-on-wporg', {})).status).toBe(400);
    expect((await call('PUT', '/v1/plugin-choices/Bad_Slug', {})).status).toBe(400);
    expect((await call('PUT', '/v1/plugin-choices/contact-form-7', { siteTypes: ['bad type!'] })).status).toBe(400);
    expect((await call('PUT', '/v1/plugin-choices/contact-form-7', { action: 'remove' })).status).toBe(400);
    expect((await call('PUT', '/v1/plugin-choices/rank-math', { action: 'off', version: '1.0' })).status).toBe(400);
  });

  it('switches off a template plugin without downloading anything', async () => {
    const res = await call('PUT', '/v1/plugin-choices/wp-fusion-lite', { action: 'off', siteTypes: ['website'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug: 'wp-fusion-lite', name: 'wp-fusion-lite', action: 'off', siteTypes: ['website'] });
    expect(wporg.downloads.some((d) => d.startsWith('wp-fusion-lite'))).toBe(false);
  });

  it('builds them into the next version and says which are in production', async () => {
    const before = (await (await call('GET', '/v1/plugin-choices')).json()) as any[];
    expect(before.map((c) => [c.slug, c.inProduction])).toEqual([
      ['contact-form-7', false],
      ['the-events-calendar', false],
      ['wp-fusion-lite', false],
    ]);
    const v = (await (await call('POST', '/v1/versions', { name: 'with-plugins', phpVersion: '8.3', wordPressVersion: '7.1', useCustomUpload: true })).json()) as { id: string };
    await waitFor(async () => (await t.pool.query('SELECT status FROM versions WHERE id = $1', [v.id])).rows[0].status === Status.Done);
    expect(t.provisioner.versions.get(v.id)!.plugins).toEqual([
      { slug: 'contact-form-7', action: 'add', version: '6.0.0', sha256: sha(zip('contact-form-7', '6.0.0')), siteTypes: [] },
      { slug: 'the-events-calendar', action: 'add', version: '6.15.0', sha256: sha(zip('the-events-calendar', '6.15.0')), siteTypes: [] },
      { slug: 'wp-fusion-lite', action: 'off', siteTypes: ['website'] },
    ]);
    const kept = (await t.pool.query('SELECT plugin_choices FROM versions WHERE id = $1', [v.id])).rows[0].plugin_choices;
    expect(kept[0]).toMatchObject({ slug: 'contact-form-7', name: 'Contact Form 7', file: 'contact-form-7/contact-form-7.php' });
    expect((await call('PUT', '/v1/versions/production', { versionId: v.id })).status).toBe(200);

    // Changing a choice afterwards makes it not in production until the next version.
    await call('PUT', '/v1/plugin-choices/contact-form-7', {});
    const after = (await (await call('GET', '/v1/plugin-choices?checkUpdates=true')).json()) as any[];
    for (const c of after) expect(validChoice(c), JSON.stringify(validChoice.errors)).toBe(true);
    expect(after.map((c) => [c.slug, c.inProduction, c.latestVersion])).toEqual([
      ['contact-form-7', false, '6.1.2'],
      ['the-events-calendar', true, '6.15.0'],
      ['wp-fusion-lite', true, undefined],
    ]);
  });

  it('removes a choice', async () => {
    expect((await call('DELETE', '/v1/plugin-choices/the-events-calendar')).status).toBe(200);
    expect((await call('DELETE', '/v1/plugin-choices/the-events-calendar')).status).toBe(400);
  });

  it("shares a reseller's choices with its storefronts, the storefront's own winning", async () => {
    const resellerId = (await t.pool.query("INSERT INTO resellers (name) VALUES ('Partner') RETURNING id")).rows[0].id;
    const productId = (await t.pool.query("INSERT INTO products (name, reseller_id) VALUES ('Partner shop', $1) RETURNING id", [resellerId])).rows[0].id;
    const partner = await createApiKey(t.pool, { resellerId });
    const partnerAuth = basic(partner.key, partner.secret);
    // A partner key without a productId works on the shared choices.
    expect((await call('PUT', '/v1/plugin-choices/contact-form-7', {}, partnerAuth)).status).toBe(200);
    expect((await call('PUT', '/v1/plugin-choices/the-events-calendar', {}, partnerAuth)).status).toBe(200);
    // With a productId, on that storefront's own; ?shared=true on the shared ones again.
    expect((await call('PUT', `/v1/plugin-choices/the-events-calendar?productId=${productId}`, { action: 'off' }, partnerAuth)).status).toBe(200);
    expect((await call('PUT', `/v1/plugin-choices/wp-fusion-lite?productId=${productId}&shared=true`, { action: 'off' }, partnerAuth)).status).toBe(200);
    const list = (await (await call('GET', `/v1/plugin-choices?productId=${productId}`, undefined, partnerAuth)).json()) as any[];
    expect(list.map((c) => [c.slug, c.action, c.shared])).toEqual([
      ['contact-form-7', 'add', true],
      ['the-events-calendar', 'off', false],
      ['wp-fusion-lite', 'off', true],
    ]);
    // The storefront's own key sees the same and can't change the shared ones.
    const own = await createApiKey(t.pool, productId);
    const ownAuth = basic(own.key, own.secret);
    expect(((await (await call('GET', '/v1/plugin-choices', undefined, ownAuth)).json()) as any[]).length).toBe(3);
    expect((await call('DELETE', '/v1/plugin-choices/contact-form-7', undefined, ownAuth)).status).toBe(400);
    // The admin API has both.
    const admin = `Bearer ${TEST_ADMIN_TOKEN}`;
    expect(((await (await call('GET', `/admin/resellers/${resellerId}/plugin-choices`, undefined, admin)).json()) as any[]).map((c) => c.slug)).toEqual([
      'contact-form-7',
      'the-events-calendar',
      'wp-fusion-lite',
    ]);
    expect((await call('PUT', `/admin/products/${productId}/plugin-choices/contact-form-7`, { siteTypes: ['store'] }, admin)).status).toBe(200);
    const mixed = (await (await call('GET', `/admin/products/${productId}/plugin-choices`, undefined, admin)).json()) as any[];
    expect(mixed[0]).toMatchObject({ slug: 'contact-form-7', siteTypes: ['store'], shared: false });
  });

  it('adds an uploaded premium plugin with its licence key', async () => {
    const start = (await (await call('POST', '/v1/plugin-choices/uploads')).json()) as any;
    expect(start).toMatchObject({ uploadUrl: expect.stringContaining(start.id), expiresIn: 3600, maxBytes: 64 * 1024 * 1024 });
    // Checking before the zip is there says so; then the zip arrives.
    expect((await call('POST', `/v1/plugin-choices/uploads/${start.id}/check`)).status).toBe(400);
    const zip = pluginZip('gravityforms', '2.9.1');
    t.provisioner.pluginUploads.set(start.id, zip);
    const checked = (await (await call('POST', `/v1/plugin-choices/uploads/${start.id}/check`)).json()) as any;
    expect(validUpload(checked), JSON.stringify(validUpload.errors)).toBe(true);
    expect(checked).toMatchObject({ status: 'ready', slug: 'gravityforms', name: 'gravityforms Pro', version: '2.9.1', sha256: sha(zip), sizeBytes: zip.length, shared: false });

    // Only for its own slug, with a sensible licence.
    expect((await call('PUT', '/v1/plugin-choices/other-plugin', { uploadId: start.id })).status).toBe(400);
    expect((await call('PUT', '/v1/plugin-choices/gravityforms', { uploadId: start.id, licence: { 'bad name': 'x' } })).status).toBe(400);
    expect((await call('PUT', '/v1/plugin-choices/gravityforms', { uploadId: start.id, version: '2.9.1' })).status).toBe(400);
    const res = await call('PUT', '/v1/plugin-choices/gravityforms', { uploadId: start.id, siteTypes: ['store'], licence: { GF_LICENSE_KEY: 'gf-secret-123' } });
    expect(res.status).toBe(200);
    const choice = (await res.json()) as any;
    expect(validChoice(choice), JSON.stringify(validChoice.errors)).toBe(true);
    expect(choice).toMatchObject({ slug: 'gravityforms', source: 'upload', uploadId: start.id, version: '2.9.1', sha256: sha(zip), licenceConstants: ['GF_LICENSE_KEY'] });
    expect(JSON.stringify(choice)).not.toContain('gf-secret-123');
    const stored = (await t.pool.query("SELECT licence FROM plugin_choices WHERE slug = 'gravityforms'")).rows[0].licence;
    expect(stored).not.toContain('gf-secret-123');
    // Saving it again for other site types keeps the upload and the licence.
    const again = (await (await call('PUT', '/v1/plugin-choices/gravityforms', { siteTypes: [] })).json()) as any;
    expect(again).toMatchObject({ source: 'upload', uploadId: start.id, licenceConstants: ['GF_LICENSE_KEY'], siteTypes: [] });
    // In use, so it can't be deleted.
    expect((await call('DELETE', `/v1/plugin-choices/uploads/${start.id}`)).status).toBe(400);

    // The build gets the upload and the licence, decrypted; the version row keeps it encrypted.
    const v = (await (await call('POST', '/v1/versions', { name: 'with-premium', phpVersion: '8.3', wordPressVersion: '7.1', useCustomUpload: true })).json()) as { id: string };
    await waitFor(async () => (await t.pool.query('SELECT status FROM versions WHERE id = $1', [v.id])).rows[0].status === Status.Done);
    expect(t.provisioner.versions.get(v.id)!.plugins).toContainEqual({
      slug: 'gravityforms',
      action: 'add',
      version: '2.9.1',
      sha256: sha(zip),
      siteTypes: [],
      uploadId: start.id,
      constants: { GF_LICENSE_KEY: 'gf-secret-123' },
    });
    expect(JSON.stringify((await t.pool.query('SELECT plugin_choices FROM versions WHERE id = $1', [v.id])).rows[0].plugin_choices)).not.toContain('gf-secret-123');

    // Clearing the licence, then removing the choice, frees the upload.
    expect(((await (await call('PUT', '/v1/plugin-choices/gravityforms', { licence: null })).json()) as any).licenceConstants).toEqual([]);
    expect((await call('DELETE', '/v1/plugin-choices/gravityforms')).status).toBe(200);
    expect((await call('DELETE', `/v1/plugin-choices/uploads/${start.id}`)).status).toBe(200);
    expect(t.provisioner.pluginUploads.has(start.id)).toBe(false);
  });

  it('rejects uploads that are hacked, blocked or not plugins, and deletes them', async () => {
    const tryZip = async (zip: Uint8Array) => {
      const { id } = (await (await call('POST', '/v1/plugin-choices/uploads')).json()) as any;
      t.provisioner.pluginUploads.set(id, zip);
      const checked = (await (await call('POST', `/v1/plugin-choices/uploads/${id}/check`)).json()) as any;
      expect(t.provisioner.pluginUploads.has(id)).toBe(false);
      expect(checked.status).toBe('rejected');
      expect((await call('PUT', `/v1/plugin-choices/${checked.slug ?? 'nulled'}`, { uploadId: id })).status).toBe(400);
      return checked.reason as string;
    };
    expect(await tryZip(pluginZip('nulled', '1.0', { 'nulled/includes/l.php': '<?php eval(base64_decode($k));' }))).toContain('runs decoded code');
    expect(await tryZip(pluginZip('wp-super-cache', '3.0'))).toContain('Page caching is part of the hosting');
    expect(await tryZip(new Uint8Array(Buffer.from('hello')))).toBe('The file is not a zip');
    const list = (await (await call('GET', '/v1/plugin-choices/uploads')).json()) as any[];
    for (const u of list) expect(validUpload(u), JSON.stringify(validUpload.errors)).toBe(true);
    expect(list.slice(0, 3).map((u) => u.status)).toEqual(['rejected', 'rejected', 'rejected']);
    // The admin API has them too, for the storefront and for a reseller.
    const admin = `Bearer ${TEST_ADMIN_TOKEN}`;
    const productId = (await t.pool.query('SELECT product_id FROM plugin_uploads LIMIT 1')).rows[0].product_id;
    expect(((await (await call('GET', `/admin/products/${productId}/plugin-choices/uploads`, undefined, admin)).json()) as any[]).length).toBe(list.length);
    const resellerId = (await t.pool.query("INSERT INTO resellers (name) VALUES ('Uploader') RETURNING id")).rows[0].id;
    const shared = (await (await call('POST', `/admin/resellers/${resellerId}/plugin-choices/uploads`, undefined, admin)).json()) as any;
    t.provisioner.pluginUploads.set(shared.id, pluginZip('shared-pro'));
    expect(await (await call('POST', `/admin/resellers/${resellerId}/plugin-choices/uploads/${shared.id}/check`, undefined, admin)).json()).toMatchObject({ status: 'ready', shared: true });
    // Another owner can't see or use it.
    expect((await call('POST', `/v1/plugin-choices/uploads/${shared.id}/check`)).status).toBe(400);
    expect((await call('PUT', '/v1/plugin-choices/shared-pro', { uploadId: shared.id })).status).toBe(400);
  });

  it('caps how many plugins are added', async () => {
    const productId = (await t.pool.query("INSERT INTO products (name) VALUES ('Many plugins') RETURNING id")).rows[0].id;
    for (let i = 0; i < 25; i++) {
      await t.pool.query("INSERT INTO plugin_choices (product_id, slug, name, action, version, sha256) VALUES ($1, $2, $2, 'add', '1.0', 'x')", [productId, `plugin-${i}`]);
    }
    const res = await call('PUT', `/admin/products/${productId}/plugin-choices/contact-form-7`, {}, `Bearer ${TEST_ADMIN_TOKEN}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).message).toBe('At most 25 plugins can be added');
  });
});

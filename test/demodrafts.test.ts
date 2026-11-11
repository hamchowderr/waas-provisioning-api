// Demos people build on Playground (src/demodrafts.ts): saving one before checkout, a store created with it, and the
// demo's content put on that store through its site routes once it is built.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRAFTS_PER_HOUR, IMAGE_PLACEHOLDER, MAX_IMAGE_BYTES, purgeExpiredDemoDrafts, SITE_TYPES } from '../src/demodrafts.ts';
import type { SiteRequest } from '../src/sitekeys.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;
/** What each store's site routes were asked, and what the fake store has. */
const calls: { storeId: string; request: SiteRequest }[] = [];
let failOn: string | undefined;

const PAGES = [
  { id: 11, slug: 'home', title: 'Home' },
  { id: 12, slug: 'about', title: 'About' },
];

beforeAll(async () => {
  t = await setup({
    siteCall: async (storeId, _domain, request) => {
      calls.push({ storeId, request });
      if (failOn && request.path === failOn) return { status: 500, body: { message: 'The store broke' } };
      if (request.method === 'GET' && request.path === '/pages') return { status: 200, body: PAGES };
      if (request.method === 'GET' && request.path === '/menus') return { status: 200, body: [{ id: 40, title: 'Main menu', content: '' }] };
      if (request.path === '/media') return { status: 200, body: { id: 90, url: `https://store.example/wp-content/uploads/${(request.body as { url: string }).url.split('/').pop()!.split('?')[0]}`, alt: '' } };
      return { status: 200, body: {} };
    },
  });
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});
afterAll(async () => {
  await t.close();
});

const content = (over: Record<string, unknown> = {}) => ({
  pages: [
    { title: 'Home', slug: 'home', content: `<!-- wp:image --><figure class="wp-block-image"><img src="${IMAGE_PLACEHOLDER}team.jpg"/></figure><!-- /wp:image -->` },
    { title: 'Our work', slug: 'our-work', content: '<!-- wp:paragraph --><p>Roofs.</p><!-- /wp:paragraph -->', status: 'draft' },
  ],
  styles: { settings: { color: { palette: { theme: [] } } }, styles: { color: { background: 'var:preset|color|base' } } },
  header: '<!-- wp:site-title /-->',
  menus: [{ title: 'Main menu', content: '<!-- wp:navigation-link {"label":"Home","url":"/"} /-->' }],
  business: { what: 'Roofing in Oklahoma City' },
  ...over,
});

async function save(body: Record<string, unknown>) {
  const res = await t.call('POST', '/demos/drafts', { body, auth: null });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function createStore(over: Record<string, unknown> = {}) {
  const res = await t.call('POST', '/v1/tenants', {
    body: { name: 'Ironclad Roofing', ...OWNER, phpConstants: { ANYPRESS_TENANT_ROLES: { value: 'website', isPrivate: false } }, ...over },
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('demo drafts', () => {
  it('know every site type of the store template', () => {
    const roles = JSON.parse(readFileSync(new URL('../templates/anypress-store/roles.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect([...SITE_TYPES].sort()).toEqual(Object.keys(roles).sort());
  });

  it('save a demo with no API key, hand out photo upload links, and show checkout what it is', async () => {
    const saved = await save({ siteType: 'website', kit: 'ridge/ironclad-roofing', content: content(), images: ['team.jpg'] });
    expect(saved.status).toBe(201);
    expect(saved.body.id).toMatch(/^demo_[A-Za-z0-9_-]{22}$/);
    expect(saved.body.maxImageBytes).toBe(MAX_IMAGE_BYTES);
    expect(saved.body.uploads).toEqual([{ name: 'team.jpg', uploadUrl: expect.stringContaining(`/demos/${saved.body.id}/team.jpg`) }]);

    const shown = await t.call('GET', `/demos/drafts/${saved.body.id}`, { auth: null });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual({
      id: saved.body.id,
      siteType: 'website',
      kit: 'ridge/ironclad-roofing',
      productId: null,
      pages: ['Home', 'Our work'],
      expiresAt: saved.body.expiresAt,
      used: false,
    });
    expect((await t.call('GET', '/demos/drafts/demo_nope', { auth: null })).status).toBe(404);
  });

  it('refuse what the site routes do not take: code, unknown site types, bad slugs and photo names', async () => {
    expect((await save({ siteType: 'shop', content: content() })).status).toBe(400);
    expect((await save({ siteType: 'website', content: { pages: [] } })).status).toBe(400);
    expect((await save({ siteType: 'website', content: content({ plugins: ['evil/evil.php'] }) })).status).toBe(400);
    expect((await save({ siteType: 'website', content: content({ pages: [{ title: 'X', slug: '../x' }] }) })).status).toBe(400);
    expect((await save({ siteType: 'website', content: content({ business: { password: 'x' } }) })).status).toBe(400);
    expect((await save({ siteType: 'website', content: content(), images: ['shell.php'] })).status).toBe(400);
    expect((await save({ siteType: 'website', content: content(), productId: '00000000-0000-0000-0000-000000000000' })).status).toBe(400);
    const huge = await save({ siteType: 'website', content: content({ pages: Array.from({ length: 5 }, (_, i) => ({ title: `P${i}`, slug: `p${i}`, content: 'x'.repeat(450_000) })) }) });
    expect(huge.status).toBe(413);
  });

  it('build the store as usual, then put the demo on it through its site routes, once', async () => {
    const saved = await save({ siteType: 'website', content: content(), images: ['team.jpg', 'never-sent.png'] });
    t.provisioner.uploadDemoImage(saved.body.id, 'team.jpg', 2048);
    const created = await createStore({ demoDraftId: saved.body.id });
    expect(created.status).toBe(200);
    const storeId = created.body.id as string;
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?tenantId=${storeId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);

    const asked = calls.filter((c) => c.storeId === storeId).map((c) => `${c.request.method} ${c.request.path}`);
    expect(asked).toEqual(['POST /media', 'PATCH /styles', 'PUT /parts/header', 'GET /pages', 'PUT /pages/11', 'POST /pages', 'GET /menus', 'PUT /menus/40', 'PATCH /business']);
    const home = calls.find((c) => c.storeId === storeId && c.request.path === '/pages/11')!.request.body as { content: string; status: string };
    expect(home.content).toContain('https://store.example/wp-content/uploads/team.jpg');
    expect(home.content).not.toContain(IMAGE_PLACEHOLDER);
    expect(home.status).toBe('publish');
    expect((calls.find((c) => c.storeId === storeId && c.request.method === 'POST' && c.request.path === '/pages')!.request.body as { status: string }).status).toBe('draft');

    const { rows } = await t.pool.query('SELECT tenant_id, used_at, applied_at, apply_error FROM demo_drafts WHERE id = $1', [saved.body.id]);
    expect(rows[0]).toMatchObject({ tenant_id: storeId, apply_error: null });
    expect(rows[0].applied_at).not.toBeNull();
    expect(t.provisioner.demoImages.has(`${saved.body.id}/team.jpg`)).toBe(false);
    expect(((await (await t.call('GET', `/demos/drafts/${saved.body.id}`, { auth: null })).json()) as { used: boolean }).used).toBe(true);

    const again = await createStore({ demoDraftId: saved.body.id, externalId: 'second-store' });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already been used/);
  });

  it('only for a store of the demo’s site type, on its own storefront, and not for a site moved in', async () => {
    const saved = await save({ siteType: 'bookings', content: content() });
    const wrongType = await createStore({ demoDraftId: saved.body.id, externalId: 'wrong-type' });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.message).toMatch(/bookings site, not website/);
    expect((await t.pool.query('SELECT 1 FROM tenants WHERE external_id = $1', ['wrong-type'])).rowCount).toBe(0);

    const other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Another seller') RETURNING id")).rows[0]!.id;
    const theirs = await save({ siteType: 'website', content: content(), productId: other });
    expect((await createStore({ demoDraftId: theirs.body.id, externalId: 'not-theirs' })).body.message).toMatch(/another storefront/);
    expect((await createStore({ demoDraftId: saved.body.id, uploadCustomSnapshot: true, externalId: 'moved' })).status).toBe(400);
  });

  it('leave the store as its template made it when the demo cannot be applied, and say why', async () => {
    const saved = await save({ siteType: 'website', content: content() });
    failOn = '/parts/header';
    try {
      const created = await createStore({ demoDraftId: saved.body.id, externalId: 'header-breaks' });
      await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?tenantId=${created.body.id}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
    } finally {
      failOn = undefined;
    }
    const { rows } = await t.pool.query('SELECT applied_at, apply_error FROM demo_drafts WHERE id = $1', [saved.body.id]);
    expect(rows[0]).toMatchObject({ applied_at: null, apply_error: 'PUT /parts/header: The store broke' });
  });

  it('are removed with their photos when nobody used them in time', async () => {
    const saved = await save({ siteType: 'website', content: content(), images: ['team.jpg'] });
    t.provisioner.uploadDemoImage(saved.body.id, 'team.jpg', 10);
    await t.pool.query("UPDATE demo_drafts SET expires_at = now() - interval '1 minute' WHERE id = $1", [saved.body.id]);
    expect((await t.call('GET', `/demos/drafts/${saved.body.id}`, { auth: null })).status).toBe(404);
    expect(await purgeExpiredDemoDrafts(t.pool, t.provisioner)).toBe(1);
    expect(t.provisioner.demoImages.has(`${saved.body.id}/team.jpg`)).toBe(false);
  });

  it('are rate limited for everyone together', async () => {
    await t.pool.query(`INSERT INTO demo_drafts (id, site_type, content, expires_at) SELECT 'demo_' || lpad(g::text, 22, '0'), 'website', '{"pages":[]}', now() + interval '1 day' FROM generate_series(1, $1) g`, [DRAFTS_PER_HOUR]);
    expect((await save({ siteType: 'website', content: content() })).status).toBe(429);
  });
});

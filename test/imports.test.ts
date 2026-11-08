import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicKey } from 'node:crypto';
import { importCode, importFailureReason, importPartSize, importWarnings, maxImportBytes, purgeExpiredImports, tokenFromCode } from '../src/imports.ts';
import { Status } from '../src/status.ts';
import { setup, TEST_ADMIN_TOKEN, waitFor, type TestContext, OWNER } from './helpers.ts';

// Sites moved in from another host (src/imports.ts): the import code, the export plugin's calls, and stores that keep
// their own plugins and themes.
let t: TestContext;
let versionId: string;
let otherVersionId: string;

interface Created {
  id: string;
  externalId: string;
  baseDomain: string;
  uploadUrl?: string;
  importCode?: string;
  message?: string;
}

async function createImport(body: object = {}) {
  const res = await t.call('POST', '/v1/tenants', { body: { name: 'Moved in', uploadCustomSnapshot: true, ...body } });
  return { status: res.status, body: (await res.json()) as Created };
}

/** A call the export plugin makes: no API key. */
async function plugin(path: string, body: object) {
  const res = await t.call('POST', `/imports/${path}`, { body, auth: null });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function tenant(id: string) {
  return ((await (await t.call('GET', `/v1/tenants?tenantId=${id}`)).json()) as Record<string, unknown>[])[0];
}

async function version(name: string) {
  const res = await t.call('POST', '/v1/versions', { body: { name, phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const id = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${id}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  return id;
}

/** Creates a store waiting for its site, "uploads" an archive of `bytes`, starts the move and waits for it. */
async function moveIn(bytes = 50 * 1024 ** 2) {
  const { body } = await createImport();
  t.provisioner.imports.set(body.id, bytes);
  expect((await plugin('start', { code: body.importCode, source: { home: 'https://old.example.com', tablePrefix: 'wpx_' } })).status).toBe(200);
  await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
  return body;
}

beforeAll(async () => {
  t = await setup();
  versionId = await version('v1');
  otherVersionId = await version('v2');
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});
afterAll(async () => {
  await t.close();
});

describe('import codes', () => {
  it('carry the API address and the token, and accept the bare token too', () => {
    const code = importCode('https://api.anypress.io', 'secret-token');
    expect(code.startsWith('AP1.')).toBe(true);
    expect(JSON.parse(Buffer.from(code.slice(4), 'base64url').toString())).toEqual({ u: 'https://api.anypress.io', t: 'secret-token' });
    expect(tokenFromCode(`  ${code} `)).toBe('secret-token');
    expect(tokenFromCode('secret-token')).toBe('secret-token');
    expect(tokenFromCode('AP1.not-json')).toBe('');
  });

  it('cap the archive at the store size, within one upload', () => {
    expect(maxImportBytes('small')).toBe(5 * 1024 ** 3);
    expect(maxImportBytes('large')).toBe(5 * 1024 ** 3);
  });
});

describe('moving a site in', () => {
  it('creates a store that waits for its site, with an import code and upload link, and no build yet', async () => {
    const { status, body } = await createImport();
    expect(status).toBe(200);
    expect(body.importCode).toMatch(/^AP1\./);
    expect(body.uploadUrl).toBe(`https://uploads.waas.example/imports/${body.id}`);
    expect(await tenant(body.id)).toMatchObject({ statusCode: Status.Pending, keepsOwnCode: true, waitingForSite: true });
    expect(t.provisioner.stores.has(body.id)).toBe(false);
    // Only the token's hash is stored.
    const token = tokenFromCode(body.importCode!);
    const { rows } = await t.pool.query('SELECT token_hash FROM tenant_imports WHERE tenant_id = $1', [body.id]);
    expect(rows[0].token_hash).not.toContain(token);
  });

  it('builds the store from the upload once started, keeping its own code, and then drops the upload', async () => {
    const body = await moveIn();
    const store = t.provisioner.stores.get(body.id)!;
    expect(store).toMatchObject({ snapshotId: null, ownCode: true, versionId });
    expect(t.provisioner.codeReplaced).not.toContain(body.id);
    expect(t.provisioner.imports.has(body.id)).toBe(false);
    const listed = await tenant(body.id);
    expect(listed).toMatchObject({ keepsOwnCode: true, snapshotName: 'Moved in' });
    expect(listed).not.toHaveProperty('waitingForSite');
    expect(listed).not.toHaveProperty('basedOnSnapshotId');
    const { rows } = await t.pool.query('SELECT source FROM tenant_imports WHERE tenant_id = $1', [body.id]);
    expect(rows[0].source).toMatchObject({ home: 'https://old.example.com', tablePrefix: 'wpx_', uploadedBytes: 50 * 1024 ** 2 });
    expect((await plugin('status', { code: body.importCode })).body).toEqual({
      status: 'done',
      store: { name: 'Moved in', size: 'small', domain: body.baseDomain },
      url: `https://${body.baseDomain}`,
      onHold: true,
    });
  });

  it('answers the plugin an upload link and the most it may upload', async () => {
    const { body } = await createImport({ size: 'medium' });
    const res = await plugin('upload', { code: body.importCode });
    expect(res).toEqual({
      status: 200,
      body: { uploadUrl: `https://uploads.waas.example/imports/${body.id}`, maxBytes: 5 * 1024 ** 3, store: { name: 'Moved in', size: 'medium', domain: body.baseDomain } },
    });
    expect((await plugin('status', { code: body.importCode })).body.status).toBe('waiting');
  });

  it('uploads in parts: picks the part size, hands out links for missing parts, resumes, joins them and starts', async () => {
    const { body } = await createImport();
    const bytes = 40 * 1024 ** 2;
    const started = await plugin('upload/parts/start', { code: body.importCode, bytes });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ partSize: 16 * 1024 ** 2, partCount: 3, maxBytes: 5 * 1024 ** 3, store: { name: 'Moved in' } });
    const uploadId = started.body.uploadId as string;
    const first = await plugin('upload/parts', { code: body.importCode, uploadId, parts: [1, 2, 3] });
    expect(first.body).toEqual({
      done: [],
      bytes: 0,
      urls: Object.fromEntries([1, 2, 3].map((n) => [n, `https://uploads.waas.example/imports/${body.id}?partNumber=${n}&uploadId=${uploadId}`])),
    });
    // Parts 1 and 3 arrive, the connection drops; asking again says which are there.
    t.provisioner.uploadPart(uploadId, 1, 16 * 1024 ** 2);
    t.provisioner.uploadPart(uploadId, 3, 8 * 1024 ** 2);
    const again = await plugin('upload/parts', { code: body.importCode, uploadId, parts: [2] });
    expect(again.body).toMatchObject({ done: [1, 3], bytes: 24 * 1024 ** 2 });
    expect(Object.keys(again.body.urls as object)).toEqual(['2']);
    const early = await plugin('upload/parts/finish', { code: body.importCode, uploadId });
    expect(early.status).toBe(400);
    expect(early.body.message).toMatch(/Some parts of the export are missing/);
    t.provisioner.uploadPart(uploadId, 2, 16 * 1024 ** 2);
    const finished = await plugin('upload/parts/finish', { code: body.importCode, uploadId });
    expect(finished.body).toMatchObject({ bytes: bytes });
    expect((await plugin('upload/parts', { code: body.importCode, uploadId })).status).toBe(404);
    expect((await plugin('start', { code: body.importCode })).body.status).toBe('moving');
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    expect((await plugin('upload/parts/start', { code: body.importCode, bytes })).status).toBe(409);
  });

  it('refuses a parts upload larger than the store, and bad part numbers or upload ids', async () => {
    const { body } = await createImport();
    const tooBig = await plugin('upload/parts/start', { code: body.importCode, bytes: 6 * 1024 ** 3 });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.message).toMatch(/more than a small store holds/);
    expect((await plugin('upload/parts/start', { code: body.importCode })).status).toBe(400);
    const { uploadId } = (await plugin('upload/parts/start', { code: body.importCode, bytes: 1024 })).body as { uploadId: string };
    expect((await plugin('upload/parts', { code: body.importCode, uploadId, parts: [0] })).status).toBe(400);
    expect((await plugin('upload/parts', { code: body.importCode, uploadId, parts: Array.from({ length: 101 }, (_, i) => i + 1) })).status).toBe(400);
    expect((await plugin('upload/parts', { code: body.importCode })).status).toBe(400);
    expect((await plugin('upload/parts', { code: body.importCode, uploadId: 'nope' })).status).toBe(404);
  });

  it('sizes parts so a big archive fits in 10,000 of them', () => {
    expect(importPartSize(1024)).toBe(16 * 1024 ** 2);
    expect(importPartSize(5 * 1024 ** 3)).toBe(16 * 1024 ** 2);
    expect(Math.ceil(5 * 1024 ** 4 / importPartSize(5 * 1024 ** 4))).toBeLessThanOrEqual(10_000);
  });

  it('refuses to start before anything is uploaded, or with an archive larger than the store', async () => {
    const { body } = await createImport();
    expect((await plugin('start', { code: body.importCode })).body.message).toMatch(/Nothing was uploaded yet/);
    t.provisioner.imports.set(body.id, 6 * 1024 ** 3);
    const tooBig = await plugin('start', { code: body.importCode });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.message).toMatch(/more than a small store holds/);
    expect((await tenant(body.id))?.waitingForSite).toBe(true);
  });

  it('starts a move once: a second start is a conflict', async () => {
    const { body } = await createImport();
    t.provisioner.imports.set(body.id, 1024);
    expect((await plugin('start', { code: body.importCode })).body.status).toBe('moving');
    expect((await plugin('start', { code: body.importCode })).status).toBe(409);
    expect((await plugin('upload', { code: body.importCode })).status).toBe(409);
  });

  it('rejects unknown and expired codes', async () => {
    expect((await plugin('upload', { code: importCode('https://api.example', 'nope') })).status).toBe(404);
    expect((await plugin('upload', {})).status).toBe(400);
    const { body } = await createImport();
    await t.pool.query("UPDATE tenant_imports SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1", [body.id]);
    expect((await plugin('upload', { code: body.importCode })).status).toBe(410);
  });

  it('refuses changes to a store waiting for its site, but lets it be deleted', async () => {
    const { body } = await createImport();
    const res = await t.call('PUT', `/v1/tenants?tenantId=${body.id}`, { body: { wpOptions: { blogname: 'x' } } });
    expect(res.status).toBe(409);
    expect((await t.call('POST', `/v1/tenants/suspend?tenantId=${body.id}`, { body: {} })).status).toBe(409);
    t.provisioner.imports.set(body.id, 1024);
    expect((await t.call('DELETE', `/v1/tenants?tenantId=${body.id}`)).status).toBe(200);
    await waitFor(async () => !(await tenant(body.id)));
    expect(t.provisioner.imports.has(body.id)).toBe(false);
  });

  it('gives a new import code that replaces the old one', async () => {
    const { body } = await createImport();
    const res = await t.call('POST', `/v1/tenants/import-code?tenantId=${body.id}`);
    const fresh = (await res.json()) as { importCode: string };
    expect(fresh.importCode).toMatch(/^AP1\./);
    expect((await plugin('status', { code: body.importCode })).status).toBe(404);
    expect((await plugin('status', { code: fresh.importCode })).body.status).toBe('waiting');
    const built = await moveIn();
    expect((await t.call('POST', `/v1/tenants/import-code?tenantId=${built.id}`)).status).toBe(400);
  });

  it('removes stores whose code expired before the move started', async () => {
    const { body } = await createImport();
    t.provisioner.imports.set(body.id, 1024);
    await t.pool.query("UPDATE tenant_imports SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1", [body.id]);
    expect(await purgeExpiredImports(t.pool, t.provisioner)).toBeGreaterThanOrEqual(1);
    expect(await tenant(body.id)).toBeUndefined();
    expect(t.provisioner.imports.has(body.id)).toBe(false);
  });

  it('cannot be combined with a snapshot', async () => {
    expect((await createImport({ groupName: 'x' })).status).toBe(400);
    expect((await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'x', asZip: true } })).status).toBe(400);
  });
});

describe('a site moved in is held until it goes live', () => {
  it('is on hold once built, with the owner\'s team allowed email, and goes live once', async () => {
    const body = await moveIn();
    expect(await tenant(body.id)).toMatchObject({ statusCode: Status.Done, onHold: true });
    expect(t.provisioner.stores.get(body.id)).toMatchObject({ held: true, hold: true, holdAllow: expect.any(Array) });
    const { rows } = await t.pool.query('SELECT on_hold, date_held FROM tenants WHERE id = $1', [body.id]);
    expect(rows[0]).toMatchObject({ on_hold: true, date_held: expect.any(Date) });

    const res = await t.call('POST', `/v1/tenants/go-live?tenantId=${body.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: body.id, externalId: body.externalId, backupId: null });
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    expect(await tenant(body.id)).toMatchObject({ onHold: false });
    expect(t.provisioner.stores.get(body.id)?.held).toBe(false);
    expect((await plugin('status', { code: body.importCode })).body).toMatchObject({ status: 'done', onHold: false });

    // Again: nothing to do, no job.
    const jobs = async () => (await t.pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE data->>'type' = 'tenant.go-live' AND data->>'tenantId' = $1", [body.id])).rows[0].n;
    expect(await jobs()).toBe(1);
    expect((await t.call('POST', `/v1/tenants/go-live?tenantId=${body.id}`)).status).toBe(200);
    expect(await jobs()).toBe(1);
  });

  it('can be made live from the dashboard, which shows the hold', async () => {
    const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
    const body = await moveIn();
    const before = (await (await t.call('GET', `/admin/tenants/${body.id}`, { auth: ADMIN })).json()) as Record<string, any>;
    expect(before).toMatchObject({ onHold: true, dateHeld: expect.any(String) });
    expect((await t.call('POST', `/admin/tenants/${body.id}/go-live`, { auth: ADMIN })).status).toBe(200);
    await waitFor(async () => (await tenant(body.id))?.onHold === false && (await tenant(body.id))?.statusCode === Status.Done);
    const after = (await (await t.call('GET', `/admin/tenants/${body.id}`, { auth: ADMIN })).json()) as Record<string, any>;
    expect(after).toMatchObject({ onHold: false, dateHeld: null });
  });

  it('is refused for a store still waiting for its site; ordinary stores are never on hold', async () => {
    const { body } = await createImport();
    expect((await t.call('POST', `/v1/tenants/go-live?tenantId=${body.id}`)).status).toBe(409);
    const res = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Ordinary held?' } });
    const { id } = (await res.json()) as { id: string };
    await waitFor(async () => (await tenant(id))?.statusCode === Status.Done);
    expect(await tenant(id)).toMatchObject({ onHold: false });
    expect(t.provisioner.stores.get(id)?.held).toBe(false);
  });

  it("writes none of the create call's options over the moved site's own", async () => {
    const { body } = await createImport({ wpOptions: { blogname: 'From the shop' } });
    t.provisioner.imports.set(body.id, 1024);
    await plugin('start', { code: body.importCode });
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    expect(t.provisioner.stores.get(body.id)?.wpOptions).toEqual({});
    const { rows } = await t.pool.query('SELECT wp_options FROM tenants WHERE id = $1', [body.id]);
    expect(rows[0].wp_options).toEqual({});
  });
});

describe('how a move went', () => {
  it('warns about another PHP, a newer WordPress, and a failing check, to the plugin and the dashboard', async () => {
    t.provisioner.importCheck = { ok: false, home: 500, login: 200, loaded: false, fatal: 'Uncaught Error: Call to undefined function x() in wp-content/plugins/x/x.php:3' };
    try {
      const { body } = await createImport();
      t.provisioner.imports.set(body.id, 1024);
      await plugin('start', { code: body.importCode, source: { phpVersion: '7.4.33', wordPressVersion: '6.9.1' } });
      await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
      const status = (await plugin('status', { code: body.importCode })).body as { warnings: string[] };
      expect(status.warnings).toEqual([
        'The old site ran PHP 7.4 and this store runs PHP 8.3. Check that its plugins and theme work.',
        "The old site ran WordPress 6.9.1, newer than this store's 6.8. Plugins that need the newer WordPress may not work until the store moves to a version with it.",
        'After the move the home page answered 500 and the login page 200, and PHP stopped with: Uncaught Error: Call to undefined function x() in wp-content/plugins/x/x.php:3. Fix or switch off the plugin or theme at fault.',
      ]);
      const detail = (await (await t.call('GET', `/admin/tenants/${body.id}`, { auth: `Bearer ${TEST_ADMIN_TOKEN}` })).json()) as Record<string, any>;
      expect(detail.moveIn).toMatchObject({ check: { ok: false, home: 500 }, warnings: status.warnings });
      expect(detail.moveIn).not.toHaveProperty('reason');
    } finally {
      t.provisioner.importCheck = { ok: true, home: 200, login: 200, loaded: true, fatal: null };
    }
  });

  it("reports what's on the moved site to the plugin, the storefront API and the dashboard, and keeps only the report", async () => {
    t.provisioner.importCheck = {
      ok: true, home: 200, login: 200, loaded: true, fatal: null,
      inventory: {
        plugins: [{ slug: 'contact-form-7', name: 'Contact Form 7', version: '6.1' }, { slug: 'woocommerce', name: 'WooCommerce', version: '10.2.1' }],
        found: {
          'contact-form-7': { forms: 2, proFieldForms: 0, entries: 14, flamingo: false, pages: 2 },
          woocommerce: { products: 12, hpos: false, orders: 40, guestOrders: 9, subscriptions: null, liveGateways: ['stripe'] },
        },
        errors: {},
        seconds: 0.4,
      },
    };
    try {
      const { body } = await createImport({ externalId: 'report-1' });
      const waiting = await t.call('GET', '/v1/tenants/import?externalId=report-1');
      expect(await waiting.json()).toMatchObject({ status: 'waiting', startedAt: null, onHold: false, warnings: [] });
      t.provisioner.imports.set(body.id, 1024);
      await plugin('start', { code: body.importCode, source: { phpVersion: '8.3.6', wordPressVersion: '6.8.1' } });
      await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);

      const status = (await plugin('status', { code: body.importCode })).body as { siteReport: { items: { plugin: string; blockers: string[]; route: string }[] } };
      expect(status.siteReport.items.map((i) => [i.plugin, i.route])).toEqual([
        ['Contact Form 7', 'Fluent Forms can bring this in'],
        ['WooCommerce', 'Needs the FluentCart Migrator add-on'],
      ]);
      expect(status.siteReport.items[0]!.blockers[0]).toMatch(/^Flamingo is off/);
      expect(status.siteReport.items[1]!.blockers).toHaveLength(2);

      const res = await t.call('GET', '/v1/tenants/import?externalId=report-1');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        tenantId: body.id, externalId: 'report-1', status: 'done', expiresAt: expect.any(String), startedAt: expect.any(String), onHold: true, warnings: [], siteReport: status.siteReport,
        migrationToken: expect.any(String), reprintSite: null, reprintCopies: 0,
      });
      const detail = (await (await t.call('GET', `/admin/tenants/${body.id}`, { auth: `Bearer ${TEST_ADMIN_TOKEN}` })).json()) as Record<string, any>;
      expect(detail.moveIn.siteReport).toEqual(status.siteReport);
      // The raw counts aren't kept: the check is stored without them.
      expect(detail.moveIn.check).toEqual({ ok: true, home: 200, login: 200, loaded: true, fatal: null });
    } finally {
      t.provisioner.importCheck = { ok: true, home: 200, login: 200, loaded: true, fatal: null };
    }
  });

  it('answers 404 for the move of a store that was not moved in', async () => {
    const res = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Plain', externalId: 'plain-report' } });
    expect(res.status).toBe(200);
    expect((await t.call('GET', '/v1/tenants/import?externalId=plain-report')).status).toBe(404);
  });

  it('has no warnings when the old site matches the store and serves', async () => {
    const { body } = await createImport();
    t.provisioner.imports.set(body.id, 1024);
    await plugin('start', { code: body.importCode, source: { phpVersion: '8.3.6', wordPressVersion: '6.8.1' } });
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    expect((await plugin('status', { code: body.importCode })).body).not.toHaveProperty('warnings');
  });

  it('says why a move failed, in words the owner can act on', async () => {
    const { body } = await createImport();
    t.provisioner.imports.set(body.id, 1024);
    t.provisioner.failNext('createStore', 10);
    try {
      await plugin('start', { code: body.importCode });
      await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Failed, 30_000);
    } finally {
      t.provisioner.failNext('createStore', 0);
    }
    const status = (await plugin('status', { code: body.importCode })).body;
    expect(status).toMatchObject({ status: 'failed', reason: expect.stringMatching(/could not be finished/) });
    const detail = (await (await t.call('GET', `/admin/tenants/${body.id}`, { auth: `Bearer ${TEST_ADMIN_TOKEN}` })).json()) as Record<string, any>;
    expect(detail.moveIn.reason).toBe(status.reason);
  }, 60_000);

  it('maps the agent errors to reasons, and nothing else reaches the owner', () => {
    expect(importFailureReason('Store agent restore failed (failed): the export must hold database.sql and wp-content')).toMatch(/missing its database or its files/);
    expect(importFailureReason('Store agent restore failed (failed): multisite networks cannot be moved in yet')).toMatch(/Multisite/);
    expect(importFailureReason('Store agent restore failed (failed): the database export has both wp_posts and wpx_posts')).toMatch(/collide/);
    expect(importFailureReason('Store agent restore failed (failed): tar exited 2: gzip: stdin: unexpected end of file')).toMatch(/could not be read/);
    expect(importFailureReason("Store agent restore failed (failed): wp db exited 1: ERROR 1273 (HY000) at line 40: Unknown collation: 'x'")).toMatch(
      /database could not be imported/,
    );
    expect(importFailureReason('Store agent restore failed (failed): /var/www/html/secret path')).toBe("The move could not be finished. Contact support with the store's address.");
  });

  it('compares versions as far as the store names them', () => {
    expect(importWarnings({ phpVersion: '8.3.6', wordPressVersion: '6.8.3' }, { wordPressVersion: '6.8', phpVersion: '8.3' })).toEqual([]);
    expect(importWarnings({ phpVersion: '8.2.1', wordPressVersion: '6.7' }, { wordPressVersion: '6.8', phpVersion: '8.3' })).toHaveLength(1);
    const store = { wordPressVersion: '6.8', phpVersion: '8.3' };
    const rows = Array.from({ length: 7 }, (_, i) => ({ table: `wp_t${i}`, exported: 10, loaded: i }));
    expect(importWarnings(null, store, undefined, { rows, notes: ['Left behind on the old site: Database views: v1'] })).toEqual([
      "Some rows did not arrive: wp_t0 (0 of 10), wp_t1 (1 of 10), wp_t2 (2 of 10), wp_t3 (3 of 10), wp_t4 (4 of 10) and 2 more tables. Contact support with the store's address before going live.",
      'Left behind on the old site: Database views: v1',
    ]);
    expect(importWarnings(null, { wordPressVersion: '6.8', phpVersion: '8.3' }, { ok: false, error: 'boom /var/www' })).toEqual([
      'The site could not be checked after the move. Open it and its admin to see that it works.',
    ]);
  });
});

describe('stores that keep their own code', () => {
  it('keep it when moved to another version, rolled back, and restored after deletion', async () => {
    const body = await moveIn();
    await t.call('POST', `/v1/tenants/version?tenantId=${body.id}`, { body: { targetVersionId: otherVersionId } });
    await waitFor(async () => (await tenant(body.id))?.versionId === otherVersionId && (await tenant(body.id))?.statusCode === Status.Done);

    const backup = (await (await t.call('POST', `/v1/tenants/backups?tenantId=${body.id}`, { body: {} })).json()) as { backupId: string };
    await waitFor(async () => (await t.pool.query('SELECT status FROM tenant_backups WHERE id = $1', [backup.backupId])).rows[0]?.status === Status.Done);
    const rolledBack = await t.call('POST', `/admin/tenants/${body.id}/restore`, {
      body: { backupId: backup.backupId, takeBackup: false },
      auth: `Bearer ${TEST_ADMIN_TOKEN}`,
    });
    expect(rolledBack.status).toBe(200);
    await waitFor(async () => t.provisioner.stores.get(body.id)?.snapshotId === backup.backupId && (await tenant(body.id))?.statusCode === Status.Done);

    await t.call('DELETE', `/v1/tenants?tenantId=${body.id}`);
    await waitFor(async () => !(await tenant(body.id)));
    await t.call('POST', `/v1/tenants/restore?tenantId=${body.id}`, { body: {} });
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);

    expect(await tenant(body.id)).toMatchObject({ keepsOwnCode: true, onHold: true });
    expect(t.provisioner.stores.get(body.id)?.ownCode).toBe(true);
    expect(t.provisioner.codeReplaced).not.toContain(body.id);
    // Still on hold: it comes back held, as it was deleted.
    expect(t.provisioner.stores.get(body.id)?.held).toBe(true);
  });

  it('while ordinary stores get their version code each time', async () => {
    const res = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Ordinary' } });
    const { id } = (await res.json()) as { id: string };
    await waitFor(async () => (await tenant(id))?.statusCode === Status.Done);
    await t.call('POST', `/v1/tenants/version?tenantId=${id}`, { body: { targetVersionId: otherVersionId } });
    await waitFor(async () => (await tenant(id))?.versionId === otherVersionId && (await tenant(id))?.statusCode === Status.Done);
    expect(t.provisioner.codeReplaced.filter((s) => s === id)).toHaveLength(2);
    expect(await tenant(id)).not.toHaveProperty('keepsOwnCode');
  });

  it('the dashboard makes a new store from the production version', async () => {
    const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
    expect((await t.call('POST', `/admin/products/${t.productId}/tenants`, { auth: ADMIN, body: {} })).status).toBe(400);
    expect((await t.call('POST', `/admin/products/${t.productId}/tenants`, { auth: ADMIN, body: { name: 'No Owner' } })).status).toBe(400);
    expect((await t.call('POST', `/admin/products/${t.productId}/tenants`, { auth: ADMIN, body: { name: 'X', ownerEmail: 'owner@example.com', size: 'huge' } })).status).toBe(400);
    const res = await t.call('POST', `/admin/products/${t.productId}/tenants`, { auth: ADMIN, body: { name: 'New from the dashboard', ownerEmail: 'Owner@Example.com', size: 'medium' } });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { tenantId: string; externalId: string };
    await waitFor(async () => (await tenant(made.tenantId))?.statusCode === Status.Done);
    expect(await tenant(made.tenantId)).toMatchObject({ name: 'New from the dashboard', size: 'medium' });
    expect(await tenant(made.tenantId)).not.toHaveProperty('keepsOwnCode');
    expect(t.provisioner.stores.get(made.tenantId)!.user).toMatchObject({ email: 'owner@example.com', role: 'administrator' });
    expect(t.provisioner.stores.get(made.tenantId)!.wpOptions).toMatchObject({ blogname: 'New from the dashboard', admin_email: 'owner@example.com' });
  });

  it("the dashboard's New site gives the site type it picks, and a HighLevel agency's storefront defaults to HighLevel", async () => {
    const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
    const make = async (body: object) => {
      const res = await t.call('POST', `/admin/products/${t.productId}/tenants`, { auth: ADMIN, body: { name: 'Typed', ownerEmail: 'owner@example.com', ...body } });
      expect(res.status).toBe(201);
      const { tenantId } = (await res.json()) as { tenantId: string };
      await waitFor(async () => (await tenant(tenantId))?.statusCode === Status.Done);
      return t.provisioner.stores.get(tenantId)!.phpConstants.ANYPRESS_TENANT_ROLES?.value;
    };
    expect((await t.call('POST', `/admin/products/${t.productId}/tenants`, { auth: ADMIN, body: { name: 'X', ownerEmail: 'o@example.com', siteType: 'Not one' } })).status).toBe(400);
    expect(await make({ siteType: 'bookings' })).toBe('bookings');
    const untyped = await t.call('POST', `/admin/products/${t.productId}/tenants`, { auth: ADMIN, body: { name: 'Untyped', ownerEmail: 'owner@example.com' } });
    const untypedId = ((await untyped.json()) as { tenantId: string }).tenantId;
    await waitFor(async () => (await tenant(untypedId))?.statusCode === Status.Done);
    expect(t.provisioner.stores.get(untypedId)!.phpConstants.ANYPRESS_TENANT_ROLES).toBeUndefined();
    const flagged = await t.call('PUT', `/admin/products/${t.productId}`, { auth: ADMIN, body: { highlevelAgency: true } });
    expect(await flagged.json()).toMatchObject({ highlevelAgency: true });
    // Its site with no site type gets the HighLevel one, written to the store.
    await waitFor(async () => t.provisioner.stores.get(untypedId)!.phpConstants.ANYPRESS_TENANT_ROLES?.value === 'highlevel');
    await waitFor(async () => (await tenant(untypedId))?.statusCode === Status.Done);
    expect(await make({})).toBe('highlevel');
    expect(await make({ siteType: 'website' })).toBe('website');
    await t.call('PUT', `/admin/products/${t.productId}`, { auth: ADMIN, body: { highlevelAgency: false } });
  });

  it('a new storefront starts ready from another one, and can make a store at once', async () => {
    const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
    const bare = (await (await t.call('POST', '/admin/products', { auth: ADMIN, body: { name: 'Bare' } })).json()) as any;
    expect((await t.call('POST', '/admin/products', { auth: ADMIN, body: { name: 'X', startFrom: bare.product.id } })).status).toBe(400);
    expect((await t.call('POST', '/admin/products', { auth: ADMIN, body: { name: 'X', startFrom: 'nope' } })).status).toBe(400);

    const res = await t.call('POST', '/admin/products', { auth: ADMIN, body: { name: 'Retainer client', startFrom: t.productId } });
    expect(res.status).toBe(201);
    const productId = ((await res.json()) as any).product.id as string;
    const versionRow = async () => (await t.pool.query('SELECT * FROM versions WHERE product_id = $1', [productId])).rows;
    expect(await versionRow()).toHaveLength(1);
    expect((await versionRow())[0]).toMatchObject({ is_production: true, name: 'v1' });
    await waitFor(async () => (await versionRow())[0].status === Status.Done);
    const { rows: snaps } = await t.pool.query('SELECT status, source_snapshot_id FROM snapshots WHERE product_id = $1', [productId]);
    expect(snaps).toEqual([expect.objectContaining({ status: Status.Done, source_snapshot_id: expect.any(String) })]);

    const made = await t.call('POST', `/admin/products/${productId}/tenants`, { auth: ADMIN, body: { name: 'Client site', ownerEmail: 'owner@example.com' } });
    expect(made.status).toBe(201);
    const { tenantId } = (await made.json()) as { tenantId: string };
    await waitFor(async () => (await t.pool.query('SELECT status FROM tenants WHERE id = $1', [tenantId])).rows[0]?.status === Status.Done);
  });

  it('the dashboard makes a store that waits for its site, shows the move and renews the code', async () => {
    const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
    const res = await t.call('POST', `/admin/products/${t.productId}/imports`, { auth: ADMIN, body: { name: 'From the dashboard', size: 'medium' } });
    expect(res.status).toBe(200);
    const made = (await res.json()) as { tenantId: string; importCode: string; pluginUrl: string };
    expect(made.importCode).toMatch(/^AP1\./);
    expect(made.pluginUrl).toMatch(/\/imports\/plugin\.zip$/);

    const detail = (await (await t.call('GET', `/admin/tenants/${made.tenantId}`, { auth: ADMIN })).json()) as Record<string, any>;
    expect(detail).toMatchObject({ keepsOwnCode: true, size: 'medium', moveIn: { startedAt: null, source: null } });

    const renewed = (await (await t.call('POST', `/admin/tenants/${made.tenantId}/import-code`, { auth: ADMIN })).json()) as { importCode: string };
    expect(renewed.importCode).not.toBe(made.importCode);
    expect((await plugin('status', { code: made.importCode })).status).toBe(404);
    expect((await plugin('status', { code: renewed.importCode })).body).toMatchObject({ status: 'waiting' });

    t.provisioner.imports.set(made.tenantId, 1024);
    await plugin('start', { code: renewed.importCode, source: { home: 'https://old.example.com' } });
    expect((await t.call('POST', `/admin/tenants/${made.tenantId}/import-code`, { auth: ADMIN })).status).toBe(400);
    await waitFor(async () => (await tenant(made.tenantId))?.statusCode === Status.Done);
    const after = (await (await t.call('GET', `/admin/tenants/${made.tenantId}`, { auth: ADMIN })).json()) as Record<string, any>;
    expect(after.moveIn.source).toMatchObject({ home: 'https://old.example.com', uploadedBytes: 1024 });
  });
});

describe('copying a site in with Reprint', () => {
  /** Starts (or starts again) a copy with Reprint. */
  const copy = async (externalId: string, siteUrl: unknown) => {
    const res = await t.call('POST', `/v1/tenants/import-reprint?externalId=${externalId}`, { body: { siteUrl } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const detail = async (externalId: string) => (await (await t.call('GET', `/v1/tenants/import?externalId=${externalId}`)).json()) as Record<string, any>;
  const reprintError = 'Store agent restore failed (failed): reprint AUTH_UNKNOWN_KEY: This Migration Token is not enrolled on the site.';

  it('gives each waiting store a Migration Token, and builds the store from the old site with the key behind it', async () => {
    const { body } = await createImport({ externalId: 'reprint-1' });
    const waiting = await detail('reprint-1');
    expect(waiting).toMatchObject({ status: 'waiting', reprintSite: null, reprintCopies: 0 });
    // The public half of an RSA 3072 key, on one line, as the Reprint plugin takes it.
    const publicKey = createPublicKey({ key: Buffer.from(waiting.migrationToken, 'base64'), format: 'der', type: 'spki' });
    expect(publicKey.asymmetricKeyDetails?.modulusLength).toBe(3072);
    // A new import code keeps the token: one already pasted on the old site still works.
    const renewed = (await (await t.call('POST', '/v1/tenants/import-code?externalId=reprint-1')).json()) as { importCode: string };
    expect((await detail('reprint-1')).migrationToken).toBe(waiting.migrationToken);

    expect((await copy('reprint-1', 'http://old.example.com')).status).toBe(400);
    expect((await copy('reprint-1', 'https://user:pw@old.example.com')).status).toBe(400);
    const started = await copy('reprint-1', 'old.example.com/shop/');
    expect(started).toMatchObject({ status: 200, body: { status: 'moving', siteUrl: 'https://old.example.com/shop' } });
    // Being copied: not again until it is done.
    expect((await copy('reprint-1', 'https://old.example.com/shop')).status).toBe(409);
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);

    const store = t.provisioner.stores.get(body.id)!;
    expect(store.reprint?.site).toBe('https://old.example.com/shop');
    expect(createPublicKey(store.reprint!.privateKey).export({ type: 'spki', format: 'der' }).toString('base64')).toBe(waiting.migrationToken);
    expect(await detail('reprint-1')).toMatchObject({ status: 'done', onHold: true, reprintSite: 'https://old.example.com/shop', reprintCopies: 1, migrationToken: waiting.migrationToken });
    // The export plugin's code can't start a move on top of it.
    expect((await plugin('start', { code: renewed.importCode })).status).toBe(409);
  });

  it('copies again while the store is on hold, and not once it is live', async () => {
    const { body } = await createImport({ externalId: 'reprint-2' });
    await copy('reprint-2', 'https://old2.example.com');
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    expect((await copy('reprint-2', 'https://old2.example.com')).status).toBe(200);
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    expect((await detail('reprint-2')).reprintCopies).toBe(2);

    // A copy again that cannot reach the old site leaves the store as it was, built and held, and says why.
    t.provisioner.failNext('createStore', 10, reprintError);
    await copy('reprint-2', 'https://old2.example.com');
    await waitFor(async () => (await detail('reprint-2')).reason !== undefined);
    expect((await tenant(body.id))?.statusCode).toBe(Status.Done);
    expect((await detail('reprint-2')).reason).toMatch(/^Reprint on the old site hasn't let this store in yet/);
    t.provisioner.failNext('createStore', 0);

    expect((await t.call('POST', '/v1/tenants/go-live?externalId=reprint-2')).status).toBe(200);
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    const live = await copy('reprint-2', 'https://old2.example.com');
    expect(live.status).toBe(409);
    expect(live.body.message).toMatch(/live/);
    expect((await detail('reprint-2')).migrationToken).toBeUndefined();
  });

  it('lets the dashboard copy the site with Reprint through the admin routes', async () => {
    const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
    const { body } = await createImport({ externalId: 'reprint-admin' });
    const adminDetail = async () => ((await (await t.call('GET', `/admin/tenants/${body.id}`, { auth: ADMIN })).json()) as Record<string, any>).moveIn;
    const waiting = await adminDetail();
    expect(waiting.migrationToken).toBe((await detail('reprint-admin')).migrationToken);
    const adminCopy = (siteUrl: unknown) => t.call('POST', `/admin/tenants/${body.id}/import-reprint`, { auth: ADMIN, body: { siteUrl } });
    expect((await adminCopy('ftp://old.example.com')).status).toBe(400);
    const started = await adminCopy('https://old-admin.example.com');
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ tenantId: body.id, status: 'moving', siteUrl: 'https://old-admin.example.com' });
    expect((await adminCopy('https://old-admin.example.com')).status).toBe(409);
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    expect(await adminDetail()).toMatchObject({ reprintSite: 'https://old-admin.example.com', reprintCopies: 1, migrationToken: waiting.migrationToken });
    expect((await t.call('POST', `/admin/tenants/${body.id}/go-live`, { auth: ADMIN })).status).toBe(200);
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    expect((await adminDetail()).migrationToken).toBeUndefined();
    expect((await adminCopy('https://old-admin.example.com')).status).toBe(409);
  });

  it('fails a first copy the old site refused, in plain words, and copies once asked again', async () => {
    const { body } = await createImport({ externalId: 'reprint-3' });
    t.provisioner.failNext('createStore', 10, reprintError);
    await copy('reprint-3', 'https://old3.example.com');
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Failed);
    expect((await detail('reprint-3')).reason).toMatch(/paste this store's Migration Token, choose Authorize client/);
    t.provisioner.failNext('createStore', 0);
    expect((await copy('reprint-3', 'https://old3.example.com')).status).toBe(200);
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    expect((await detail('reprint-3')).reason).toBeUndefined();
  });

  it('lets the export plugin move the site after a copy with Reprint failed', async () => {
    const { body } = await createImport({ externalId: 'reprint-4' });
    t.provisioner.failNext('createStore', 10, 'Store agent restore failed (failed): reprint CLOUDFLARE_CHALLENGE: Cloudflare requires a browser challenge');
    await copy('reprint-4', 'https://old4.example.com');
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Failed);
    expect((await detail('reprint-4')).reason).toMatch(/Cloudflare or Wordfence/);
    t.provisioner.failNext('createStore', 0);
    t.provisioner.imports.set(body.id, 1024);
    expect((await plugin('start', { code: body.importCode })).status).toBe(200);
    await waitFor(async () => (await tenant(body.id))?.statusCode === Status.Done);
    expect(t.provisioner.stores.get(body.id)!.reprint).toBeUndefined();
    expect((await detail('reprint-4')).reprintSite).toBeNull();
  });

  it("explains Reprint's errors in words the owner can act on", () => {
    const reason = (code: string) => importFailureReason(`Store agent restore failed (failed): reprint ${code}: details`);
    expect(reason('AUTH_REQUIRES_TOKEN')).toMatch(/no OpenSSL/);
    expect(reason('NOT_FOUND')).toMatch(/^Reprint isn't installed and active/);
    expect(importFailureReason('reprint exit 1: The Reprint Server plugin is not installed on the remote site.')).toMatch(/^Reprint isn't installed/);
    expect(reason('WORDFENCE_BLOCKED')).toMatch(/security service/);
    expect(reason('CURL_ERROR')).toMatch(/couldn't be reached/);
    expect(importFailureReason('reprint: still copying, it carries on in the next attempt')).toMatch(/carries on where it stopped/);
    expect(importFailureReason('the copy must hold database.sql and wp-content')).toMatch(/^Reprint brought no database/);
    expect(reason('PREFLIGHT_FAILED')).toMatch(/AnyPress Export plugin instead/);
  });
});

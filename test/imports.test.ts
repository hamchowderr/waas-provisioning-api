import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCode, maxImportBytes, purgeExpiredImports, tokenFromCode } from '../src/imports.ts';
import { Status } from '../src/status.ts';
import { setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

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
    expect((await t.call('POST', '/v1/tenants', { body: { name: 'x', asZip: true } })).status).toBe(400);
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

    expect(await tenant(body.id)).toMatchObject({ keepsOwnCode: true });
    expect(t.provisioner.stores.get(body.id)?.ownCode).toBe(true);
    expect(t.provisioner.codeReplaced).not.toContain(body.id);
  });

  it('while ordinary stores get their version code each time', async () => {
    const res = await t.call('POST', '/v1/tenants', { body: { name: 'Ordinary' } });
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
    expect((await t.call('POST', `/admin/products/${t.productId}/tenants`, { auth: ADMIN, body: { name: 'X', size: 'huge' } })).status).toBe(400);
    const res = await t.call('POST', `/admin/products/${t.productId}/tenants`, { auth: ADMIN, body: { name: 'New from the dashboard', size: 'medium' } });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { tenantId: string; externalId: string };
    await waitFor(async () => (await tenant(made.tenantId))?.statusCode === Status.Done);
    expect(await tenant(made.tenantId)).toMatchObject({ name: 'New from the dashboard', size: 'medium' });
    expect(await tenant(made.tenantId)).not.toHaveProperty('keepsOwnCode');
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

// The admin API (outside the WPCS contract): auth, each endpoint, and the failure-record + retry
// flow. Responses are validated against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApp } from '../src/app.ts';
import { createApiKey } from '../src/keys.ts';
import { createAjv } from '../src/openapi.ts';
import { QUEUE } from '../src/queue.ts';
import { Status } from '../src/status.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;

async function admin(method: string, path: string, expected = 200, body?: unknown): Promise<any> {
  const res = await t.call(method, path, { auth: ADMIN, body });
  expect(res.status, `${method} ${path}`).toBe(expected);
  const text = await res.text();
  const opPath = Object.keys(adminSpec.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path.split('?')[0]!))!;
  const responses = adminSpec.paths[opPath][method.toLowerCase()].responses[String(expected)];
  const media = responses.$ref ? adminSpec.components.responses[responses.$ref.split('/').pop()].content : responses.content;
  if (!media) {
    expect(text).toBe('');
    return undefined;
  }
  const parsed = JSON.parse(text);
  // Admin schemas, and the WPCS schemas the version and template endpoints reuse.
  const schema = JSON.parse(
    JSON.stringify(media['application/json'].schema)
      .replaceAll('"#/components', '"admin#/components')
      .replaceAll('"../waas-provisioning-api.yaml#/components', '"spec#/components'),
  );
  const validate = ajv.compile(schema);
  expect(validate(parsed), `${method} ${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  return parsed;
}

const tenantStatus = async (externalId: string) => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as any[])[0]?.statusCode;

async function newTenant(body: object, auth?: string) {
  const tenant = (await (await t.call('POST', '/v1/tenants', { body, auth })).json()) as { id: string; externalId: string };
  await waitFor(async () => {
    const res = await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`, { auth });
    return ((await res.json()) as any[])[0]?.statusCode === Status.Done;
  });
  return tenant;
}

let otherAuth: string;
let otherProductId: string;

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  // A second storefront with its own version.
  otherProductId = (await t.pool.query("INSERT INTO products (name) VALUES ('Other storefront') RETURNING id")).rows[0].id;
  const { key, secret } = await createApiKey(t.pool, otherProductId);
  otherAuth = basic(key, secret);
  const v2 = ((await (await t.call('POST', '/v1/versions', { auth: otherAuth, body: { name: 'other-v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } })).json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${v2}`, { auth: otherAuth })).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { auth: otherAuth, body: { versionId: v2 } });
});
afterAll(async () => {
  await t.close();
});

describe('admin auth', () => {
  it('answers 403 to anything but the admin token, product keys included', async () => {
    const productKey = t.auth.replace(/^Basic /, '');
    for (const auth of [null, t.auth, `Bearer ${productKey}`, 'Bearer wrong-token', `Bearer ${TEST_ADMIN_TOKEN}x`, `Basic ${TEST_ADMIN_TOKEN}`]) {
      const res = await t.call('GET', '/admin/overview', { auth });
      expect(res.status, String(auth)).toBe(403);
    }
    await admin('GET', '/admin/overview');
  });

  it('is disabled when ADMIN_TOKEN is unset', async () => {
    const app = createApp({ ...t.deps, config: { ...t.deps.config, adminToken: undefined } });
    const res = await app.request('/admin/overview', { headers: { Authorization: ADMIN } });
    expect(res.status).toBe(403);
  });

  it('does not let the admin token into /v1', async () => {
    expect((await t.call('GET', '/v1/versions', { auth: ADMIN })).status).toBe(403);
  });
});

describe('admin endpoints', () => {
  let shop: { id: string; externalId: string };

  it('overview: counts, health and products', async () => {
    shop = await newTenant({ name: 'Admin Shop', customDomainName: 'admin-shop.example.com', wpOptions: { blogname: 'secret-ish value' } });
    await newTenant({ name: 'Other Shop' }, otherAuth);
    const overview = await admin('GET', '/admin/overview');
    expect(overview.health).toEqual({ ok: true, database: 'ok', queue: 'ok', dbBackup: { status: 'off', lastAttemptAt: null, lastSuccessAt: null, sizeBytes: null, stale: false } });
    expect(overview.tenants.done).toBe(2);
    expect(overview.products.map((p: any) => p.name).sort()).toEqual(['Example storefront', 'Other storefront']);
  });

  it('tenants: across products, with filters, search and paging', async () => {
    const all = await admin('GET', '/admin/tenants');
    expect(all.total).toBe(2);
    const other = await admin('GET', `/admin/tenants?productId=${otherProductId}`);
    expect(other.items.map((x: any) => x.name)).toEqual(['Other Shop']);
    const byDomain = await admin('GET', '/admin/tenants?q=ADMIN-SHOP.example');
    expect(byDomain.items).toEqual([expect.objectContaining({ id: shop.id, mainDomain: 'admin-shop.example.com', domainCount: 2, productName: 'Example storefront' })]);
    expect((await admin('GET', '/admin/tenants?q=%25')).total).toBe(0); // % is literal, not a wildcard
    expect((await admin('GET', `/admin/tenants?status=${Status.Failed}`)).total).toBe(0);
    expect((await admin('GET', '/admin/tenants?suspended=false&pageSize=1&page=2')).items).toHaveLength(1);
    await admin('GET', '/admin/tenants?status=7', 400);
  });

  it('tenant detail: domains, backups, recent jobs; option names but no values', async () => {
    await t.call('POST', `/v1/tenants/backups?externalId=${shop.externalId}`);
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants/backups?externalId=${shop.externalId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    const detail = await admin('GET', `/admin/tenants/${shop.id}`);
    expect(detail.domains).toHaveLength(2);
    expect(detail.backups).toHaveLength(1);
    expect(detail.recentJobs.map((j: any) => j.type)).toEqual(expect.arrayContaining(['tenant.create', 'tenant.backup']));
    expect(detail.wpOptionNames).toEqual(['blogname']);
    expect(JSON.stringify(detail)).not.toContain('secret-ish value');
    await admin('GET', `/admin/tenants/${crypto.randomUUID()}`, 404);
  });

  it('moves a store to a new main domain, keeping the old one as a redirect', async () => {
    const moving = await newTenant({ name: 'Moving Shop' });
    const res = await admin('PUT', `/admin/tenants/${moving.id}/domains/main`, 200, { domainName: 'Moved-Shop.example.com' });
    expect(res).toEqual({ tenantId: moving.id, externalId: moving.externalId, domain: 'moved-shop.example.com', setAsMainDomain: true });
    await waitFor(async () => {
      const rows = (await (await t.call('GET', `/v1/tenants?externalId=${moving.externalId}`)).json()) as any[];
      return rows[0]?.statusCode === Status.Done && rows[0]?.domainName === 'moved-shop.example.com';
    });
    const detail = await admin('GET', `/admin/tenants/${moving.id}`);
    expect(detail.domains.filter((d: any) => d.isMainDomain).map((d: any) => d.domainName)).toEqual(['moved-shop.example.com']);
    expect(detail.domains.length).toBeGreaterThan(1);
    // A domain another store already has is refused.
    await admin('PUT', `/admin/tenants/${shop.id}/domains/main`, 400, { domainName: 'moved-shop.example.com' });
    await admin('PUT', `/admin/tenants/${moving.id}/domains/main`, 400, {});
    await admin('PUT', `/admin/tenants/${crypto.randomUUID()}/domains/main`, 404, { domainName: 'x.example.com' });
  });

  it('backups: includes a deleted tenant\'s, with expiresAt', async () => {
    const gone = await newTenant({ name: 'Gone Shop' });
    await t.call('POST', `/v1/tenants/suspend?externalId=${gone.externalId}`, { body: {} });
    await t.call('DELETE', `/v1/tenants?externalId=${gone.externalId}`);
    await waitFor(async () => (await tenantStatus(gone.externalId)) === undefined);
    const deleted = await admin('GET', '/admin/backups?tenantDeleted=true');
    expect(deleted.items).toEqual([expect.objectContaining({ tenantId: gone.id, reason: 'suspend', expiresAt: expect.any(String) })]);
    const days = (Date.parse(deleted.items[0].expiresAt) - Date.parse(deleted.items[0].tenantDeletedAt)) / 86400000;
    expect(days).toBeCloseTo(90, 5);
    expect((await admin('GET', '/admin/backups')).total).toBe(2);
  });

  it('jobs: queued and running lists with counts', async () => {
    // A job deferred an hour stays queued while we look.
    const id = await t.boss.send(QUEUE, { type: 'tenant.resume', tenantId: shop.id }, { singletonKey: `tenant:${crypto.randomUUID()}`, startAfter: 3600 });
    const queued = await admin('GET', '/admin/jobs?state=queued');
    expect(queued.items).toEqual(expect.arrayContaining([expect.objectContaining({ id, type: 'tenant.resume', tenantId: shop.id, state: 'created' })]));
    expect(queued.counts.queued).toBeGreaterThanOrEqual(1);
    await t.boss.deleteJob(QUEUE, id!);
    await admin('GET', '/admin/jobs?state=running');
    await admin('GET', '/admin/jobs?state=everything', 400);
  });
});

describe('rolling a live store back', () => {
  it('rolls a live store back to one of its backups, backing up what it holds now first', async () => {
    const store = await newTenant({ name: 'Rollback Shop', wpOptions: { blogdescription: 'Then' } });
    const { backupId } = (await (await t.call('POST', `/v1/tenants/backups?externalId=${store.externalId}`, { body: {} })).json()) as { backupId: string };
    await waitFor(async () => t.provisioner.backups.has(backupId) && (await tenantStatus(store.externalId)) === Status.Done);
    await waitFor(async () => (await admin('GET', `/admin/tenants/${store.id}`)).backups[0]?.statusCode === Status.Done);
    await t.call('PUT', `/v1/tenants?externalId=${store.externalId}`, { body: { wpOptions: { blogdescription: 'Now' } } });
    await waitFor(async () => (await tenantStatus(store.externalId)) === Status.Done);

    const res = await admin('POST', `/admin/tenants/${store.id}/restore`, 200, { backupId });
    expect(res).toEqual({ tenantId: store.id, externalId: store.externalId, backupId, safetyBackupId: expect.any(String) });
    await waitFor(async () => (await tenantStatus(store.externalId)) === Status.Done);
    const fake = t.provisioner.stores.get(store.id)!;
    expect(fake.snapshotId).toBe(backupId);
    // The options the API set now are written back over the backup's.
    expect(fake.wpOptions.blogdescription).toBe('Now');
    const detail = await admin('GET', `/admin/tenants/${store.id}`);
    expect(detail.backups.find((b: any) => b.id === res.safetyBackupId)).toMatchObject({ reason: 'before-restore', statusCode: Status.Done });
    expect(t.provisioner.backups.get(res.safetyBackupId)?.storeId).toBe(store.id);

    // Without the first backup.
    const bare = await admin('POST', `/admin/tenants/${store.id}/restore`, 200, { backupId: res.safetyBackupId, takeBackup: false });
    expect(bare.safetyBackupId).toBeNull();
    await waitFor(async () => (await tenantStatus(store.externalId)) === Status.Done);
    expect(t.provisioner.stores.get(store.id)!.snapshotId).toBe(res.safetyBackupId);
  });

  it('refuses a rollback to a backup that is not this store\'s, or not Done', async () => {
    const mine = await newTenant({ name: 'Mine Shop' });
    const other = await newTenant({ name: 'Other Shop' });
    const { backupId } = (await (await t.call('POST', `/v1/tenants/backups?externalId=${other.externalId}`, { body: {} })).json()) as { backupId: string };
    await waitFor(async () => t.provisioner.backups.has(backupId));
    await admin('POST', `/admin/tenants/${mine.id}/restore`, 400, { backupId });
    await admin('POST', `/admin/tenants/${mine.id}/restore`, 400, { backupId: crypto.randomUUID() });
    await admin('POST', `/admin/tenants/${mine.id}/restore`, 400, {});
    await admin('POST', `/admin/tenants/${mine.id}/restore`, 400, { backupId, takeBackup: 'yes' });
    await admin('POST', `/admin/tenants/${crypto.randomUUID()}/restore`, 404, { backupId });
    const pending = (await t.pool.query("INSERT INTO tenant_backups (product_id, tenant_id, external_id, reason) SELECT product_id, id, external_id, 'manual' FROM tenants WHERE id = $1 RETURNING id", [mine.id])).rows[0].id;
    await admin('POST', `/admin/tenants/${mine.id}/restore`, 400, { backupId: pending });
    expect(await tenantStatus(mine.externalId)).toBe(Status.Done);
  });
});

describe('job failures and retry', () => {
  it('records a job that fails its last retry, and retries it once', async () => {
    t.provisioner.failNext('createStore', 10);
    const doomed = (await (await t.call('POST', '/v1/tenants', {
      body: { name: 'Retry Me', wordPressUserName: 'owner', wordPressUserEmail: 'owner@example.com', wordPressUserPassword: 'example-password' },
    })).json()) as { id: string; externalId: string };
    await waitFor(async () => (await tenantStatus(doomed.externalId)) === Status.Failed, 30000);
    t.provisioner.failNext('createStore', 0);

    const failed = await admin('GET', '/admin/jobs?state=failed');
    const failure = failed.items.find((f: any) => f.tenantId === doomed.id);
    expect(failure).toMatchObject({ type: 'tenant.create', status: 'failed', attempts: 4, errorMessage: expect.stringContaining('createStore failed') });
    expect(failed.counts.failed).toBeGreaterThanOrEqual(1);
    // Job data (which holds the encrypted password) is never returned.
    expect(JSON.stringify(failed)).not.toContain('encryptedPassword');

    const retried = await admin('POST', `/admin/jobs/failures/${failure.id}/retry`);
    expect(retried).toMatchObject({ id: failure.id, status: 'retried', retryJobId: expect.any(String) });
    expect([Status.Pending, Status.Done]).toContain(await tenantStatus(doomed.externalId));
    await waitFor(async () => (await tenantStatus(doomed.externalId)) === Status.Done);
    expect(t.provisioner.stores.get(doomed.id)!.user?.password).toBe('example-password');

    // Idempotent.
    expect(await admin('POST', `/admin/jobs/failures/${failure.id}/retry`)).toEqual(retried);
    expect((await admin('GET', '/admin/jobs?state=failed')).items.some((f: any) => f.id === failure.id)).toBe(false);
    await admin('POST', `/admin/jobs/failures/${crypto.randomUUID()}/retry`, 404);
  }, 60000);

  it('leaves the store untouched and Done when the backup before a rollback fails, and retries it', async () => {
    const store = await newTenant({ name: 'Careful Shop' });
    const { backupId } = (await (await t.call('POST', `/v1/tenants/backups?externalId=${store.externalId}`, { body: {} })).json()) as { backupId: string };
    await waitFor(async () => (await admin('GET', `/admin/tenants/${store.id}`)).backups[0]?.statusCode === Status.Done);
    const before = t.provisioner.stores.get(store.id)!.snapshotId;
    t.provisioner.failNext('backupStore', 10);
    const { safetyBackupId } = await admin('POST', `/admin/tenants/${store.id}/restore`, 200, { backupId });
    await waitFor(async () => (await admin('GET', '/admin/jobs?state=failed')).items.some((f: any) => f.tenantId === store.id && f.type === 'tenant.rollback'), 30000);
    t.provisioner.failNext('backupStore', 0);
    expect(await tenantStatus(store.externalId)).toBe(Status.Done);
    expect(t.provisioner.stores.get(store.id)!.snapshotId).toBe(before);
    const detail = await admin('GET', `/admin/tenants/${store.id}`);
    expect(detail.backups.find((b: any) => b.id === safetyBackupId)).toMatchObject({ statusCode: Status.Failed });

    const failure = (await admin('GET', '/admin/jobs?state=failed')).items.find((f: any) => f.tenantId === store.id && f.type === 'tenant.rollback');
    await admin('POST', `/admin/jobs/failures/${failure.id}/retry`);
    await waitFor(async () => t.provisioner.stores.get(store.id)!.snapshotId === backupId && (await tenantStatus(store.externalId)) === Status.Done);
  }, 60000);

  it('refuses a retry when the record is no longer Failed', async () => {
    const tenant = await newTenant({ name: 'Moved On' });
    t.provisioner.failNext('updateStore', 10);
    await t.call('PUT', `/v1/tenants?externalId=${tenant.externalId}`, { body: { wpOptions: { a: 'b' } } });
    await waitFor(async () => (await tenantStatus(tenant.externalId)) === Status.Failed, 30000);
    t.provisioner.failNext('updateStore', 0);
    const failure = (await admin('GET', '/admin/jobs?state=failed')).items.find((f: any) => f.tenantId === tenant.id);
    // Something else fixed the tenant meanwhile.
    await t.pool.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenant.id, Status.Done]);
    const res = await admin('POST', `/admin/jobs/failures/${failure.id}/retry`, 400);
    expect(res.message).toMatch(/no longer Failed/);
  }, 60000);
});

describe('admin versions and templates (any product)', () => {
  it('lists products', async () => {
    const products = await admin('GET', '/admin/products');
    expect(products.map((p: any) => p.name)).toEqual(['Example storefront', 'Other storefront']);
    expect(products.find((p: any) => p.id === otherProductId)).toMatchObject({ versionCount: 1, productionVersionId: expect.any(String) });
  });

  it('manages another product\'s versions and templates with the WPCS shapes', async () => {
    const base = `/admin/products/${otherProductId}`;
    // Same answer as the product's own key gets from /v1.
    expect(await admin('GET', `${base}/versions`)).toEqual(await (await t.call('GET', '/v1/versions', { auth: otherAuth })).json());

    const template = await admin('POST', `${base}/basesnapshots`, 200, { name: 'Admin Starter', comment: 'From the dashboard', isTenantSnapshot: true, groupName: 'admin-starter' });
    expect(template.uploadUrl).toMatch(/^https:\/\//);
    expect(await admin('GET', `${base}/basesnapshots?groupName=admin-starter`)).toEqual(
      await (await t.call('GET', '/v1/basesnapshots?groupName=admin-starter', { auth: otherAuth })).json(),
    );
    // Not visible to the first product.
    expect(await (await t.call('GET', '/v1/basesnapshots')).json()).toEqual([]);

    const created = await admin('POST', `${base}/versions`, 200, { name: 'admin-v2', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true, snapshotIdsToCopy: [template.id] });
    expect(created).toMatchObject({ name: 'admin-v2', domainName: expect.stringContaining('admin-v2') });
    await waitFor(async () => (await admin('GET', `${base}/versions?versionId=${created.id}`))[0]?.statusCode === Status.Done);
    expect(await admin('PUT', `${base}/versions/${created.id}/production`)).toEqual({ id: created.id });
    const groups = (await (await t.call('GET', '/v1/snapshots?onlyProductionVersion=true', { auth: otherAuth })).json()) as any[];
    expect(groups.map((g) => g.groupName)).toContain('admin-starter');

    // The old production version can now go; the new one can't.
    const old = (await admin('GET', `${base}/versions`)).find((v: any) => v.id !== created.id);
    expect((await admin('DELETE', `${base}/versions/${created.id}`, 400)).message).toMatch(/production/);
    expect((await admin('GET', `/admin/tenants?productId=${otherProductId}&versionId=${old.id}`)).total).toBe(1);
    expect((await admin('DELETE', `${base}/versions/${old.id}`, 400)).message).toMatch(/tenant/);

    expect(await admin('DELETE', `${base}/basesnapshots?id=${template.id}`)).toEqual({ baseSnapshotId: template.id });
    expect(await admin('GET', `${base}/basesnapshots`)).toEqual([]);
  });

  it('removes a version through the admin path', async () => {
    const base = `/admin/products/${otherProductId}`;
    const spare = await admin('POST', `${base}/versions`, 200, { name: 'spare', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true });
    await waitFor(async () => (await admin('GET', `${base}/versions?versionId=${spare.id}`))[0]?.statusCode === Status.Done);
    expect(await admin('DELETE', `${base}/versions/${spare.id}`)).toBeUndefined();
    await waitFor(async () => (await admin('GET', `${base}/versions?versionId=${spare.id}`)).length === 0);
  });

  it('db-backups: status and attempts, newest first', async () => {
    expect(await admin('GET', '/admin/db-backups')).toMatchObject({ status: 'off', items: [], total: 0 });
    await t.pool.query(
      `INSERT INTO db_backups (started_at, finished_at, status, object_key, size_bytes, error_message) VALUES
        (now() - interval '2 days', now() - interval '2 days', 'ok', 'db-backups/old.dump.enc', 1234, NULL),
        (now() - interval '1 day', now() - interval '1 day', 'failed', NULL, NULL, 'S3 PUT failed: HTTP 403')`,
    );
    t.deps.config.dbBackup = { s3: { endpoint: 'https://s3.test', bucket: 'b', region: 'auto', accessKeyId: 'k', secretAccessKey: 's' }, prefix: 'db-backups', schedule: '30 2 * * *', keepDaily: 14, keepWeekly: 8 };
    try {
      const list = await admin('GET', '/admin/db-backups?pageSize=1');
      expect(list).toMatchObject({ status: 'failed', sizeBytes: 1234, stale: true, total: 2, pageSize: 1 });
      expect(list.items).toEqual([expect.objectContaining({ status: 'failed', objectKey: null, error: 'S3 PUT failed: HTTP 403' })]);
      expect((await admin('GET', '/admin/overview')).health.dbBackup).toMatchObject({ status: 'failed', sizeBytes: 1234 });
      // /health shows the status but not keys or errors, and a failed backup is not a 503.
      const health = await t.call('GET', '/health', { auth: null });
      expect(health.status).toBe(200);
      expect((await health.json()).dbBackup).toEqual({ status: 'failed', lastAttemptAt: expect.any(String), lastSuccessAt: expect.any(String), sizeBytes: 1234, stale: true });
    } finally {
      t.deps.config.dbBackup = undefined;
      await t.pool.query('DELETE FROM db_backups');
    }
  });

  it('answers 404 for an unknown product or version, 400 for a bad body, 403 without the token', async () => {
    await admin('GET', `/admin/products/${crypto.randomUUID()}/versions`, 404);
    await admin('GET', '/admin/products/not-a-uuid/basesnapshots', 404);
    await admin('PUT', `/admin/products/${otherProductId}/versions/not-a-uuid/production`, 404);
    await admin('PUT', `/admin/products/${otherProductId}/versions/${crypto.randomUUID()}/production`, 400);
    await admin('POST', `/admin/products/${otherProductId}/versions`, 400, { name: 'x' });
    await admin('POST', `/admin/products/${otherProductId}/basesnapshots`, 400, { name: 'abc', comment: 'too short' });
    for (const auth of [null, otherAuth]) {
      expect((await t.call('GET', `/admin/products/${otherProductId}/versions`, { auth })).status).toBe(403);
      expect((await t.call('GET', '/admin/products', { auth })).status).toBe(403);
    }
  });
});

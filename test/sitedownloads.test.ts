// "Download my site" (src/sitedownloads.ts): the dashboard's routes and the store's own signed route.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAjv } from '../src/openapi.ts';
import { signSiteRequest, siteKey, siteKeyMaster } from '../src/sitekeys.ts';
import { purgeExpiredDownloads, SITE_DOWNLOAD_ROUTE } from '../src/sitedownloads.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, TEST_ADMIN_TOKEN, TEST_SECRETS_KEY, waitFor, type TestContext } from './helpers.ts';

const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');
const validate = ajv.compile({ $ref: 'admin#/components/schemas/SiteDownloadResult' });

let t: TestContext;
let store: { id: string; externalId: string; domain: string };

const admin = async (method: string, path: string, expected = 200) => {
  const res = await t.call(method, path, { auth: `Bearer ${TEST_ADMIN_TOKEN}` });
  expect(res.status, `${method} ${path}`).toBe(expected);
  const body = await res.json();
  if (expected === 200) expect(validate(body), ajv.errorsText(validate.errors)).toBe(true);
  return body as { download: any };
};

const fromSite = (domain: string, key: string | null, body: Record<string, unknown> = {}) => {
  const raw = JSON.stringify({ site: domain, ...body });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['X-AnyPress-Signature'] = signSiteRequest(key, 'POST', SITE_DOWNLOAD_ROUTE, raw);
  return t.call('POST', SITE_DOWNLOAD_ROUTE, { auth: null, headers, body: raw });
};
const keyOf = (storeId: string) => siteKey(siteKeyMaster(TEST_SECRETS_KEY), storeId);

beforeAll(async () => {
  t = await setup();
  const versionId = ((await (await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } })).json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  const made = (await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Bakery' } })).json()) as { id: string; externalId: string };
  const [tenant] = await waitFor(async () => {
    const rows = (await (await t.call('GET', `/v1/tenants?tenantId=${made.id}`)).json()) as { statusCode: number; domainName: string }[];
    return rows[0]?.statusCode === Status.Done && rows;
  });
  store = { ...made, domain: tenant!.domainName };
});
afterAll(async () => {
  await t.close();
});

describe('download my site, from the dashboard', () => {
  it('has none until one is asked for, then makes it with a link and the site name', async () => {
    expect((await admin('GET', `/admin/tenants/${store.id}/download`)).download).toBeNull();
    const started = (await admin('POST', `/admin/tenants/${store.id}/download`)).download;
    expect(started).toMatchObject({ fileName: `${store.domain}-${new Date().toISOString().slice(0, 10)}.zip` });
    const done = await waitFor(async () => {
      const { download } = await admin('GET', `/admin/tenants/${store.id}/download`);
      return download?.statusCode === Status.Done && download;
    });
    expect(done).toMatchObject({ id: started.id, statusName: 'Done', sizeBytes: 3 * 1024 * 1024, url: expect.stringContaining(`/downloads/${started.id}.zip`) });
    expect(t.provisioner.downloads.get(started.id)).toBe(store.id);
    // A second press right after gives the same copy.
    expect((await admin('POST', `/admin/tenants/${store.id}/download`)).download.id).toBe(started.id);
  });

  it('refuses a store that is not there', async () => {
    await admin('GET', `/admin/tenants/${crypto.randomUUID()}/download`, 404);
    await admin('POST', '/admin/tenants/not-an-id/download', 404);
  });
});

describe("download my site, from the store's wp-admin", () => {
  it('answers only requests signed with that store\'s key', async () => {
    expect((await fromSite(store.domain, null)).status).toBe(403);
    expect((await fromSite(store.domain, keyOf('another-store'))).status).toBe(403);
    expect((await fromSite('nowhere.example', keyOf(store.id))).status).toBe(403);
  });

  it('shows the newest copy, and makes a new one when the last is older than a few minutes', async () => {
    const first = (await (await fromSite(store.domain.toUpperCase(), keyOf(store.id))).json()) as { download: any };
    expect(first.download.statusName).toBe('Done');
    await t.pool.query("UPDATE site_downloads SET date_created = now() - interval '1 hour' WHERE tenant_id = $1", [store.id]);
    const res = await fromSite(store.domain, keyOf(store.id), { start: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const { download } = (await res.json()) as { download: any };
    expect(download.id).not.toBe(first.download.id);
    expect(validate({ download })).toBe(true);
  });

  it('deletes copies once they are a week old', async () => {
    await waitFor(async () => (await t.pool.query('SELECT 1 FROM site_downloads WHERE tenant_id = $1 AND status = $2', [store.id, Status.Pending])).rowCount === 0);
    const { rows } = await t.pool.query("UPDATE site_downloads SET date_created = now() - interval '8 days' WHERE tenant_id = $1 RETURNING id", [store.id]);
    expect(await purgeExpiredDownloads(t.pool, t.provisioner)).toBe(rows.length);
    for (const { id } of rows) expect(t.provisioner.downloads.has(id)).toBe(false);
    expect((await admin('GET', `/admin/tenants/${store.id}/download`)).download).toBeNull();
  });
});

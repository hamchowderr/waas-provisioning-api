import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../src/keys.ts';
import { Status } from '../src/status.ts';
import { basic, setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;
let versionId: string;

async function tenantStatus(externalId: string): Promise<number | undefined> {
  const [tenant] = (await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as { statusCode: number }[];
  return tenant?.statusCode;
}

async function createTenant(body: object) {
  const res = await t.call('POST', '/v1/tenants', { body });
  return { status: res.status, body: (await res.json()) as { id: string; externalId: string; baseDomain: string; customDomain?: string; message?: string } };
}

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  // Example template snapshots in two groups (no API creates groups yet: waas-api-2hl.8).
  await t.pool.query(
    `INSERT INTO snapshots (product_id, version_id, name, group_name, is_tenant_snapshot, status, date_created) VALUES
       ($1, $2, 'starter 2026-09', 'peptide-starter', true, 1, now() - interval '2 days'),
       ($1, $2, 'starter 2026-10', 'peptide-starter', true, 1, now() - interval '1 day'),
       ($1, $2, 'pro 2026-10', 'peptide-pro', true, 1, now() - interval '1 day')`,
    [t.productId, versionId],
  );
});
afterAll(async () => {
  await t.close();
});

describe('tenants', () => {
  it('bases the store on the latest snapshot in groupName', async () => {
    const { body } = await createTenant({ name: 'Grouped', groupName: 'peptide-starter' });
    const [tenant] = (await (await t.call('GET', `/v1/tenants?externalId=${body.externalId}`)).json()) as Record<string, unknown>[];
    expect(tenant).toMatchObject({ snapshotName: 'starter 2026-10', snapshotGroupName: 'peptide-starter' });
    expect((await createTenant({ name: 'x', groupName: 'no-such-group' })).status).toBe(400);
  });

  it('keeps the password and private constants out of Postgres in plain text', async () => {
    const { body } = await createTenant({
      name: 'Secretive',
      wordPressUserName: 'owner',
      wordPressUserEmail: 'owner@example.com',
      wordPressUserPassword: 'example-plaintext-password',
      phpConstants: { EXAMPLE_PRIVATE: { value: 'example-private-value', isPrivate: true }, EXAMPLE_PUBLIC: { value: 'shown' } },
    });
    const dump = JSON.stringify([
      (await t.pool.query('SELECT * FROM tenants WHERE id = $1', [body.id])).rows,
      (await t.pool.query('SELECT data FROM pgboss.job')).rows,
    ]);
    expect(dump).not.toContain('example-plaintext-password');
    expect(dump).not.toContain('example-private-value');
    expect(dump).toContain('shown');
    // The store still gets the real values.
    await waitFor(async () => (await tenantStatus(body.externalId)) === Status.Done);
    const store = t.provisioner.stores.get(body.id)!;
    expect(store.user?.password).toBe('example-plaintext-password');
    expect(store.phpConstants.EXAMPLE_PRIVATE).toEqual({ value: 'example-private-value', isPrivate: true });
  });

  it('accepts the deprecated tenant* user fields', async () => {
    const { body } = await createTenant({ name: 'Old Fields', tenantName: 'legacy', tenantEmail: 'legacy@example.com', tenantUserRole: 'editor' });
    await waitFor(async () => (await tenantStatus(body.externalId)) === Status.Done);
    expect(t.provisioner.stores.get(body.id)!.user).toMatchObject({ name: 'legacy', email: 'legacy@example.com', role: 'editor' });
  });

  it('validates externalId: format and uniqueness', async () => {
    expect((await createTenant({ name: 'a', externalId: 'store-1' })).status).toBe(200);
    expect((await createTenant({ name: 'b', externalId: 'store-1' })).status).toBe(409);
    expect((await createTenant({ name: 'c', externalId: 'has space' })).status).toBe(400);
  });

  it('stores custom domains as bare lowercase hostnames, and only once', async () => {
    const { body } = await createTenant({ name: 'Domains', customDomainName: 'Shop.Example.ORG.' });
    expect(body.customDomain).toBe('shop.example.org');
    const [tenant] = (await (await t.call('GET', `/v1/tenants?externalId=${body.externalId}`)).json()) as { domainName: string }[];
    expect(tenant!.domainName).toBe(body.customDomain);
    expect((await createTenant({ name: 'Copycat', customDomainName: 'shop.example.org' })).status).toBe(400);
    for (const bad of ['https://shop.example.net', 'shop.example.net/path', 'shop.example.net:8080', 'localhost']) {
      expect((await createTenant({ name: 'Bad', customDomainName: bad })).status, bad).toBe(400);
    }
  });

  it('needs a production version when versionId is omitted', async () => {
    const other = (await t.pool.query("INSERT INTO products (name) VALUES ('Empty storefront') RETURNING id")).rows[0].id;
    const { key, secret } = await createApiKey(t.pool, other);
    const res = await t.call('POST', '/v1/tenants', { body: { name: 'Nowhere' }, auth: basic(key, secret) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/production version/);
  });

  it('marks the tenant Failed when the store cannot be built', async () => {
    await waitFor(async () => !((await (await t.call('GET', '/v1/tenants')).json()) as { statusCode: number }[]).some((x) => x.statusCode === Status.Pending));
    t.provisioner.failNext('createStore', 10);
    const { body } = await createTenant({ name: 'Doomed' });
    await waitFor(async () => (await tenantStatus(body.externalId)) === Status.Failed, 30000);
    t.provisioner.failNext('createStore', 0);
    expect((await t.call('PUT', `/v1/tenants?externalId=${body.externalId}`, { body: { wpOptions: { a: 'b' } } })).status).toBe(400);
  }, 40000);

  it('runs a delete sent during creation after the creation', async () => {
    const { body } = await createTenant({ name: 'Fleeting' });
    expect((await t.call('DELETE', `/v1/tenants?externalId=${body.externalId}`)).status).toBe(200);
    // Removing until the delete job runs, which can finish before this read.
    expect([Status.Removing, undefined]).toContain(await tenantStatus(body.externalId));
    await waitFor(async () => (await tenantStatus(body.externalId)) === undefined);
    expect(t.provisioner.stores.has(body.id)).toBe(false);
  });

  it('will not delete a version that still has tenants', async () => {
    const res = await t.call('POST', '/v1/versions', { body: { name: 'v2', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
    const v2 = ((await res.json()) as { id: string }).id;
    await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${v2}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
    const { body } = await createTenant({ name: 'Mover', versionId: v2 });
    expect((await t.call('DELETE', `/v1/versions?versionId=${v2}`)).status).toBe(400);
    await t.call('POST', `/v1/tenants/version?externalId=${body.externalId}`, { body: { targetVersionId: versionId } });
    await waitFor(async () => {
      const [x] = (await (await t.call('GET', `/v1/tenants?externalId=${body.externalId}`)).json()) as { versionId: string; statusCode: number }[];
      return x!.statusCode === Status.Done && x!.versionId === versionId;
    });
    expect((await t.call('DELETE', `/v1/versions?versionId=${v2}`)).status).toBe(200);
  });

  it('answers 400 for an unknown tenant', async () => {
    expect((await t.call('PUT', '/v1/tenants?externalId=nobody', { body: {} })).status).toBe(400);
    expect((await t.call('DELETE', `/v1/tenants?tenantId=${crypto.randomUUID()}`)).status).toBe(400);
  });
});

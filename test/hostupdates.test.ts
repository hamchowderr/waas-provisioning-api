import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetHostUpdate, HOST_SLUG, OLD_HOST_SLUGS, queueHostUpdates } from '../src/hostupdates.ts';
import { channelKey, manifestKey, type ReleaseStore } from '../src/releases.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext } from './helpers.ts';

// Each stable AnyPress Host release goes to every ready-made storefront without anyone clicking Update (docs/host-updates.md).

class MemoryReleases implements ReleaseStore {
  objects = new Map<string, unknown>();
  async getJson(key: string) {
    return this.objects.get(key) ?? null;
  }
  async presignGet(key: string, expiresIn: number) {
    return `https://releases.test/${key}?X-Amz-Expires=${expiresIn}`;
  }
}

const { privateKey } = generateKeyPairSync('ed25519');
function publish(version: string) {
  const sha256 = createHash('sha256').update(`${HOST_SLUG} ${version}`).digest('hex');
  const signature = sign(null, Buffer.from(`anypress-release-v1\n${HOST_SLUG}\n${version}\n${sha256}`), privateKey).toString('base64');
  const manifest = {
    slug: HOST_SLUG,
    version,
    zip: `releases/${HOST_SLUG}/${version}/${HOST_SLUG}.zip`,
    sha256,
    signature,
  };
  releases.objects.set(manifestKey(HOST_SLUG, version), manifest);
  releases.objects.set(channelKey(HOST_SLUG, 'stable'), manifest);
}

const releases = new MemoryReleases();
let t: TestContext;
const queue = (retryFailed = false) => queueHostUpdates({ ...t.deps, storefrontProductId: t.productId }, { retryFailed });
const row = async (id: string) => (await t.pool.query('SELECT version, from_version, status, error FROM host_updates WHERE tenant_id = $1', [id])).rows[0];
const settled = (id: string, version: string) =>
  waitFor(async () => {
    const r = await row(id);
    return r && r.version === version && r.status !== Status.Pending;
  }, 60000);

async function newStore(name: string): Promise<string> {
  const res = await t.call('POST', '/v1/tenants', { body: { ...OWNER, name } });
  const id = ((await res.json()) as { id: string }).id;
  await waitFor(async () => (await t.pool.query('SELECT status FROM tenants WHERE id = $1', [id])).rows[0]?.status === Status.Done);
  return id;
}

beforeAll(async () => {
  t = await setup({ releases });
  t.deps.config.storefrontProductId = t.productId;
  const res = await t.call('POST', '/v1/versions', {
    body: {
      name: 'v1',
      phpVersion: '8.3',
      wordPressVersion: '6.8',
      useCustomUpload: true,
    },
  });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => (await t.pool.query('SELECT status FROM versions WHERE id = $1', [versionId])).rows[0]?.status === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});
afterAll(async () => {
  await t.close();
});

describe('AnyPress Host pushes', () => {
  let a: string;
  let b: string;

  it('does nothing until the channel has a release', async () => {
    a = await newStore('Storefront A');
    b = await newStore('Storefront B');
    expect(await queue()).toEqual({ version: null, queued: 0 });
  });

  it('gives every ready storefront the stable release once, replacing older folders', async () => {
    t.provisioner.stores.get(a)!.plugins = { 'wpcs-waas-host': '2.9.0' };
    publish('2.10.1');
    expect(await queue()).toEqual({ version: '2.10.1', queued: 2 });
    for (const id of [a, b]) {
      await settled(id, '2.10.1');
      expect(t.provisioner.stores.get(id)!.plugins).toEqual({
        [HOST_SLUG]: '2.10.1',
      });
    }
    expect(await row(a)).toEqual({
      version: '2.10.1',
      from_version: '2.9.0',
      status: Status.Done,
      error: null,
    });
    expect(await row(b)).toMatchObject({
      from_version: null,
      status: Status.Done,
    });
    expect(OLD_HOST_SLUGS).toContain('wpcs-waas-host');
    // Nothing new: nothing queued.
    expect(await queue()).toEqual({ version: '2.10.1', queued: 0 });
  });

  it('keeps a failed push on record, leaves it until asked, and tries it again through the admin API', async () => {
    // Only A this time.
    await t.pool.query('UPDATE tenants SET status = $2 WHERE id = $1', [b, Status.Failed]);
    publish('2.11.0');
    // The first try and its three retries fail.
    t.provisioner.failNext('updatePlugin', 4);
    expect(await queue()).toEqual({ version: '2.11.0', queued: 1 });
    await settled(a, '2.11.0');
    expect(await row(a)).toMatchObject({
      status: Status.Failed,
      error: expect.stringContaining('updatePlugin'),
    });
    const { rows: failures } = await t.pool.query("SELECT tenant_id FROM job_failures WHERE job_type = 'storefront.update-host'");
    expect(failures.map((f) => f.tenant_id)).toEqual([a]);
    // The store itself is untouched.
    expect((await t.pool.query('SELECT status FROM tenants WHERE id = $1', [a])).rows[0].status).toBe(Status.Done);
    expect(await queue()).toEqual({ version: '2.11.0', queued: 0 });

    const admin = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
    const res = await t.call('POST', '/admin/host-updates', {
      auth: null,
      headers: admin,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ version: '2.11.0', queued: 1 });
    await settled(a, '2.11.0');
    expect(await row(a)).toEqual({
      version: '2.11.0',
      from_version: '2.10.1',
      status: Status.Done,
      error: null,
    });

    const list = (await (await t.call('GET', '/admin/host-updates', { auth: null, headers: admin })).json()) as {
      tenantId: string;
      status: string;
      version: string;
    }[];
    expect(list.map((u) => [u.tenantId, u.status, u.version])).toEqual([
      [a, 'done', '2.11.0'],
      [b, 'done', '2.10.1'],
    ]);
    // A product key can't see or start them.
    expect((await t.call('GET', '/admin/host-updates')).status).toBe(403);
  }, 90000);

  it('leaves a storefront alone while its product is held at a release', async () => {
    const sold = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Sold') RETURNING id")).rows[0]!.id;
    await t.pool.query('UPDATE tenants SET external_id = $2 WHERE id = $1', [a, `storefront-${sold}`]);
    await t.pool.query('INSERT INTO plugin_pins (product_id, slug, version) VALUES ($1, $2, $3)', [sold, HOST_SLUG, '2.11.0']);
    await forgetHostUpdate(t.pool, a);
    expect(await queue()).toEqual({ version: '2.11.0', queued: 0 });
    await t.pool.query('DELETE FROM plugin_pins WHERE product_id = $1', [sold]);
  });

  it('pushes again once a store has its template copy back', async () => {
    await forgetHostUpdate(t.pool, a);
    expect(await queue()).toEqual({ version: '2.11.0', queued: 1 });
    await settled(a, '2.11.0');
    expect(await row(a)).toMatchObject({ status: Status.Done });
  });
});

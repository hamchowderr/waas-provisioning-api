import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../src/keys.ts';
import { Status } from '../src/status.ts';
import { basic, setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.close();
});

const create = (body: object, auth?: string) => t.call('POST', '/v1/basesnapshots', { body, auth });

describe('base snapshots (templates)', () => {
  it('validates name, comment and groupName', async () => {
    const ok = { name: 'Good Name', comment: 'x' };
    expect((await create(ok)).status).toBe(200);
    for (const name of ['abcd', 'x'.repeat(51), 'bad_underscore', 'no/slash']) {
      expect((await create({ ...ok, name })).status, name).toBe(400);
    }
    expect((await create({ name: 'Good Name', comment: '  ' })).status).toBe(400);
    expect((await create({ name: 'Good Name' })).status).toBe(400);
    // groupName only on a tenant snapshot.
    expect((await create({ ...ok, groupName: 'starter' })).status).toBe(400);
    expect((await create({ ...ok, groupName: 'starter', isTenantSnapshot: true })).status).toBe(200);
  });

  it("keeps each product's templates to itself", async () => {
    const other = (await t.pool.query("INSERT INTO products (name) VALUES ('Other storefront') RETURNING id")).rows[0].id;
    const { key, secret } = await createApiKey(t.pool, other);
    const auth = basic(key, secret);
    const mine = (await (await create({ name: 'Mine Only', comment: 'x' })).json()) as { id: string };
    const list = (await (await t.call('GET', '/v1/basesnapshots', { auth })).json()) as unknown[];
    expect(list).toEqual([]);
    expect((await t.call('DELETE', `/v1/basesnapshots?id=${mine.id}`, { auth })).status).toBe(400);
    // Nor can another product build a version from it.
    const res = await t.call('POST', '/v1/versions', { auth, body: { name: 'stolen', phpVersion: '8.3', wordPressVersion: '6.8', snapshotId: mine.id } });
    expect(res.status).toBe(400);
  });

  it('deletes the archive in a queued job and leaves version copies alone', async () => {
    const tpl = (await (await create({ name: 'Short Lived', comment: 'x', isTenantSnapshot: true, groupName: 'short' })).json()) as { id: string };
    const v = (await (await t.call('POST', '/v1/versions', { body: { name: 'with-copy', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true, snapshotIdsToCopy: [tpl.id] } })).json()) as { id: string };
    await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${v.id}`)).json()) as any[])[0]?.statusCode === Status.Done);
    expect((await t.call('DELETE', `/v1/basesnapshots?id=${tpl.id}`)).status).toBe(200);
    await waitFor(async () => !t.provisioner.baseSnapshots.has(tpl.id));
    const copies = (await (await t.call('GET', `/v1/snapshots?versionId=${v.id}&groupName=short`)).json()) as any[];
    expect(copies).toEqual([expect.objectContaining({ name: 'Short Lived', isTenantSnapshot: true, statusCode: Status.Done })]);
    // A deleted template can't seed a new version.
    const res = await t.call('POST', '/v1/versions', { body: { name: 'too-late', phpVersion: '8.3', wordPressVersion: '6.8', snapshotId: tpl.id } });
    expect(res.status).toBe(400);
  });
});

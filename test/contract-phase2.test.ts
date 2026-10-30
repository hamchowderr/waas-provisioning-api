// Runs every Phase 2 (reseller) operation the server answers with a partner key, and every Phase 1
// operation as a partner key calls it (with productId), and validates each response against the
// OpenAPI contract, as test/contract.test.ts does for Phase 1. Behaviour in more depth: test/resellers.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Status } from '../src/status.ts';
import { contractChecker, operations } from './contract.ts';
import { basic, setup, TEST_ADMIN_TOKEN, waitFor, type TestContext, OWNER } from './helpers.ts';

const phase2 = operations.filter((o) => o.phase === 2);

// Subscriptions (reseller accounts) are made and removed by the platform admin (docs/resellers.md),
// so these two are not answered on /v1 and are left out of the published reference.
const adminOnly = ['createSubscription', 'deleteSubscription'];
const served = phase2.map((o) => o.operationId).filter((id) => !adminOnly.includes(id));

const { expectContract, checked } = contractChecker();

let t: TestContext;
let account: { id: string };
let auth: string;
let storefront: string;
const outside = 'Basic ' + Buffer.from('nobody:nothing').toString('base64');

async function admin(method: string, path: string, body?: unknown): Promise<any> {
  const res = await t.call(method, path, { auth: `Bearer ${TEST_ADMIN_TOKEN}`, body });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  return res.json();
}

/** The storefront made with a first version, once that version is built. */
async function florists(): Promise<{ id: string; version: { id: string } }> {
  const [product]: any = await (await t.call('GET', '/v1/products?productName=Acme%20Florists', { auth })).json();
  const version: any = await waitFor(async () => {
    const [v]: any = await (await t.call('GET', `/v1/versions?productId=${product.id}`, { auth })).json();
    return v?.statusCode === Status.Done && v;
  });
  return { id: product.id, version };
}

beforeAll(async () => {
  t = await setup();
  account = await admin('POST', '/admin/resellers', { name: 'Acme Partners', maxProducts: 3 });
  const key = await admin('POST', `/admin/resellers/${account.id}/keys`, { label: 'Partner app' });
  auth = basic(key.id, key.secret);
});
afterAll(async () => {
  await t.close();
});

describe('contract coverage', () => {
  it('the contract has 11 Phase 2 operations, 9 of them on /v1', () => {
    expect(phase2).toHaveLength(11);
    expect(served).toHaveLength(9);
  });

  it('answers 404 to the admin-only subscription calls', async () => {
    expect((await t.call('POST', '/v1/subscriptions', { auth, body: { name: 'Another account' } })).status).toBe(404);
    expect((await t.call('DELETE', `/v1/subscriptions?subscriptionId=${account.id}`, { auth })).status).toBe(404);
  });
});

describe('Phase 2 operations with a partner key', () => {
  let templateId: string;

  it('listSubscriptions: its own account, filtered by name or id', async () => {
    expect(await expectContract('listSubscriptions', await t.call('GET', '/v1/subscriptions', { auth }))).toEqual([{ id: account.id, name: 'Acme Partners' }]);
    expect(await expectContract('listSubscriptions', await t.call('GET', `/v1/subscriptions?subscriptionId=${account.id}`, { auth }))).toHaveLength(1);
    expect(await expectContract('listSubscriptions', await t.call('GET', '/v1/subscriptions?name=Someone%20else', { auth }))).toEqual([]);
  });

  it('createProduct: a bare storefront', async () => {
    const made: any = await expectContract('createProduct', await t.call('POST', `/v1/products?subscriptionId=${account.id}`, { auth, body: { name: 'Acme Bakeries' } }));
    expect(made).toEqual({ id: expect.any(String), name: 'Acme Bakeries' });
    storefront = made.id;
  });

  it('createProduct: with a first version from an upload, which becomes production', async () => {
    const made: any = await expectContract(
      'createProduct',
      await t.call('POST', `/v1/products?subscriptionId=${account.id}`, {
        auth,
        body: { name: 'Acme Florists', version: { name: 'v1.0.0', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } },
      }),
    );
    expect(made.version).toMatchObject({ id: expect.any(String), phpVersion: '8.3', wordPressVersion: '6.8', uploadUrl: expect.stringMatching(/^https:\/\//) });
    const versions: any = await expectContract('listVersions', await t.call('GET', `/v1/versions?productId=${made.id}`, { auth }));
    expect(versions).toEqual([expect.objectContaining({ id: made.version.id, isProduction: true })]);
  });

  it('listProducts: every storefront in the account, filtered by id or name', async () => {
    const all: any = await expectContract('listProducts', await t.call('GET', '/v1/products', { auth }));
    expect(all.map((p: any) => p.name)).toEqual(['Acme Bakeries', 'Acme Florists']);
    expect(all[0]).toEqual({ id: storefront, name: 'Acme Bakeries', subscriptionId: account.id, subscriptionName: 'Acme Partners', statusCode: Status.Done, statusName: 'Done' });
    expect(await expectContract('listProducts', await t.call('GET', `/v1/products?productId=${storefront}`, { auth }))).toHaveLength(1);
    expect(await expectContract('listProducts', await t.call('GET', '/v1/products?productName=Acme%20Florists', { auth }))).toHaveLength(1);
    expect(await expectContract('listProducts', await t.call('GET', `/v1/products?subscriptionId=${crypto.randomUUID()}`, { auth }))).toEqual([]);
  });

  it('createBaseSnapshotTemplateUpload: a template shared by every storefront', async () => {
    const made: any = await expectContract(
      'createBaseSnapshotTemplateUpload',
      await t.call('POST', '/v1/basesnapshots', { auth, body: { name: 'Acme starter', comment: 'Home, shop and contact pages' } }),
    );
    expect(made).toMatchObject({ id: expect.any(String), name: 'Acme starter', uploadUrl: expect.stringMatching(/^https:\/\//) });
    templateId = made.id;
  });

  it('listBaseSnapshotsTemplates: shared ones without productId, shared and own with it', async () => {
    const own: any = await expectContract(
      'createBaseSnapshotTemplateUpload',
      await t.call('POST', `/v1/basesnapshots?productId=${storefront}`, { auth, body: { name: 'Bakery extras', comment: 'Just this storefront' } }),
    );
    // A template made with productId is still the account's: a partner key's templates are shared.
    const names = async (query: string) => ((await expectContract('listBaseSnapshotsTemplates', await t.call('GET', `/v1/basesnapshots${query}`, { auth }))) as any[]).map((b) => b.name);
    expect(await names('')).toEqual(['Acme starter', 'Bakery extras']);
    expect(await names(`?productId=${storefront}&onlyPartnerSpecific=true`)).toEqual(['Acme starter', 'Bakery extras']);
    expect(await names(`?baseSnapshotId=${templateId}`)).toEqual(['Acme starter']);
    expect(await expectContract('deleteBaseSnapshot', await t.call('DELETE', `/v1/basesnapshots?id=${own.id}`, { auth }))).toEqual({ baseSnapshotId: own.id });
  });

  it('subscriptionUsage and productUsage: hours in a window', async () => {
    const start = new Date(Date.now() - 4 * 3600_000);
    const end = new Date(Date.now() - 3600_000);
    // A store live for the last two hours of the window.
    await t.pool.query(
      `INSERT INTO tenant_periods (tenant_id, product_id, reseller_id, size, started_at, ended_at)
       VALUES (gen_random_uuid(), $1, $2, 'small', $3, NULL)`,
      [storefront, account.id, new Date(end.getTime() - 2 * 3600_000)],
    );
    const q = `startDate=${start.toISOString()}&endDate=${end.toISOString()}`;
    expect(await expectContract('subscriptionUsage', await t.call('GET', `/v1/subscriptions/usage?subscriptionId=${account.id}&${q}`, { auth }))).toEqual({
      subscriptionId: account.id,
      productHours: 0,
      versionHours: 0,
      tenantHours: 2,
    });
    expect(await expectContract('productUsage', await t.call('GET', `/v1/products/usage?productId=${storefront}&${q}`, { auth }))).toEqual({
      productId: storefront,
      productHours: 0,
      versionHours: 0,
      tenantHours: 2,
    });
  });

  it('deleteBaseSnapshot: the shared template', async () => {
    expect(await expectContract('deleteBaseSnapshot', await t.call('DELETE', `/v1/basesnapshots?id=${templateId}`, { auth }))).toEqual({ baseSnapshotId: templateId });
  });

  it('deleteProduct: a storefront with no stores', async () => {
    const extra: any = await (await t.call('POST', `/v1/products?subscriptionId=${account.id}`, { auth, body: { name: 'Acme Short-lived' } })).json();
    expect(await expectContract('deleteProduct', await t.call('DELETE', `/v1/products?productId=${extra.id}`, { auth }))).toEqual({ productId: extra.id });
  });

  it('400 responses carry an ExceptionResult', async () => {
    // A store on the storefront with a production version, so it can't be removed.
    const withStore = await florists();
    expect((await t.call('POST', `/v1/tenants?productId=${withStore.id}`, { auth, body: { ...OWNER, name: 'Florist shop' } })).status).toBe(200);
    const day = `startDate=2026-10-01T00:00:00Z&endDate=2026-10-02T00:00:00Z`;
    // The account's third storefront, so the next one is over its limit of 3.
    expect((await t.call('POST', `/v1/products?subscriptionId=${account.id}`, { auth, body: { name: 'Acme Third' } })).status).toBe(200);
    const cases: [string, () => Promise<Response>, string][] = [
      ['listSubscriptions', () => t.call('GET', '/v1/subscriptions?subscriptionId=not-a-uuid', { auth }), 'subscriptionId must be a UUID'],
      ['listProducts', () => t.call('GET', '/v1/products?productId=not-a-uuid', { auth }), 'productId must be a UUID'],
      ['createProduct', () => t.call('POST', `/v1/products?subscriptionId=${account.id}`, { auth, body: {} }), 'name'],
      ['createProduct', () => t.call('POST', `/v1/products?subscriptionId=${account.id}`, { auth, body: { name: 'Acme Fourth' } }), 'limit of 3'],
      ['deleteProduct', () => t.call('DELETE', '/v1/products', { auth }), 'productId is required'],
      ['deleteProduct', () => t.call('DELETE', `/v1/products?productId=${withStore.id}`, { auth }), 'still has 1 store'],
      ['subscriptionUsage', () => t.call('GET', `/v1/subscriptions/usage?subscriptionId=${account.id}`, { auth }), 'startDate'],
      ['subscriptionUsage', () => t.call('GET', `/v1/subscriptions/usage?subscriptionId=${account.id}&startDate=2026-10-02T00:00:00Z&endDate=2026-10-01T00:00:00Z`, { auth }), 'endDate must be after startDate'],
      ['productUsage', () => t.call('GET', `/v1/products/usage?${day}`, { auth }), 'productId is required'],
      ['listBaseSnapshotsTemplates', () => t.call('GET', '/v1/basesnapshots?baseSnapshotId=not-a-uuid', { auth }), 'baseSnapshotId must be a UUID'],
      ['createBaseSnapshotTemplateUpload', () => t.call('POST', '/v1/basesnapshots', { auth, body: { name: 'abc', comment: 'too short a name' } }), 'name'],
      ['deleteBaseSnapshot', () => t.call('DELETE', `/v1/basesnapshots?id=${crypto.randomUUID()}`, { auth }), 'not found'],
    ];
    for (const [operationId, res, message] of cases) {
      const r = await res();
      expect(r.status, operationId).toBe(400);
      const body: any = await expectContract(operationId, r);
      expect(body, operationId).toMatchObject({ statusCode: 400 });
      expect(body.message, operationId).toContain(message);
    }
  });

  it("403 for another account's ids, and for a storefront's own key", async () => {
    const other = await admin('POST', '/admin/resellers', { name: 'Other Partners' });
    const productKey = (await admin('POST', `/admin/products/${storefront}/keys`, { label: 'Storefront' })) as { id: string; secret: string };
    const own = basic(productKey.id, productKey.secret);
    const day = `startDate=2026-10-01T00:00:00Z&endDate=2026-10-02T00:00:00Z`;
    const cases: [string, () => Promise<Response>][] = [
      ['createProduct', () => t.call('POST', `/v1/products?subscriptionId=${other.id}`, { auth, body: { name: 'Elsewhere' } })],
      ['deleteProduct', () => t.call('DELETE', `/v1/products?productId=${t.productId}`, { auth })],
      ['subscriptionUsage', () => t.call('GET', `/v1/subscriptions/usage?subscriptionId=${other.id}&${day}`, { auth })],
      ['productUsage', () => t.call('GET', `/v1/products/usage?productId=${t.productId}&${day}`, { auth })],
      ['listSubscriptions', () => t.call('GET', '/v1/subscriptions', { auth: own })],
      ['listProducts', () => t.call('GET', '/v1/products', { auth: own })],
      ['createProduct', () => t.call('POST', `/v1/products?subscriptionId=${account.id}`, { auth: own, body: { name: 'Nope' } })],
      ['deleteProduct', () => t.call('DELETE', `/v1/products?productId=${storefront}`, { auth: own })],
      ['subscriptionUsage', () => t.call('GET', `/v1/subscriptions/usage?subscriptionId=${account.id}&${day}`, { auth: own })],
      ['productUsage', () => t.call('GET', `/v1/products/usage?productId=${storefront}&${day}`, { auth: own })],
    ];
    for (const [operationId, res] of cases) {
      const r = await res();
      expect(r.status, operationId).toBe(403);
      await expectContract(operationId, r);
    }
  });

  it('every served operation answers 403 to bad credentials', async () => {
    for (const op of phase2.filter((o) => served.includes(o.operationId))) {
      const res = await t.call(op.method.toUpperCase(), op.path, { auth: outside });
      expect(res.status, op.operationId).toBe(403);
      await expectContract(op.operationId, res);
    }
  });

  it('checked a 200 and a 400 for every served operation', () => {
    for (const id of served) {
      expect(checked.has(`${id} 200`), `${id} 200`).toBe(true);
      expect(checked.has(`${id} 400`), `${id} 400`).toBe(true);
    }
  });
});

describe('Phase 1 operations with a partner key', () => {
  const phase1 = operations.filter((o) => o.phase === 1);

  it('every one answers 400 without productId, and 403 for a storefront outside the account', async () => {
    for (const op of phase1) {
      const missing = await t.call(op.method.toUpperCase(), op.path, { auth, body: op.method === 'get' || op.method === 'delete' ? undefined : {} });
      expect(missing.status, `${op.operationId} without productId`).toBe(400);
      expect(await expectContract(op.operationId, missing)).toEqual({ statusCode: 400, message: 'productId is required with a partner key' });

      const elsewhere = await t.call(op.method.toUpperCase(), `${op.path}?productId=${t.productId}`, { auth });
      expect(elsewhere.status, `${op.operationId} outside the account`).toBe(403);
      await expectContract(op.operationId, elsewhere);
    }
  });

  it('a store made, listed and removed on a named storefront, as with its own key', async () => {
    const { id, version } = await florists();

    const made: any = await expectContract('createTenant', await t.call('POST', `/v1/tenants?productId=${id}`, { auth, body: { ...OWNER, name: 'Rose and Fern', externalId: 'acme-order-1' } }));
    expect(made).toMatchObject({ externalId: 'acme-order-1', baseDomain: expect.any(String) });
    const listed: any = await waitFor(async () => {
      const list: any = await expectContract('listTenants', await t.call('GET', `/v1/tenants?productId=${id}&externalId=acme-order-1`, { auth }));
      return list[0]?.statusCode === Status.Done && list;
    });
    expect(listed[0]).toMatchObject({ id: made.id, versionId: version.id });
    // Another storefront in the same account doesn't see it.
    expect(await (await t.call('GET', `/v1/tenants?productId=${storefront}&externalId=acme-order-1`, { auth })).json()).toEqual([]);
    const removed = await t.call('DELETE', `/v1/tenants?productId=${id}&externalId=acme-order-1`, { auth });
    expect(removed.status).toBe(200);
    await expectContract('deleteTenant', removed);
  });
});

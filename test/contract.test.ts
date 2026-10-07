// Runs every Phase 1 operation implemented so far and validates each response against the
// OpenAPI contract (status code listed for the operation, content type, and body schema).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Status } from '../src/status.ts';
import { createAjv, spec } from '../src/openapi.ts';
import { setup, waitFor, type TestContext } from './helpers.ts';

type Method = 'get' | 'post' | 'put' | 'delete';
type Operation = { method: Method; path: string; operationId: string };

const phase1: Operation[] = Object.entries(spec.paths).flatMap(([path, item]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.entries(item as Record<string, any>)
    .filter(([, op]) => op?.['x-phase'] === 1)
    .map(([method, op]) => ({ method: method as Method, path, operationId: op.operationId })),
);

const implemented = [
  'listVersions',
  'createVersion',
  'deleteVersion',
  'setProductionVersion',
  'listSnapshots',
  'downloadSnapshot',
  'listTenants',
  'createTenant',
  'updateTenantOptionsAndConstants',
  'deleteTenant',
  'moveTenantToAVersion',
];

// Strict: no removeAdditional, so unknown response fields fail (the schemas set additionalProperties: false).
const ajv = createAjv();
const checked = new Set<string>();

async function expectContract(operationId: string, res: Response): Promise<unknown> {
  const op = phase1.find((o) => o.operationId === operationId)!;
  const declared = spec.paths[op.path][op.method].responses[String(res.status)];
  expect(declared, `${operationId} returned ${res.status}, which the contract does not list`).toBeDefined();
  checked.add(`${operationId} ${res.status}`);
  if (!declared.content) return undefined;
  const contentType = res.headers.get('content-type') ?? '';
  const entries = Object.entries(declared.content) as [string, { schema: object }][];
  const match = entries.find(([type]) => contentType.startsWith(type));
  expect(match, `${operationId} ${res.status}: content type ${contentType} is not in the contract`).toBeDefined();
  const [type, media] = match!;
  if (type !== 'application/json') return new Uint8Array(await res.arrayBuffer());
  const body = await res.json();
  const schema = JSON.parse(JSON.stringify(media.schema).replaceAll('"#/components', '"spec#/components'));
  const validate = ajv.compile(schema);
  expect(validate(body), `${operationId} ${res.status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  return body;
}

let t: TestContext;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.close();
});

describe('contract coverage', () => {
  it('the contract has 17 Phase 1 operations', () => {
    expect(phase1).toHaveLength(17);
    for (const id of implemented) expect(phase1.map((o) => o.operationId)).toContain(id);
  });

  for (const op of phase1.filter((o) => !implemented.includes(o.operationId))) {
    it.todo(`${op.operationId} (${op.method.toUpperCase()} ${op.path})`);
  }
});

describe('Phase 1 operations', () => {
  let versionId: string;
  let snapshotId: string;
  let copyVersionId: string;
  let tenant: { id: string; externalId: string; baseDomain: string; customDomain?: string };

  it('listVersions: empty product', async () => {
    expect(await expectContract('listVersions', await t.call('GET', '/v1/versions'))).toEqual([]);
  });

  it('createVersion: from an uploaded archive', async () => {
    const body: any = await expectContract(
      'createVersion',
      await t.call('POST', '/v1/versions', { body: { name: 'v1.0.0', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } }),
    );
    expect(body.domainName).toBe('v1-0-0.versions.waas.example');
    expect(body.uploadUrl).toMatch(/^https:\/\//);
    versionId = body.id;
  });

  it('listVersions: the version moves from Pending to Done', async () => {
    const versions: any = await waitFor(async () => {
      const list: any = await expectContract('listVersions', await t.call('GET', `/v1/versions?versionId=${versionId}`));
      return list[0]?.statusCode === Status.Done && list;
    });
    expect(versions[0]).toMatchObject({ id: versionId, isProduction: false, statusName: 'Done', domain: 'v1-0-0.versions.waas.example' });
  });

  it('setProductionVersion', async () => {
    expect(await expectContract('setProductionVersion', await t.call('PUT', '/v1/versions/production', { body: { versionId } }))).toEqual({ id: versionId });
    const [version]: any = await (await t.call('GET', '/v1/versions?versionName=v1.0.0')).json();
    expect(version.isProduction).toBe(true);
  });

  it('listSnapshots: onlyProductionVersion=true', async () => {
    const snapshots: any = await expectContract('listSnapshots', await t.call('GET', '/v1/snapshots?onlyProductionVersion=true'));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ versionId, name: 'v1.0.0', isCustomSnapshot: true, statusCode: Status.Done });
    snapshotId = snapshots[0].id;
  });

  it('downloadSnapshot', async () => {
    const zip = (await expectContract('downloadSnapshot', await t.call('GET', `/v1/snapshots/download?snapshotId=${snapshotId}`))) as Uint8Array;
    expect(Buffer.from(zip.subarray(0, 4)).readUInt32LE(0)).toBe(0x06054b50);
  });

  it('createVersion: from a snapshot', async () => {
    const body: any = await expectContract(
      'createVersion',
      await t.call('POST', '/v1/versions', { body: { name: 'v1.1.0', phpVersion: '8.3', wordPressVersion: '6.8', snapshotId } }),
    );
    expect(body.uploadUrl).toBeUndefined();
    copyVersionId = body.id;
    const copies: any = await waitFor(async () => {
      const list: any = await expectContract('listSnapshots', await t.call('GET', `/v1/snapshots?versionId=${copyVersionId}`));
      return list[0]?.statusCode === Status.Done && list;
    });
    expect(copies[0]).toMatchObject({ name: 'v1.0.0', versionId: copyVersionId });
  });

  // What the storefront plugin sends (WPCSService.php:100-123): no externalId.
  const storefrontTenant = {
    name: 'Example Store',
    wordPressUserName: 'example-owner',
    wordPressUserEmail: 'owner@example.com',
    wordPressUserRole: 'administrator',
    wordPressUserPassword: 'example-password-1',
    customDomainName: 'shop.example.com',
    phpConstants: {
      WPCS_TENANT_ROLES: { value: 'shop_manager,editor' },
      WPCS_PUBLIC_KEY: { value: Buffer.from('example public key').toString('base64') },
      WPCS_TENANT_NO_ADMINISTRATOR_PLUGIN_CAPS: { value: 'true' },
    },
  };

  it('createTenant: generates externalId, returns bare base and custom domains', async () => {
    tenant = (await expectContract('createTenant', await t.call('POST', '/v1/tenants', { body: storefrontTenant }))) as typeof tenant;
    expect(tenant.externalId).toBeTruthy();
    expect(tenant.baseDomain).toBe(`t-${tenant.id.slice(0, 8)}.stores.waas.example`);
    expect(tenant.customDomain).toBe('shop.example.com');
  });

  it('createTenant: customDomain is absent, not null or "", without a custom domain', async () => {
    const body: any = await expectContract('createTenant', await t.call('POST', '/v1/tenants', { body: { name: 'No Custom Domain' } }));
    expect('customDomain' in body).toBe(false);
    const [created]: any = await waitFor(async () => {
      const list: any = await (await t.call('GET', `/v1/tenants?externalId=${body.externalId}`)).json();
      return list[0]?.statusCode === Status.Done && list;
    });
    expect(created.domainName).toBe(body.baseDomain);
  });

  it('listTenants: Pending to Done, domainName equals the creation-time customDomain', async () => {
    const [found]: any = await waitFor(async () => {
      const list: any = await expectContract('listTenants', await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`));
      return list[0]?.statusCode === Status.Done && list;
    });
    expect(found).toMatchObject({
      id: tenant.id,
      tenantId: tenant.id,
      name: 'Example Store',
      versionId,
      versionName: 'v1.0.0',
      basedOnSnapshotId: snapshotId,
      domainName: tenant.customDomain,
      redirectDomains: [tenant.baseDomain],
      statusName: 'Done',
    });
    const store = t.provisioner.stores.get(tenant.id)!;
    expect(store.phpConstants.WPCS_TENANT_ROLES!.value).toBe('shop_manager,editor');
    expect(store.user).toMatchObject({ name: 'example-owner', role: 'administrator', password: 'example-password-1' });
  });

  it('updateTenantOptionsAndConstants', async () => {
    const body = { phpConstants: { WPCS_TENANT_ROLES: { value: 'shop_manager' } }, wpOptions: { blogname: 'Example Store' } };
    expect(await expectContract('updateTenantOptionsAndConstants', await t.call('PUT', `/v1/tenants?externalId=${tenant.externalId}`, { body }))).toEqual({
      tenantId: tenant.id,
      externalId: tenant.externalId,
    });
    await waitFor(async () => t.provisioner.stores.get(tenant.id)?.phpConstants.WPCS_TENANT_ROLES?.value === 'shop_manager');
    expect(t.provisioner.stores.get(tenant.id)!.wpOptions.blogname).toBe('Example Store');
    // [] is an empty PUT body.
    expect((await t.call('PUT', `/v1/tenants?externalId=${tenant.externalId}`, { body: [] })).status).toBe(200);
  });

  it('moveTenantToAVersion', async () => {
    expect(
      await expectContract('moveTenantToAVersion', await t.call('POST', `/v1/tenants/version?externalId=${tenant.externalId}`, { body: { targetVersionId: copyVersionId } })),
    ).toEqual({ targetVersionId: copyVersionId, tenantId: tenant.id, externalId: tenant.externalId });
    await waitFor(async () => {
      const [found]: any = await (await t.call('GET', `/v1/tenants?tenantId=${tenant.id}`)).json();
      return found.statusCode === Status.Done && found.versionId === copyVersionId;
    });
  });

  it('deleteTenant: by a non-UUID tenantId (plugin 2.2.7 sends the external ID there)', async () => {
    await expectContract('deleteTenant', await t.call('DELETE', `/v1/tenants?tenantId=${tenant.externalId}-x`).then(async (r) => {
      expect(r.status).toBe(400); // unknown
      return r;
    }));
    const externalId = 'example-store-42';
    await t.call('POST', '/v1/tenants', { body: { name: 'Delete Me', externalId } });
    await expectContract('deleteTenant', await t.call('DELETE', `/v1/tenants?tenantId=${externalId}`));
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as unknown[]).length === 0);
  });

  it('deleteTenant: by externalId', async () => {
    await expectContract('deleteTenant', await t.call('DELETE', `/v1/tenants?externalId=${tenant.externalId}`));
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`)).json()) as unknown[]).length === 0);
    expect(t.provisioner.stores.has(tenant.id)).toBe(false);
  });

  it('deleteVersion: Removing, then gone', async () => {
    await expectContract('deleteVersion', await t.call('DELETE', `/v1/versions?versionId=${copyVersionId}`));
    await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${copyVersionId}`)).json()) as unknown[]).length === 0);
    expect(await (await t.call('GET', `/v1/snapshots?versionId=${copyVersionId}`)).json()).toEqual([]);
  });

  it('400 responses carry an ExceptionResult', async () => {
    const cases: [string, Promise<Response>][] = [
      ['createVersion', t.call('POST', '/v1/versions', { body: { name: 'v2' } })],
      ['deleteVersion', t.call('DELETE', '/v1/versions?versionId=not-a-uuid')],
      ['setProductionVersion', t.call('PUT', '/v1/versions/production', { body: [] })],
      ['listSnapshots', t.call('GET', '/v1/snapshots?onlyProductionVersion=maybe')],
      ['downloadSnapshot', t.call('GET', '/v1/snapshots/download')],
      ['createTenant', t.call('POST', '/v1/tenants', { body: { name: 'x', customDomainName: 'https://shop.example.com/' } })],
      ['updateTenantOptionsAndConstants', t.call('PUT', '/v1/tenants', { body: {} })],
      ['deleteTenant', t.call('DELETE', '/v1/tenants')],
      ['moveTenantToAVersion', t.call('POST', '/v1/tenants/version?externalId=nobody', { body: { targetVersionId: crypto.randomUUID() } })],
    ];
    for (const [operationId, res] of cases) {
      const r = await res;
      expect(r.status, operationId).toBe(400);
      expect(await expectContract(operationId, r)).toMatchObject({ statusCode: 400 });
    }
  });

  it('every implemented operation answers 403 to bad credentials', async () => {
    for (const op of phase1.filter((o) => implemented.includes(o.operationId))) {
      const res = await t.call(op.method.toUpperCase(), op.path, { auth: 'Basic ' + Buffer.from('nobody:nothing').toString('base64') });
      expect(res.status, op.operationId).toBe(403);
      await expectContract(op.operationId, res);
    }
  });

  it('checked a 200 for every implemented operation', () => {
    for (const id of implemented) expect(checked.has(`${id} 200`), id).toBe(true);
  });
});

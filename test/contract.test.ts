// Runs every Phase 1 operation implemented so far and validates each response against the
// OpenAPI contract (status code listed for the operation, content type, and body schema).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Status } from '../src/status.ts';
import { dnsSafeLabel } from '../src/tenants.ts';
import { createAjv, spec } from '../src/openapi.ts';
import { setup, waitFor, type TestContext } from './helpers.ts';

type Method = 'get' | 'post' | 'put' | 'delete';
type Operation = { method: Method; path: string; operationId: string };

const operations: (Operation & { phase: number })[] = Object.entries(spec.paths).flatMap(([path, item]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.entries(item as Record<string, any>)
    .filter(([, op]) => op?.['x-phase'])
    .map(([method, op]) => ({ method: method as Method, path, operationId: op.operationId, phase: op['x-phase'] })),
);
const phase1 = operations.filter((o) => o.phase === 1);

// Phase 2 operations that product keys may already use (contract draft.5).
const earlyPhase2 = ['listBaseSnapshotsTemplates', 'createBaseSnapshotTemplateUpload', 'deleteBaseSnapshot'];

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
  'addDomainDeprecated',
  'listTenantDomains',
  'addTenantDomain',
  'removeTenantDomain',
  'setMainDomain',
  'checkDomainAvailability',
  'suspendTenant',
  'resumeTenant',
  'listTenantBackups',
  'createTenantBackup',
  'restoreTenant',
];

// Strict: no removeAdditional, so unknown response fields fail (the schemas set additionalProperties: false).
const ajv = createAjv();
const checked = new Set<string>();

async function expectContract(operationId: string, res: Response): Promise<unknown> {
  const op = operations.find((o) => o.operationId === operationId)!;
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
  it('the contract has 22 Phase 1 operations (17 from WPCS v1, 5 TenantLifecycle)', () => {
    expect(phase1).toHaveLength(22);
    for (const id of implemented) expect(phase1.map((o) => o.operationId)).toContain(id);
  });

  it('every Phase 1 operation is implemented and run below', () => {
    expect(phase1.map((o) => o.operationId).filter((id) => !implemented.includes(id))).toEqual([]);
  });
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
    expect(body.domainName).toBe('v1-0-0-v.versions.waas.example');
    expect(body.uploadUrl).toMatch(/^https:\/\//);
    versionId = body.id;
  });

  it('listVersions: the version moves from Pending to Done', async () => {
    const versions: any = await waitFor(async () => {
      const list: any = await expectContract('listVersions', await t.call('GET', `/v1/versions?versionId=${versionId}`));
      return list[0]?.statusCode === Status.Done && list;
    });
    expect(versions[0]).toMatchObject({ id: versionId, isProduction: false, statusName: 'Done', domain: 'v1-0-0-v.versions.waas.example' });
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
    expect(tenant.baseDomain).toBe(`${dnsSafeLabel(`t-${tenant.id.slice(0, 8)}`, 's')}.stores.waas.example`);
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
    // One tenant by its id (the API has no separate get-tenant operation) carries its name too.
    const byId: any = await expectContract('listTenants', await t.call('GET', `/v1/tenants?tenantId=${tenant.id}`));
    expect(byId).toEqual([expect.objectContaining({ tenantId: tenant.id, name: 'Example Store' })]);
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

  const tenantDomains = async () =>
    (await (await t.call('GET', `/v1/tenants/domains?externalId=${tenant.externalId}`)).json()) as { id: string; domainName: string; isMainDomain: boolean }[];
  const tenantDone = () =>
    waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`)).json()) as { statusCode: number }[])[0]!.statusCode === Status.Done);

  it('listTenantDomains', async () => {
    const domains: any = await expectContract('listTenantDomains', await t.call('GET', `/v1/tenants/domains?externalId=${tenant.externalId}`));
    expect(domains).toEqual([
      expect.objectContaining({ domainName: tenant.baseDomain, isBaseDomain: true, isMainDomain: false }),
      expect.objectContaining({ domainName: 'shop.example.com', isBaseDomain: false, isMainDomain: true }),
    ]);
  });

  it('checkDomainAvailability', async () => {
    expect(await expectContract('checkDomainAvailability', await t.call('GET', '/v1/tenants/domains/available?domain=shop.example.com'))).toEqual({ available: false });
    expect(await expectContract('checkDomainAvailability', await t.call('GET', '/v1/tenants/domains/available?domain=new-shop.example.com'))).toEqual({ available: true });
  });

  it('addTenantDomain: the storefront switching to a new main domain', async () => {
    // WPCSService.php:150: {domainName, setAsMainDomain: true}, then remove the old one.
    expect(
      await expectContract(
        'addTenantDomain',
        await t.call('POST', `/v1/tenants/domains?externalId=${tenant.externalId}`, { body: { domainName: 'new-shop.example.com', setAsMainDomain: true } }),
      ),
    ).toEqual({ tenantId: tenant.id, externalId: tenant.externalId, domain: 'new-shop.example.com', setAsMainDomain: true });
    await tenantDone();
    const [found]: any = await (await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`)).json();
    expect(found.domainName).toBe('new-shop.example.com');
    expect(t.provisioner.stores.get(tenant.id)!.mainDomain).toBe('new-shop.example.com');
  });

  it('removeTenantDomain', async () => {
    expect(
      await expectContract('removeTenantDomain', await t.call('DELETE', `/v1/tenants/domains?externalId=${tenant.externalId}&domainName=shop.example.com`)),
    ).toMatchObject({ domainName: 'shop.example.com' });
    await tenantDone();
    expect((await tenantDomains()).map((d) => d.domainName)).toEqual([tenant.baseDomain, 'new-shop.example.com']);
    expect(t.provisioner.stores.get(tenant.id)!.redirectDomains).toEqual([tenant.baseDomain]);
  });

  it('addDomainDeprecated', async () => {
    expect(
      await expectContract('addDomainDeprecated', await t.call('POST', `/v1/tenants/domain?externalId=${tenant.externalId}`, { body: { domainName: 'www.new-shop.example.com' } })),
    ).toEqual({ tenantId: tenant.id, externalId: tenant.externalId, domain: 'www.new-shop.example.com', setAsMainDomain: false });
    await tenantDone();
  });

  it('setMainDomain', async () => {
    const www = (await tenantDomains()).find((d) => d.domainName === 'www.new-shop.example.com')!;
    expect(await expectContract('setMainDomain', await t.call('PUT', `/v1/tenants/domains/main?externalId=${tenant.externalId}`, { body: { domainId: www.id } }))).toEqual({
      id: www.id,
      domainName: 'www.new-shop.example.com',
    });
    await tenantDone();
    expect((await tenantDomains()).find((d) => d.isMainDomain)!.id).toBe(www.id);
  });

  const getTenant = async () => ((await (await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`)).json()) as any[])[0];
  const backupsOf = async (externalId: string) =>
    expectContract('listTenantBackups', await t.call('GET', `/v1/tenants/backups?externalId=${externalId}`)) as Promise<any[]>;

  it('createTenantBackup, listTenantBackups', async () => {
    const res: any = await expectContract('createTenantBackup', await t.call('POST', `/v1/tenants/backups?externalId=${tenant.externalId}`));
    expect(res).toMatchObject({ tenantId: tenant.id, externalId: tenant.externalId });
    const backups = await waitFor(async () => {
      const list = await backupsOf(tenant.externalId);
      return list[0]?.statusCode === Status.Done && list;
    });
    expect(backups[0]).toMatchObject({ id: res.backupId, reason: 'manual', sizeBytes: expect.any(Number), statusName: 'Done' });
  });

  it('suspendTenant: backs up, then goes offline; isSuspended and dateSuspended on the tenant', async () => {
    expect((await getTenant()).isSuspended).toBe(false);
    expect((await getTenant()).dateSuspended).toBeNull();
    const res: any = await expectContract('suspendTenant', await t.call('POST', `/v1/tenants/suspend?externalId=${tenant.externalId}`, { body: { takeBackup: true } }));
    expect(res.backupId).toEqual(expect.any(String));
    await tenantDone();
    const found = await getTenant();
    expect(found.isSuspended).toBe(true);
    expect(Date.parse(found.dateSuspended)).not.toBeNaN();
    expect(t.provisioner.stores.get(tenant.id)!.suspended).toBe(true);
    expect((await backupsOf(tenant.externalId))[0]).toMatchObject({ id: res.backupId, reason: 'suspend', statusCode: Status.Done });
  });

  it('suspendTenant: idempotent, no second backup', async () => {
    const res: any = await expectContract('suspendTenant', await t.call('POST', `/v1/tenants/suspend?externalId=${tenant.externalId}`, { body: { takeBackup: true } }));
    expect(res.backupId).toBeNull();
    expect(await backupsOf(tenant.externalId)).toHaveLength(2);
  });

  it('resumeTenant', async () => {
    expect(await expectContract('resumeTenant', await t.call('POST', `/v1/tenants/resume?externalId=${tenant.externalId}`))).toEqual({
      tenantId: tenant.id,
      externalId: tenant.externalId,
      backupId: null,
    });
    await tenantDone();
    expect(await getTenant()).toMatchObject({ isSuspended: false, dateSuspended: null });
    expect(t.provisioner.stores.get(tenant.id)!.suspended).toBe(false);
    // Idempotent.
    expect((await t.call('POST', `/v1/tenants/resume?externalId=${tenant.externalId}`)).status).toBe(200);
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
    // Backups outlive the tenant.
    expect((await backupsOf(tenant.externalId)).map((b) => b.reason).sort()).toEqual(['manual', 'suspend']);
  });

  it('restoreTenant: the newest Done backup by default; same externalId and domains, not suspended', async () => {
    const [newest] = await backupsOf(tenant.externalId);
    const res: any = await expectContract('restoreTenant', await t.call('POST', `/v1/tenants/restore?externalId=${tenant.externalId}`, { body: {} }));
    expect(res).toEqual({ tenantId: tenant.id, externalId: tenant.externalId, backupId: newest.id });
    // Pending until the job runs; the fake host can finish before this read.
    expect([Status.Pending, Status.Done]).toContain((await getTenant()).statusCode);
    await tenantDone();
    const restored = await getTenant();
    expect(restored).toMatchObject({ id: tenant.id, domainName: 'www.new-shop.example.com', isSuspended: false, dateSuspended: null });
    const store = t.provisioner.stores.get(tenant.id)!;
    expect(store.mainDomain).toBe('www.new-shop.example.com');
    expect(store.phpConstants.WPCS_TENANT_ROLES!.value).toBe('shop_manager');
    expect(store.wpOptions.blogname).toBe('Example Store');
    expect(store.suspended).toBe(false);
    // Restoring a live tenant is refused.
    expect((await t.call('POST', `/v1/tenants/restore?externalId=${tenant.externalId}`, { body: {} })).status).toBe(400);
    // Delete it again so its version can be removed below.
    await t.call('DELETE', `/v1/tenants?externalId=${tenant.externalId}`);
    await waitFor(async () => !(await getTenant()));
  });

  it('deleteVersion: Removing, then gone', async () => {
    await expectContract('deleteVersion', await t.call('DELETE', `/v1/versions?versionId=${copyVersionId}`));
    await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${copyVersionId}`)).json()) as unknown[]).length === 0);
    expect(await (await t.call('GET', `/v1/snapshots?versionId=${copyVersionId}`)).json()).toEqual([]);
  });

  it('base snapshots: a template becomes a snapshot group on the production version, and a store is built from it', async () => {
    const base: any = await expectContract(
      'createBaseSnapshotTemplateUpload',
      await t.call('POST', '/v1/basesnapshots', { body: { name: 'Peptide Base 2026', comment: 'Plain WordPress with WooCommerce' } }),
    );
    expect(base.uploadUrl).toMatch(/^https:\/\//);
    const starter: any = await expectContract(
      'createBaseSnapshotTemplateUpload',
      await t.call('POST', '/v1/basesnapshots', {
        body: { name: 'Peptide Starter', comment: 'Starter store', isTenantSnapshot: true, groupName: 'peptide-starter', showInConsole: true },
      }),
    );
    const listed: any = await expectContract('listBaseSnapshotsTemplates', await t.call('GET', '/v1/basesnapshots?groupName=peptide-starter&onlyPartnerSpecific=true'));
    expect(listed).toEqual([expect.objectContaining({ id: starter.id, isTenantSnapshot: true, groupName: 'peptide-starter', showAsBaseSnapshot: true })]);

    // A version built from the base template, with the starter template copied in.
    const version: any = await expectContract(
      'createVersion',
      await t.call('POST', '/v1/versions', {
        body: { name: 'v2.0.0', phpVersion: '8.3', wordPressVersion: '6.8', snapshotId: base.id, snapshotIdsToCopy: [starter.id] },
      }),
    );
    await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${version.id}`)).json()) as any[])[0]?.statusCode === Status.Done);
    await t.call('PUT', '/v1/versions/production', { body: { versionId: version.id } });
    const groups: any = await expectContract('listSnapshots', await t.call('GET', '/v1/snapshots?onlyProductionVersion=true&groupName=peptide-starter'));
    expect(groups).toEqual([expect.objectContaining({ versionId: version.id, name: 'Peptide Starter', groupName: 'peptide-starter', isTenantSnapshot: true })]);

    const store = (await (await t.call('POST', '/v1/tenants', { body: { name: 'From Template', groupName: 'peptide-starter' } })).json()) as any;
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${store.externalId}`)).json()) as any[])[0]?.statusCode === Status.Done);
    const [built]: any = await (await t.call('GET', `/v1/tenants?externalId=${store.externalId}`)).json();
    expect(built).toMatchObject({ versionId: version.id, basedOnSnapshotId: groups[0].id, snapshotGroupName: 'peptide-starter' });

    // Deleting a template leaves the version's copy alone.
    expect(await expectContract('deleteBaseSnapshot', await t.call('DELETE', `/v1/basesnapshots?id=${starter.id}`))).toEqual({ baseSnapshotId: starter.id });
    expect(await (await t.call('GET', `/v1/basesnapshots?baseSnapshotId=${starter.id}`)).json()).toEqual([]);
    expect(await (await t.call('GET', '/v1/snapshots?groupName=peptide-starter')).json()).toHaveLength(1);
  });

  it('400 responses carry an ExceptionResult', async () => {
    // A live tenant, so the domain cases fail on their own input and not on an unknown tenant.
    const live = (await (await t.call('POST', '/v1/tenants', { body: { name: 'Error Cases' } })).json()) as { externalId: string };
    tenant = { ...tenant, externalId: live.externalId };
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
      ['addDomainDeprecated', t.call('POST', '/v1/tenants/domain?externalId=nobody', { body: { domainName: 'a.example.com' } })],
      ['listTenantDomains', t.call('GET', '/v1/tenants/domains')],
      ['addTenantDomain', t.call('POST', `/v1/tenants/domains?externalId=${tenant.externalId}`, { body: { domainName: 'not a domain' } })],
      ['removeTenantDomain', t.call('DELETE', `/v1/tenants/domains?externalId=${tenant.externalId}`)],
      ['setMainDomain', t.call('PUT', `/v1/tenants/domains/main?externalId=${tenant.externalId}`, { body: { domainName: 'elsewhere.example.com' } })],
      ['checkDomainAvailability', t.call('GET', '/v1/tenants/domains/available?domain=https://shop.example.com')],
      ['suspendTenant', t.call('POST', '/v1/tenants/suspend?externalId=store-9999', { body: { takeBackup: true } })],
      ['resumeTenant', t.call('POST', '/v1/tenants/resume?externalId=store-9999')],
      ['listTenantBackups', t.call('GET', '/v1/tenants/backups')],
      ['createTenantBackup', t.call('POST', '/v1/tenants/backups?externalId=store-9999')],
      ['restoreTenant', t.call('POST', `/v1/tenants/restore?externalId=${tenant.externalId}`, { body: { backupId: null } })],
      ['createBaseSnapshotTemplateUpload', t.call('POST', '/v1/basesnapshots', { body: { name: 'abc', comment: 'too short a name' } })],
      ['deleteBaseSnapshot', t.call('DELETE', `/v1/basesnapshots?id=${crypto.randomUUID()}`)],
    ];
    for (const [operationId, res] of cases) {
      const r = await res;
      expect(r.status, operationId).toBe(400);
      expect(await expectContract(operationId, r)).toMatchObject({ statusCode: 400 });
    }
  });

  it('every implemented operation answers 403 to bad credentials', async () => {
    for (const op of operations.filter((o) => implemented.includes(o.operationId) || earlyPhase2.includes(o.operationId))) {
      const res = await t.call(op.method.toUpperCase(), op.path, { auth: 'Basic ' + Buffer.from('nobody:nothing').toString('base64') });
      expect(res.status, op.operationId).toBe(403);
      await expectContract(op.operationId, res);
    }
  });

  it('checked a 200 for every implemented operation', () => {
    for (const id of [...implemented, ...earlyPhase2]) expect(checked.has(`${id} 200`), id).toBe(true);
  });
});

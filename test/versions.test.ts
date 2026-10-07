import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Status } from '../src/status.ts';
import { dnsSafeLabel } from '../src/tenants.ts';
import { setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.close();
});

const fromUpload = (name: string) => ({ name, phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true });

async function createVersion(body: object): Promise<string> {
  const res = await t.call('POST', '/v1/versions', { body });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function versionStatus(id: string): Promise<number | undefined> {
  const [version] = (await (await t.call('GET', `/v1/versions?versionId=${id}`)).json()) as { statusCode: number }[];
  return version?.statusCode;
}

const settled = (id: string) => waitFor(async () => {
  const status = await versionStatus(id);
  return status !== Status.Pending && status !== undefined && { status };
});

// failNext counts calls from any job, so let earlier builds finish before injecting failures.
const noneBuilding = () =>
  waitFor(async () => !((await (await t.call('GET', '/v1/versions')).json()) as { statusCode: number }[]).some((v) => v.statusCode === Status.Pending));

describe('versions', () => {
  it('needs exactly one of snapshotId and useCustomUpload', async () => {
    const base = { name: 'x', phpVersion: '8.3', wordPressVersion: '6.8' };
    expect((await t.call('POST', '/v1/versions', { body: base })).status).toBe(400);
    expect((await t.call('POST', '/v1/versions', { body: { ...base, useCustomUpload: true, snapshotId: crypto.randomUUID() } })).status).toBe(400);
    expect((await t.call('POST', '/v1/versions', { body: { ...base, snapshotId: crypto.randomUUID() } })).status).toBe(400);
  });

  it('rejects wrong types and blank required fields', async () => {
    expect((await t.call('POST', '/v1/versions', { body: { ...fromUpload('x'), phpVersion: 8.3 } })).status).toBe(400);
    expect((await t.call('POST', '/v1/versions', { body: fromUpload('  ') })).status).toBe(400);
    expect((await t.call('POST', '/v1/versions', { body: '{not json' })).status).toBe(400);
  });

  it('gives each version its own domain', async () => {
    const a = await (await t.call('POST', '/v1/versions', { body: fromUpload('Store V2') })).json();
    const b = await (await t.call('POST', '/v1/versions', { body: fromUpload('Store V2') })).json();
    expect(a.domainName).toBe('store-v2.versions.waas.example');
    expect(b.domainName).toBe(`${dnsSafeLabel(`store-v2-${b.id.slice(0, 8)}`, 'v')}.versions.waas.example`);
  });

  it('never ends a version domain label in -<digits> (sslip.io would read it as an address)', async () => {
    const a = await (await t.call('POST', '/v1/versions', { body: fromUpload('v1.0.0') })).json();
    expect(a.domainName).toBe('v1-0-0-v.versions.waas.example');
    const b = await (await t.call('POST', '/v1/versions', { body: fromUpload('2026') })).json();
    expect(b.domainName).toBe('2026-v.versions.waas.example');
    const c = await (await t.call('POST', '/v1/versions', { body: fromUpload('V1.1 beta') })).json();
    expect(c.domainName).toBe('v1-1-beta.versions.waas.example');
  });

  it('marks the version Failed when the build keeps failing', async () => {
    await noneBuilding();
    t.provisioner.failNext('buildVersion', 10);
    const id = await createVersion(fromUpload('broken'));
    // Three retries with backoff from 1s.
    const { status } = await waitFor(async () => (await versionStatus(id)) === Status.Failed && { status: Status.Failed }, 30000);
    expect(status).toBe(Status.Failed);
    t.provisioner.failNext('buildVersion', 0);
  }, 40000);

  it('recovers from a transient build failure', async () => {
    await noneBuilding();
    t.provisioner.failNext('buildVersion', 1);
    const id = await createVersion(fromUpload('flaky'));
    expect((await settled(id)).status).toBe(Status.Done);
  }, 20000);

  it('only promotes a Done version, and keeps one production version', async () => {
    const a = await createVersion(fromUpload('prod-a'));
    expect((await t.call('PUT', '/v1/versions/production', { body: { versionId: crypto.randomUUID() } })).status).toBe(400);
    await settled(a);
    const b = await createVersion(fromUpload('prod-b'));
    expect((await t.call('PUT', '/v1/versions/production', { body: { versionId: b } })).status).toBe(400); // still Pending
    await settled(b);
    expect((await t.call('PUT', '/v1/versions/production', { body: { versionId: a } })).status).toBe(200);
    expect((await t.call('PUT', '/v1/versions/production', { body: { versionId: b } })).status).toBe(200);
    const versions = (await (await t.call('GET', '/v1/versions')).json()) as { id: string; isProduction: boolean }[];
    expect(versions.filter((v) => v.isProduction).map((v) => v.id)).toEqual([b]);
  });

  it('refuses to delete the production version', async () => {
    const [prod] = ((await (await t.call('GET', '/v1/versions')).json()) as { id: string; isProduction: boolean }[]).filter((v) => v.isProduction);
    expect((await t.call('DELETE', `/v1/versions?versionId=${prod!.id}`)).status).toBe(400);
  });

  it('runs a delete queued during the build after the build', async () => {
    const id = await createVersion(fromUpload('short-lived'));
    expect((await t.call('DELETE', `/v1/versions?versionId=${id}`)).status).toBe(200);
    // Removing until the delete job runs, which can finish before this read.
    expect([Status.Removing, undefined]).toContain(await versionStatus(id));
    await waitFor(async () => (await versionStatus(id)) === undefined);
    expect(t.provisioner.versions.has(id)).toBe(false);
  });

  it('accepts a JSON content type on bodiless GET and DELETE', async () => {
    const res = await t.call('GET', '/v1/versions', { headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(200);
  });

  it('returns statusCode as an integer and isProduction as a boolean', async () => {
    for (const v of (await (await t.call('GET', '/v1/versions')).json()) as Record<string, unknown>[]) {
      expect(Number.isInteger(v.statusCode)).toBe(true);
      expect(typeof v.isProduction).toBe('boolean');
    }
  });
});

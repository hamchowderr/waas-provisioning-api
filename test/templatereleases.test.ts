import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTemplateReleases, nextVersionName, type ReleaseSource } from '../src/templatereleases.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, waitFor, type TestContext } from './helpers.ts';

// A store template release that passed its Playground checks goes live by itself (docs/template-releases.md).

const ZIP = Buffer.from('PK store template');
const sums = (zip: Buffer) => `${createHash('sha256').update(zip).digest('hex')}  anypress-store.zip\n`;

/** GitHub as Octokit answers it: the releases, and each asset's bytes by id. */
function github(releases: { tag: string; files: Record<string, Buffer | string>; draft?: boolean }[]): ReleaseSource {
  const bytes = new Map<number, Buffer>();
  let id = 0;
  const list = releases.map((r) => ({
    tag_name: r.tag,
    draft: r.draft ?? false,
    prerelease: false,
    assets: Object.entries(r.files).map(([name, data]) => {
      bytes.set(++id, Buffer.from(data));
      return { id, name };
    }),
  }));
  const octokit = {
    rest: {
      repos: {
        listReleases: async () => ({ data: list }),
        getReleaseAsset: async ({ asset_id }: { asset_id: number }) => ({ data: bytes.get(asset_id)!.buffer.slice(bytes.get(asset_id)!.byteOffset, bytes.get(asset_id)!.byteOffset + bytes.get(asset_id)!.length) }),
      },
    },
  };
  return { octokit: octokit as unknown as ReleaseSource['octokit'], owner: 'hamchowderr', repo: 'waas-provisioning-api' };
}

let t: TestContext;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.close();
});

describe('template releases', () => {
  it('names the next version after the highest vX.Y.Z', () => {
    expect(nextVersionName(['v1.1.9', 'v1.1.29', 'v1.0.40', 'Custom'])).toBe('v1.1.30');
    expect(nextVersionName([])).toBe('v1.0.0');
  });

  it('publishes only a checked release, builds it, then makes it production and moves the stores', async () => {
    // A store on the product's first production version.
    const first = await (await t.call('POST', '/v1/versions', { body: { name: 'v1.1.29', wordPressVersion: '7.1', phpVersion: '8.3', useCustomUpload: true } })).json();
    await waitFor(async () => (await t.pool.query('SELECT status FROM versions WHERE id = $1', [first.id])).rows[0]?.status === Status.Done);
    await t.call('PUT', '/v1/versions/production', { body: { versionId: first.id } });
    const store = await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Shop' } })).json();
    await waitFor(async () => (await t.pool.query('SELECT status FROM tenants WHERE id = $1', [store.id])).rows[0]?.status === Status.Done);

    // Releases without checks.txt (made by hand) are never published.
    const unchecked = github([{ tag: 'templates-v1.1.16', files: { 'anypress-store.zip': ZIP, SHA256SUMS: sums(ZIP) } }]);
    expect(await checkTemplateReleases(t.deps, t.productId, unchecked)).toBeNull();

    const source = github([
      { tag: 'templates-v1.1.31', files: { 'anypress-store.zip': ZIP, SHA256SUMS: sums(ZIP), 'checks.txt': 'ok' }, draft: true },
      { tag: 'templates-v1.1.30', files: { 'anypress-store.zip': ZIP, SHA256SUMS: sums(ZIP), 'checks.txt': 'website ok' } },
    ]);
    expect(await checkTemplateReleases(t.deps, t.productId, source)).toMatch(/templates-v1\.1\.30: building v1\.1\.30/);
    const { rows } = await t.pool.query('SELECT version_id, status FROM template_releases WHERE tag = $1', ['templates-v1.1.30']);
    expect(rows[0].status).toBe(Status.Pending);
    // Seen once: not published twice.
    expect(await checkTemplateReleases(t.deps, t.productId, source)).toBeNull();

    await waitFor(async () => (await t.pool.query('SELECT status FROM versions WHERE id = $1', [rows[0].version_id])).rows[0]?.status === Status.Done);
    expect(await checkTemplateReleases(t.deps, t.productId, source)).toMatch(/v1\.1\.30 is production/);
    expect((await t.pool.query('SELECT is_production FROM versions WHERE id = $1', [rows[0].version_id])).rows[0].is_production).toBe(true);
    await waitFor(async () => (await t.pool.query('SELECT version_id FROM tenants WHERE id = $1', [store.id])).rows[0]?.version_id === rows[0].version_id);
    expect((await t.pool.query('SELECT status FROM template_releases WHERE tag = $1', ['templates-v1.1.30'])).rows[0].status).toBe(Status.Done);
  });

  it('refuses a zip that does not match its checksum', async () => {
    const source = github([{ tag: 'templates-v1.1.32', files: { 'anypress-store.zip': ZIP, SHA256SUMS: sums(Buffer.from('other')), 'checks.txt': 'ok' } }]);
    expect(await checkTemplateReleases(t.deps, t.productId, source)).toMatch(/does not match SHA256SUMS/);
    expect((await t.pool.query('SELECT status FROM template_releases WHERE tag = $1', ['templates-v1.1.32'])).rows[0].status).toBe(Status.Failed);
  });
});

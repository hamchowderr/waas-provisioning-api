import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import type { Deps } from './app.ts';
import { ensureQueue } from './queue.ts';
import { baseSnapshotService } from './routes/basesnapshots.ts';
import { versionService } from './routes/versions.ts';
import { Status } from './status.ts';

/**
 * New store templates go live by themselves (docs/template-releases.md). The Release templates workflow builds the
 * store template, checks every site type on WordPress Playground and only then publishes a templates-v* release on
 * GitHub, with a checks.txt of what passed. Every 15 minutes the API looks for a newer one, publishes its
 * anypress-store.zip as a new version of the store template product (STORE_TEMPLATE_PRODUCT_ID), and once that
 * version is built makes it production: the product's stores move to it (a failed move puts a store back) and the
 * storefronts that follow it get a copy. The production version before stays as the way back.
 */

const QUEUE = 'template-releases';
const TAG = /^templates-v\d+\.\d+\.\d+$/;
const FILES = ['anypress-store.zip', 'SHA256SUMS', 'checks.txt'] as const;

/** The GitHub repository the releases are on, from its official SDK. */
export interface ReleaseSource {
  octokit: Octokit;
  owner: string;
  repo: string;
}

const defaultReleaseSource = (): ReleaseSource => ({ octokit: new Octokit({ userAgent: 'anypress-api' }), owner: 'hamchowderr', repo: 'waas-provisioning-api' });

type Release = { tag: string; assets: Map<string, number>; checks?: string };

/** The newest release that went through the Playground checks (it carries checks.txt), or null. */
async function newestCheckedRelease({ octokit, owner, repo }: ReleaseSource): Promise<Release | null> {
  const { data } = await octokit.rest.repos.listReleases({ owner, repo, per_page: 30 });
  for (const r of data) {
    if (r.draft || r.prerelease || !TAG.test(r.tag_name)) continue;
    const assets = new Map(r.assets.map((a) => [a.name, a.id]));
    if (FILES.every((f) => assets.has(f))) return { tag: r.tag_name, assets };
  }
  return null;
}

async function download({ octokit, owner, repo }: ReleaseSource, assetId: number): Promise<Buffer> {
  const { data } = await octokit.rest.repos.getReleaseAsset({ owner, repo, asset_id: assetId, headers: { accept: 'application/octet-stream' } });
  return Buffer.from(data as unknown as ArrayBuffer);
}

/** The next version name after the product's highest vX.Y.Z (v1.1.29 -> v1.1.30); v1.0.0 for the first. */
export function nextVersionName(names: string[]): string {
  let best = [1, 0, -1];
  for (const name of names) {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name);
    if (!m) continue;
    const v = m.slice(1).map(Number);
    if (v[0]! > best[0]! || (v[0] === best[0] && (v[1]! > best[1]! || (v[1] === best[1] && v[2]! > best[2]!)))) best = v;
  }
  return `v${best[0]}.${best[1]}.${best[2]! + 1}`;
}

/**
 * One pass: moves a published release whose version has finished building to production, or publishes the newest
 * checked release not seen before. Answers what it did, for the log.
 */
export async function checkTemplateReleases(deps: Deps, productId: string, source: ReleaseSource): Promise<string | null> {
  const { pool, provisioner } = deps;
  const versions = versionService(deps);

  const { rows: pending } = await pool.query<{ tag: string; version_id: string | null; version_name: string; status: number | null }>(
    `SELECT r.tag, r.version_id, r.version_name, v.status FROM template_releases r LEFT JOIN versions v ON v.id = r.version_id
      WHERE r.status = $1 ORDER BY r.date_created LIMIT 1`,
    [Status.Pending],
  );
  const waiting = pending[0];
  if (waiting) {
    const finish = (status: number, error: string | null) =>
      pool.query('UPDATE template_releases SET status = $2, error = $3, date_changed = now() WHERE tag = $1', [waiting.tag, status, error]);
    if (waiting.status === Status.Pending) return null;
    if (waiting.status !== Status.Done || !waiting.version_id) {
      await finish(Status.Failed, `Version ${waiting.version_name} did not build`);
      return `${waiting.tag}: version ${waiting.version_name} did not build; production stays as it was`;
    }
    await versions.setProduction(productId, waiting.version_id);
    await finish(Status.Done, null);
    return `${waiting.tag}: ${waiting.version_name} is production; its stores are moving`;
  }

  const release = await newestCheckedRelease(source);
  if (!release) return null;
  if ((await pool.query('SELECT 1 FROM template_releases WHERE tag = $1', [release.tag])).rowCount) return null;

  const zip = await download(source, release.assets.get('anypress-store.zip')!);
  const sums = (await download(source, release.assets.get('SHA256SUMS')!)).toString('utf8');
  const listed = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, file]) => file?.replace(/^\*/, '') === 'anypress-store.zip')?.[0];
  const sha = createHash('sha256').update(zip).digest('hex');
  if (listed !== sha) {
    await pool.query('INSERT INTO template_releases (tag, product_id, status, error) VALUES ($1, $2, $3, $4)', [
      release.tag,
      productId,
      Status.Failed,
      'anypress-store.zip does not match SHA256SUMS',
    ]);
    return `${release.tag}: anypress-store.zip does not match SHA256SUMS; not published`;
  }

  const { rows: names } = await pool.query<{ name: string }>('SELECT name FROM versions WHERE product_id = $1', [productId]);
  const name = nextVersionName(names.map((r) => r.name));
  const base = await baseSnapshotService(deps).create(productId, { name: `AnyPress store ${name.replaceAll('.', '-')}`, comment: `${name} from ${release.tag}` });
  await provisioner.putBaseSnapshot({ baseSnapshotId: base.id, body: new Uint8Array(zip) });
  const version = await versions.create(productId, { name, wordPressVersion: '7.1', phpVersion: '8.3', snapshotId: base.id });
  await pool.query('INSERT INTO template_releases (tag, product_id, version_id, version_name, status) VALUES ($1, $2, $3, $4, $5)', [
    release.tag,
    productId,
    version.id,
    name,
    Status.Pending,
  ]);
  return `${release.tag}: building ${name}; it becomes production once built`;
}

/** Checks every 15 minutes, when STORE_TEMPLATE_PRODUCT_ID is set. */
export async function startTemplateReleases(deps: Deps, source: ReleaseSource = defaultReleaseSource()): Promise<void> {
  const { boss, config } = deps;
  const productId = config.storeTemplateProductId;
  if (!productId) {
    if (await boss.getQueue(QUEUE)) await boss.unschedule(QUEUE);
    return;
  }
  await ensureQueue(boss, QUEUE, { retryLimit: 0, expireInSeconds: 900 });
  await boss.schedule(QUEUE, '*/15 * * * *');
  await boss.work(QUEUE, { pollingIntervalSeconds: 60 }, async () => {
    const done = await checkTemplateReleases(deps, productId, source);
    if (done) console.log(`Template releases: ${done}`);
  });
}

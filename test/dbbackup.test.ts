// Off-site backups of the API's database (src/dbbackup.ts): keys, retention, encryption, the job
// against an in-memory bucket, the S3 calls it adds, and a real pg_dump -> restore round trip.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backupCipherKey,
  backupKey,
  type BackupStore,
  DbBackups,
  decryptBackup,
  encryptBackup,
  latestBackupKey,
  loadDbBackupConfig,
  parseBackupKey,
  pgDump,
  selectExpired,
  startDbBackups,
} from '../src/dbbackup.ts';
import { S3 } from '../src/provisioner/s3.ts';
import { Status } from '../src/status.ts';
import { setup, TEST_DATABASE_URL, TEST_SECRETS_KEY, waitFor, type TestContext } from './helpers.ts';

class MemoryStore implements BackupStore {
  objects = new Map<string, Uint8Array>();
  failPut = false;
  async put(key: string, body: Uint8Array) {
    if (this.failPut) throw new Error('S3 PUT failed: HTTP 503');
    this.objects.set(key, body);
  }
  async list(prefix: string) {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length }));
  }
  async get(key: string) {
    const v = this.objects.get(key);
    if (!v) throw new Error('S3 GET failed: HTTP 404');
    return v;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

const cipherKey = backupCipherKey(TEST_SECRETS_KEY);
const day = (n: number, hour = 2) => new Date(Date.UTC(2026, 0, 1 + n, hour, 30));

describe('keys and config', () => {
  it('names backups by date under the prefix and reads the date back', () => {
    const at = new Date('2026-10-07T02:30:05.123Z');
    const key = backupKey('db-backups', at);
    expect(key).toBe('db-backups/2026/10/07/waas-20261007T023005Z.dump.enc');
    expect(parseBackupKey('db-backups', key)).toEqual(new Date('2026-10-07T02:30:05Z'));
    expect(parseBackupKey('db-backups', 'db-backups/notes.txt')).toBeNull();
    expect(parseBackupKey('other', key)).toBeNull();
  });

  it('is on only when every S3 setting is there, and DB_BACKUP=off turns it off', () => {
    const s3 = { S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' };
    expect(loadDbBackupConfig(s3)).toMatchObject({ prefix: 'db-backups', schedule: '30 2 * * *', keepDaily: 14, keepWeekly: 8, s3: { region: 'auto' } });
    expect(loadDbBackupConfig({ ...s3, DB_BACKUP_PREFIX: '/x/y/' })?.prefix).toBe('x/y');
    expect(loadDbBackupConfig({ ...s3, S3_BUCKET: '' })).toBeUndefined();
    expect(loadDbBackupConfig({ ...s3, DB_BACKUP: 'off' })).toBeUndefined();
  });
});

describe('retention', () => {
  it('keeps the newest of each of the last 14 days and 8 weeks', () => {
    // Two backups a day for 120 days.
    const backups = Array.from({ length: 120 }, (_, i) => [day(i), day(i, 14)]).flat().map((at) => ({ key: backupKey('p', at), at }));
    const expired = new Set(selectExpired(backups, 14, 8));
    const kept = backups.filter((b) => !expired.has(b.key));
    const latest = day(119, 14);
    // 14 daily (the afternoon backup of days 106..119) ...
    for (let i = 106; i <= 119; i++) expect(kept.some((b) => b.at.getTime() === day(i, 14).getTime())).toBe(true);
    expect(kept.some((b) => b.at.getTime() === day(119).getTime())).toBe(false);
    // ... plus the newest of each older week, 8 weeks in all (some overlap the dailies).
    const weeks = new Set(kept.map((b) => b.at.toISOString().slice(0, 10)).filter((d) => d < day(106).toISOString().slice(0, 10)));
    expect(kept.length).toBe(14 + weeks.size);
    expect(kept.length).toBeLessThanOrEqual(22);
    expect(Math.min(...kept.map((b) => b.at.getTime()))).toBeGreaterThan(latest.getTime() - 8 * 7 * 86400_000);
    expect(selectExpired(backups.slice(0, 3), 14, 8)).toEqual(['p/2026/01/01/waas-20260101T023000Z.dump.enc']);
  });
});

describe('encryption', () => {
  it('round-trips, and rejects tampering, another key and other files', () => {
    const plain = Buffer.from('PGDMP example archive');
    const sealed = encryptBackup(cipherKey, plain);
    expect(sealed.includes(plain)).toBe(false);
    expect(decryptBackup(cipherKey, sealed)).toEqual(plain);
    const flipped = Buffer.from(sealed);
    flipped[30] = flipped[30]! ^ 1;
    expect(() => decryptBackup(cipherKey, flipped)).toThrow();
    expect(() => decryptBackup(backupCipherKey(Buffer.alloc(32, 9).toString('base64')), sealed)).toThrow();
    expect(() => decryptBackup(cipherKey, plain)).toThrow(/Not a WaaS database backup/);
    // Derived from SECRETS_KEY, but not equal to it.
    expect(cipherKey.equals(Buffer.from(TEST_SECRETS_KEY, 'base64'))).toBe(false);
  });
});

describe('S3 put and list', () => {
  it('signs a PUT with the body hash and pages through ListObjectsV2', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const pages = [
      '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t/1+=</NextContinuationToken><Contents><Key>db-backups/a&amp;b</Key><Size>10</Size></Contents></ListBucketResult>',
      '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>db-backups/c</Key><Size>20</Size></Contents></ListBucketResult>',
    ];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return init.method === 'GET' ? new Response(pages.shift()) : new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const s3 = new S3({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'waas-stores', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'not-a-secret' }, fetchMock);

    await s3.put('db-backups/2026/x.dump.enc', Buffer.from('hello'));
    const put = calls[0]!;
    const headers = put.init.headers as Record<string, string>;
    expect(put.url).toBe('https://acct.r2.cloudflarestorage.com/waas-stores/db-backups/2026/x.dump.enc');
    expect(headers['x-amz-content-sha256']).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(JSON.stringify(put.init)).not.toContain('not-a-secret');

    expect(await s3.list('db-backups/')).toEqual([
      { key: 'db-backups/a&b', size: 10 },
      { key: 'db-backups/c', size: 20 },
    ]);
    expect(calls[1]!.url).toBe('https://acct.r2.cloudflarestorage.com/waas-stores?list-type=2&prefix=db-backups%2F');
    expect(calls[2]!.url).toBe('https://acct.r2.cloudflarestorage.com/waas-stores?continuation-token=t%2F1%2B%3D&list-type=2&prefix=db-backups%2F');
  });
});

describe('the backup job', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setup();
  });
  afterAll(async () => t.close());

  it('uploads an encrypted dump, records it, prunes old ones and records failures', async () => {
    const store = new MemoryStore();
    let now = day(0);
    const backups = new DbBackups(t.pool, store, cipherKey, { prefix: 'db-backups', keepDaily: 2, keepWeekly: 1 }, async () => Buffer.from(`dump at ${now.toISOString()}`), () => now);
    // Something that isn't ours under the prefix is left alone.
    store.objects.set('db-backups/README', Buffer.from('x'));
    // A run that died mid-way (or the row a restored dump carries) is closed as interrupted.
    await t.pool.query("INSERT INTO db_backups (status, started_at) VALUES ('running', now() - interval '3 hours')");

    const first = await backups.run();
    expect(first.key).toBe('db-backups/2026/01/01/waas-20260101T023000Z.dump.enc');
    expect(decryptBackup(cipherKey, store.objects.get(first.key)!).toString()).toBe('dump at 2026-01-01T02:30:00.000Z');
    expect(first.sizeBytes).toBe(store.objects.get(first.key)!.length);

    for (const n of [1, 2]) {
      now = day(n);
      await backups.run();
    }
    // Days 2 and 1 are the two dailies; day 2 is also this week's weekly. Day 0 goes.
    expect([...store.objects.keys()].sort()).toEqual(['db-backups/2026/01/02/waas-20260102T023000Z.dump.enc', 'db-backups/2026/01/03/waas-20260103T023000Z.dump.enc', 'db-backups/README']);
    expect(await latestBackupKey(store, 'db-backups')).toBe('db-backups/2026/01/03/waas-20260103T023000Z.dump.enc');

    store.failPut = true;
    now = day(3);
    await expect(backups.run()).rejects.toThrow(/HTTP 503/);
    const { rows: all } = await t.pool.query('SELECT status, object_key, size_bytes, error_message, pruned_at FROM db_backups ORDER BY started_at');
    expect(all[0]).toMatchObject({ status: 'failed', error_message: 'interrupted' });
    const rows = all.slice(1);
    expect(rows.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'failed']);
    expect(rows[0].pruned_at).not.toBeNull();
    expect(rows[1].pruned_at).toBeNull();
    expect(rows[3]).toMatchObject({ object_key: null, error_message: 'S3 PUT failed: HTTP 503' });
  });

  it('takes a catch-up backup on start when none succeeded in the last 26 hours', async () => {
    await t.pool.query('DELETE FROM db_backups');
    const store = new MemoryStore();
    const backups = new DbBackups(t.pool, store, cipherKey, { prefix: 'catch-up', keepDaily: 14, keepWeekly: 8 }, async () => Buffer.from('dump'));
    expect(await backups.isDue()).toBe(true);
    await startDbBackups(t.boss, backups, '0 0 1 1 *', 0.5);
    await waitFor(async () => store.objects.size === 1);
    expect(await backups.isDue()).toBe(false);
    await t.pool.query("UPDATE db_backups SET finished_at = now() - interval '27 hours'");
    expect(await backups.isDue()).toBe(true);
  });

  // The restore runbook (docs/db-backups.md), end to end: dump -> encrypt -> upload -> download ->
  // decrypt -> pg_restore into a scratch database -> same row counts.
  const hasPgTools = spawnSync('pg_restore', ['--version']).status === 0 && spawnSync('pg_dump', ['--version']).status === 0;
  it.skipIf(!hasPgTools)('restores a real dump into a scratch database with the same rows', async () => {
    const { id: versionId } = (await (await t.call('POST', '/v1/versions', { body: { name: 'backup-me', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } })).json()) as { id: string };
    await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
    await t.call('PUT', '/v1/versions/production', { body: { versionId } });
    const { externalId } = (await (await t.call('POST', '/v1/tenants', { body: { name: 'Backup Shop' } })).json()) as { externalId: string };
    // Let the queue settle, so the job table doesn't change between the dump and the counts.
    await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
    const store = new MemoryStore();
    const { key } = await new DbBackups(t.pool, store, cipherKey, { prefix: 'db-backups', keepDaily: 14, keepWeekly: 8 }, () => pgDump(TEST_DATABASE_URL)).run();

    const dir = mkdtempSync(join(tmpdir(), 'waas-restore-'));
    const scratch = new URL(TEST_DATABASE_URL);
    scratch.pathname = `/waas_restore_${process.pid}`;
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${scratch.pathname.slice(1)}`);
      await admin.query(`CREATE DATABASE ${scratch.pathname.slice(1)}`);
      const file = join(dir, 'waas.dump');
      writeFileSync(file, decryptBackup(cipherKey, await store.get(key)));
      const password = decodeURIComponent(scratch.password);
      scratch.password = '';
      execFileSync('pg_restore', ['--no-owner', '--exit-on-error', `--dbname=${scratch}`, file], { env: { ...process.env, PGPASSWORD: password }, stdio: 'pipe' });
      scratch.password = encodeURIComponent(password);

      const restored = new pg.Client({ connectionString: scratch.toString() });
      await restored.connect();
      try {
        const count = async (c: pg.Client | pg.Pool, table: string) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
        for (const table of ['products', 'api_keys', 'versions', 'tenants', 'tenant_domains', 'pgmigrations', 'pgboss.job']) {
          const n = await count(t.pool, table);
          expect(await count(restored, table), table).toBe(n);
        }
        expect(await count(restored, 'tenants')).toBeGreaterThan(0);
      } finally {
        await restored.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${scratch.pathname.slice(1)}`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import type { Pool } from './db.ts';
import type { S3Config } from './provisioner/s3.ts';

/**
 * Off-site backups of this API's own database (tenants, versions, keys, jobs): a daily pg_dump
 * (custom format, compressed), encrypted with AES-256-GCM, uploaded to the S3 bucket under
 * `<prefix>/YYYY/MM/DD/`. Retention keeps the newest backup of each of the last `keepDaily` days
 * and of each of the last `keepWeekly` ISO weeks. Restore runbook: docs/db-backups.md.
 */
export interface DbBackupConfig {
  s3: S3Config;
  /** Key prefix in the bucket, without slashes at either end. */
  prefix: string;
  /** pg-boss cron (UTC). */
  schedule: string;
  keepDaily: number;
  keepWeekly: number;
}

/** What the backups need from object storage; `S3` provides it. */
export interface BackupStore {
  put(key: string, body: Uint8Array): Promise<void>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export const DB_BACKUP_QUEUE = 'db-backup';

/** Backups are on when the bucket settings are all there, unless DB_BACKUP=off. */
export function loadDbBackupConfig(env: NodeJS.ProcessEnv): DbBackupConfig | undefined {
  if (env.DB_BACKUP === 'off') return undefined;
  const { S3_ENDPOINT: endpoint, S3_BUCKET: bucket, S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  return {
    s3: { endpoint, bucket, region: env.S3_REGION ?? 'auto', accessKeyId, secretAccessKey },
    prefix: (env.DB_BACKUP_PREFIX ?? 'db-backups').replace(/^\/+|\/+$/g, ''),
    schedule: env.DB_BACKUP_SCHEDULE ?? '30 2 * * *',
    keepDaily: Number(env.DB_BACKUP_KEEP_DAILY ?? 14),
    keepWeekly: Number(env.DB_BACKUP_KEEP_WEEKLY ?? 8),
  };
}

// --- Object keys ---------------------------------------------------------------------------

const KEY_PATTERN = /\/(\d{4})\/(\d{2})\/(\d{2})\/waas-(\d{8})T(\d{6})Z\.dump\.enc$/;

/** `<prefix>/2026/10/07/waas-20261007T023000Z.dump.enc` */
export function backupKey(prefix: string, at: Date): string {
  const iso = at.toISOString();
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `${prefix}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/waas-${stamp}.dump.enc`;
}

/** When a backup was taken, from its key; null for keys this code didn't write. */
export function parseBackupKey(prefix: string, key: string): Date | null {
  if (!key.startsWith(`${prefix}/`)) return null;
  const m = KEY_PATTERN.exec(key);
  if (!m) return null;
  const [, , , , d, t] = m;
  const at = new Date(`${d!.slice(0, 4)}-${d!.slice(4, 6)}-${d!.slice(6, 8)}T${t!.slice(0, 2)}:${t!.slice(2, 4)}:${t!.slice(4, 6)}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Monday of the ISO week, as YYYY-MM-DD (UTC). */
function isoWeek(at: Date): string {
  const monday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/**
 * The backups retention removes: everything except the newest backup of each of the `keepDaily`
 * most recent days and of each of the `keepWeekly` most recent ISO weeks that have one.
 */
export function selectExpired(backups: { key: string; at: Date }[], keepDaily: number, keepWeekly: number): string[] {
  const days = new Set<string>();
  const weeks = new Set<string>();
  const expired: string[] = [];
  for (const b of [...backups].sort((x, y) => y.at.getTime() - x.at.getTime())) {
    const day = b.at.toISOString().slice(0, 10);
    const week = isoWeek(b.at);
    let keep = false;
    if (!days.has(day) && days.size < keepDaily) days.add(day), (keep = true);
    if (!weeks.has(week) && weeks.size < keepWeekly) weeks.add(week), (keep = true);
    if (!keep) expired.push(b.key);
  }
  return expired;
}

// --- Encryption ----------------------------------------------------------------------------

const MAGIC = Buffer.from('WAASDB1\0');

/**
 * The backup key is derived from SECRETS_KEY (HKDF-SHA256), so there is one key to keep safe:
 * a restored database needs SECRETS_KEY anyway to read the secrets stored in it.
 */
export function backupCipherKey(secretsKeyBase64: string): Buffer {
  const secretsKey = Buffer.from(secretsKeyBase64, 'base64');
  if (secretsKey.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded');
  return Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), 'waas-db-backup-v1', 32));
}

/** Format: "WAASDB1\0" | 12-byte IV | ciphertext | 16-byte GCM tag. The magic is authenticated too. */
export function encryptBackup(key: Buffer, plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  return Buffer.concat([MAGIC, iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function decryptBackup(key: Buffer, data: Uint8Array): Buffer {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < MAGIC.length + 28 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a WaaS database backup');
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(MAGIC.length + 12, buf.length - 16)), decipher.final()]);
}

// --- pg_dump -------------------------------------------------------------------------------

/**
 * Runs pg_dump against `databaseUrl` and returns the archive (custom format, compression 6). The
 * password goes in PGPASSWORD, not on the command line, and never into errors or logs.
 */
export function pgDump(databaseUrl: string, timeoutMs = 30 * 60_000): Promise<Buffer> {
  const url = new URL(databaseUrl);
  const password = decodeURIComponent(url.password);
  url.password = '';
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['--format=custom', '--compress=6', `--dbname=${url.toString()}`], {
      env: { ...process.env, PGPASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (err = (err + chunk.toString()).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`pg_dump failed (${signal ?? `exit ${code}`}): ${err.trim()}`));
    });
  });
}

// --- The job -------------------------------------------------------------------------------

export class DbBackups {
  constructor(
    private readonly pool: Pool,
    private readonly store: BackupStore,
    private readonly cipherKey: Buffer,
    private readonly config: Pick<DbBackupConfig, 'prefix' | 'keepDaily' | 'keepWeekly'>,
    private readonly dump: () => Promise<Uint8Array>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Dump, encrypt, upload, record, then prune. A failure is recorded and rethrown. */
  async run(): Promise<{ key: string; sizeBytes: number }> {
    // A run that died (process restart), or the row a restored dump carries, stays 'running'.
    await this.pool.query(
      "UPDATE db_backups SET status = 'failed', finished_at = now(), error_message = 'interrupted' WHERE status = 'running' AND started_at < now() - interval '2 hours'",
    );
    const { rows } = await this.pool.query<{ id: string }>("INSERT INTO db_backups (status) VALUES ('running') RETURNING id");
    const id = rows[0]!.id;
    try {
      const key = backupKey(this.config.prefix, this.now());
      const body = encryptBackup(this.cipherKey, await this.dump());
      await this.store.put(key, body);
      await this.pool.query("UPDATE db_backups SET status = 'ok', finished_at = now(), object_key = $2, size_bytes = $3 WHERE id = $1", [
        id,
        key,
        body.length,
      ]);
      try {
        await this.prune();
      } catch (err) {
        // The backup itself is safe; pruning runs again tomorrow.
        console.error(`db backup: pruning failed: ${(err as Error).message}`);
      }
      return { key, sizeBytes: body.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.pool.query("UPDATE db_backups SET status = 'failed', finished_at = now(), error_message = $2 WHERE id = $1", [id, message]);
      throw err;
    }
  }

  /** Deletes the backups retention no longer keeps; returns their keys. */
  async prune(): Promise<string[]> {
    const backups = (await this.store.list(`${this.config.prefix}/`)).flatMap(({ key }) => {
      const at = parseBackupKey(this.config.prefix, key);
      return at ? [{ key, at }] : [];
    });
    const expired = selectExpired(backups, this.config.keepDaily, this.config.keepWeekly);
    for (const key of expired) await this.store.delete(key);
    if (expired.length) await this.pool.query('UPDATE db_backups SET pruned_at = now() WHERE object_key = ANY($1)', [expired]);
    return expired;
  }
}

/** The newest backup's object key, from the bucket (not the database, which may be the thing lost). */
export async function latestBackupKey(store: Pick<BackupStore, 'list'>, prefix: string): Promise<string | null> {
  const backups = (await store.list(`${prefix}/`)).flatMap(({ key }) => {
    const at = parseBackupKey(prefix, key);
    return at ? [{ key, at }] : [];
  });
  backups.sort((a, b) => b.at.getTime() - a.at.getTime());
  return backups[0]?.key ?? null;
}

/** Schedules the daily backup on its own queue and works it; unschedules it when backups are off. */
export async function startDbBackups(boss: PgBoss, backups: DbBackups | undefined, schedule: string): Promise<void> {
  if (!backups) {
    if (await boss.getQueue(DB_BACKUP_QUEUE)) await boss.unschedule(DB_BACKUP_QUEUE);
    return;
  }
  if (!(await boss.getQueue(DB_BACKUP_QUEUE))) await boss.createQueue(DB_BACKUP_QUEUE, { retryLimit: 1, retryDelay: 600, expireInSeconds: 3600 });
  await boss.schedule(DB_BACKUP_QUEUE, schedule);
  await boss.work(DB_BACKUP_QUEUE, { pollingIntervalSeconds: 60 }, async () => {
    const { key, sizeBytes } = await backups.run();
    console.log(`db backup: ${key} (${sizeBytes} bytes)`);
  });
}

// --- Status --------------------------------------------------------------------------------

export interface DbBackupStatus {
  /** off: not configured. none: no backup yet. unknown: the status couldn't be read. */
  status: 'off' | 'none' | 'running' | 'ok' | 'failed' | 'unknown';
  /** When the newest attempt finished (or started, while running). */
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Size of the newest successful backup. */
  sizeBytes: number | null;
  /** True when backups are on and the newest success is more than 26 hours old. */
  stale: boolean;
}

export const STALE_AFTER_MS = 26 * 3600_000;

export async function dbBackupStatus(pool: Pool, enabled: boolean, now = new Date()): Promise<DbBackupStatus> {
  if (!enabled) return { status: 'off', lastAttemptAt: null, lastSuccessAt: null, sizeBytes: null, stale: false };
  const { rows } = await pool.query(
    `SELECT (SELECT row_to_json(a) FROM (SELECT status, coalesce(finished_at, started_at) AS at FROM db_backups ORDER BY started_at DESC LIMIT 1) a) AS last,
            (SELECT row_to_json(s) FROM (SELECT finished_at AS at, size_bytes FROM db_backups WHERE status = 'ok' ORDER BY started_at DESC LIMIT 1) s) AS ok`,
  );
  const last = rows[0].last as { status: 'running' | 'ok' | 'failed'; at: string } | null;
  const ok = rows[0].ok as { at: string; size_bytes: number } | null;
  const lastSuccessAt = ok ? new Date(ok.at).toISOString() : null;
  return {
    status: last?.status ?? 'none',
    lastAttemptAt: last ? new Date(last.at).toISOString() : null,
    lastSuccessAt,
    sizeBytes: ok ? Number(ok.size_bytes) : null,
    stale: lastSuccessAt !== null && now.getTime() - Date.parse(lastSuccessAt) > STALE_AFTER_MS,
  };
}

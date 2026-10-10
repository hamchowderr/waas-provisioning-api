import { loadDbBackupConfig, type DbBackupConfig } from './dbbackup.ts';
import type { CoolifyProvisionerConfig } from './provisioner/coolify/provisioner.ts';
import type { S3Config } from './provisioner/s3.ts';

export interface Config {
  databaseUrl: string;
  port: number;
  /** Parent domain of each store's base domain: t-<id8>.<storesDomain>. */
  storesDomain: string;
  /** Parent domain of each version's domain: <slug>.<versionsDomain>. */
  versionsDomain: string;
  /** 32 random bytes, base64. Encrypts the values stores need back in plain form (src/secrets.ts). */
  secretsKey: string;
  /** Days a deleted tenant's backups are kept. */
  backupRetentionDays: number;
  /** Bearer token for /admin/*. Unset disables the admin API (every request gets 403). */
  adminToken?: string;
  /** Which Provisioner runs store-side work: the in-memory fake (default) or Coolify. */
  provisioner: 'fake' | 'coolify';
  coolify?: CoolifyProvisionerConfig;
  /** The plugin releases bucket (waas-hw4). Unset: update checks get 503. */
  releases?: S3Config;
  /** Off-site backups of this database (src/dbbackup.ts); on when the S3_* settings are set. */
  dbBackup?: DbBackupConfig;
}

function required(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required ${why}`);
  return value;
}

function loadCoolify(env: NodeJS.ProcessEnv): CoolifyProvisionerConfig {
  const why = 'when PROVISIONER=coolify';
  return {
    url: required(env, 'COOLIFY_URL', why),
    token: env.COOLIFY_TOKEN || undefined,
    serverUuid: required(env, 'COOLIFY_SERVER_UUID', why),
    projectUuid: required(env, 'COOLIFY_PROJECT_UUID', why),
    s3: {
      endpoint: required(env, 'S3_ENDPOINT', why),
      bucket: required(env, 'S3_BUCKET', why),
      region: env.S3_REGION ?? 'auto',
      accessKeyId: required(env, 'S3_ACCESS_KEY_ID', why),
      secretAccessKey: required(env, 'S3_SECRET_ACCESS_KEY', why),
    },
  };
}

/**
 * RELEASES_S3_BUCKET turns on plugin updates. The endpoint and keys default to the S3_* ones; the
 * key only needs read access to the releases bucket.
 */
function loadReleases(env: NodeJS.ProcessEnv): S3Config | undefined {
  const bucket = env.RELEASES_S3_BUCKET?.trim();
  if (!bucket) return undefined;
  const why = 'when RELEASES_S3_BUCKET is set';
  // Trimmed: a key pasted with a trailing newline otherwise signs every request wrong (R2 answers 403).
  const pick = (name: string) => env[`RELEASES_${name}`]?.trim() || env[name]?.trim() || undefined;
  const need = (name: string) => {
    const value = pick(name);
    if (!value) throw new Error(`RELEASES_${name} or ${name} is required ${why}`);
    return value;
  };
  return {
    endpoint: need('S3_ENDPOINT'),
    bucket,
    region: pick('S3_REGION') ?? 'auto',
    accessKeyId: need('S3_ACCESS_KEY_ID'),
    secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const secretsKey = env.SECRETS_KEY;
  if (!secretsKey) throw new Error('SECRETS_KEY is required (32 random bytes, base64: openssl rand -base64 32)');
  const provisioner = env.PROVISIONER ?? 'fake';
  if (provisioner !== 'fake' && provisioner !== 'coolify') throw new Error('PROVISIONER must be fake or coolify');
  return {
    databaseUrl,
    port: Number(env.PORT ?? 4111),
    storesDomain: env.STORES_DOMAIN ?? 'stores.waas.example',
    versionsDomain: env.VERSIONS_DOMAIN ?? 'versions.waas.example',
    secretsKey,
    backupRetentionDays: Number(env.BACKUP_RETENTION_DAYS ?? 90),
    adminToken: env.ADMIN_TOKEN || undefined,
    provisioner,
    coolify: provisioner === 'coolify' ? loadCoolify(env) : undefined,
    releases: loadReleases(env),
    dbBackup: loadDbBackupConfig(env),
  };
}

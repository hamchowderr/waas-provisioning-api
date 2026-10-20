import { loadAuthConfig, type AuthConfig } from './auth.ts';
import { loadDbBackupConfig, type DbBackupConfig } from './dbbackup.ts';
import { loadDomainConnectConfig, type DomainConnectConfig } from './domainconnect.ts';
import { isUuid } from './http.ts';
import type { CoolifyProvisionerConfig, StoreMail } from './provisioner/coolify/provisioner.ts';
import type { S3Config } from './provisioner/s3.ts';
import { ToSendAdmin, type SendingDomains, type StoreMailKeys } from './tosend.ts';
import { loadStoreBackupConfig, type StoreBackupConfig } from './storebackups.ts';
import { loadWebhookConfig, type WebhookConfig } from './webhooks.ts';

export interface Config {
  databaseUrl: string;
  port: number;
  /** Parent domain of each store's base domain: t-<id8>.<storesDomain>. */
  storesDomain: string;
  /** Parent domain of each version's domain: <slug>.<versionsDomain>. */
  versionsDomain: string;
  /**
   * The platform's own domain (PLATFORM_DOMAIN, e.g. anypress.io), when stores are named under it
   * (<name>.anypress.io, the storefront plugin's root domain). Its apex and reserved names such as
   * www, api and stores are then never given to a store. Unset: nothing is reserved.
   */
  platformDomain?: string;
  /**
   * The platform's own brand domain (BRAND_DOMAIN, e.g. anypress.io), when stores live on a separate
   * one (PLATFORM_DOMAIN anypress.site). No store may take it or any name under it, since stores
   * under the same registrable domain could set its cookies. Unset: nothing extra is reserved.
   */
  brandDomain?: string;
  /** 32 random bytes, base64. Encrypts the values stores need back in plain form (src/secrets.ts). */
  secretsKey: string;
  /** Days a deleted tenant's backups are kept. */
  backupRetentionDays: number;
  /** Bearer token for /admin/*. Unset disables the admin API (every request gets 403). */
  adminToken?: string;
  /** Which Provisioner runs store-side work: the in-memory fake (default) or Coolify. */
  provisioner: 'fake' | 'coolify';
  coolify?: CoolifyProvisionerConfig;
  /** Stores' own sending domains on toSend (src/maildomains.ts); set with TOSEND_ADMIN_KEY. */
  sendingDomains?: SendingDomains;
  /** Domain Connect links for store owners' DNS (src/domainconnect.ts); on when PLATFORM_DOMAIN or BRAND_DOMAIN is set. */
  domainConnect?: DomainConnectConfig;
  /** The plugin releases bucket (waas-hw4). Unset: update checks get 503. */
  releases?: S3Config;
  /** Off-site backups of this database (src/dbbackup.ts); on when the S3_* settings are set. */
  dbBackup?: DbBackupConfig;
  /** Nightly backups of every live store (src/storebackups.ts); on unless STORE_BACKUP=off. */
  storeBackup?: StoreBackupConfig;
  /**
   * The API's public URL (PUBLIC_URL, e.g. https://api.anypress.io): the OAuth issuer and the MCP
   * server's resource id. Unset: taken from each request's Host and X-Forwarded-Proto.
   */
  publicUrl?: string;
  /** Days the request log (src/requestlog.ts) keeps; 0 turns it off. Default 30. */
  requestLogDays?: number;
  /** Outgoing webhooks (src/webhooks.ts): WEBHOOK_ALLOW_PRIVATE and WEBHOOK_LOG_DAYS. */
  webhooks?: WebhookConfig;
  /** Sign-in for people (src/auth.ts): AUTH_URL and AUTH_SECRET, plus AUTH_GITHUB_* and AUTH_GOOGLE_*. */
  auth?: AuthConfig;
  /**
   * The platform's own product whose production version is the agency storefront template
   * (STOREFRONT_PRODUCT_ID). Ready-made storefronts (src/storefronts.ts) are its stores. Unset: off.
   */
  storefrontProductId?: string;
  /**
   * Who is emailed when someone applies to sell (src/applications.ts): APPLICATION_NOTIFY_EMAILS,
   * comma-separated. Empty: applications only show on the dashboard.
   */
  applicationNotify?: string[];
}

function requestLogDays(value: string | undefined): number {
  if (value === undefined || value === '') return 30;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0) throw new Error('REQUEST_LOG_DAYS must be a whole number of days (0 turns the request log off)');
  return days;
}

function required(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required ${why}`);
  return value;
}

function loadCoolify(env: NodeJS.ProcessEnv): CoolifyProvisionerConfig {
  const why = 'when PROVISIONER=coolify';
  const mail = loadStoreMail(env);
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
    mail,
    mailKeys: loadStoreMailKeys(env, mail),
    brand: env.STORE_BRAND_NAME?.trim()
      ? { name: env.STORE_BRAND_NAME.trim(), url: env.STORE_BRAND_URL?.trim() || undefined }
      : undefined,
  };
}

/**
 * Stores' outgoing email (docs/store-email.md): on when STORE_SMTP_PASSWORD is set. The host, port and
 * user default to toSend's SMTP relay; STORE_MAIL_FROM must be on a domain verified there.
 */
function loadStoreMail(env: NodeJS.ProcessEnv): StoreMail | undefined {
  const pass = env.STORE_SMTP_PASSWORD?.trim();
  if (!pass) return undefined;
  const from = env.STORE_MAIL_FROM?.trim();
  if (!from || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) throw new Error('STORE_MAIL_FROM (an address on the verified sending domain) is required when STORE_SMTP_PASSWORD is set');
  const port = Number(env.STORE_SMTP_PORT?.trim() || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('STORE_SMTP_PORT must be a port number');
  return { host: env.STORE_SMTP_HOST?.trim() || 'smtp.tosend.com', port, user: env.STORE_SMTP_USER?.trim() || 'tosend', pass, from };
}

/**
 * TOSEND_ADMIN_KEY (an admin key, `tsend_admin_…`) gives each store its own toSend sending key,
 * restricted to STORE_MAIL_FROM's domain, in place of the shared STORE_SMTP_PASSWORD.
 */
function loadStoreMailKeys(env: NodeJS.ProcessEnv, mail: StoreMail | undefined): StoreMailKeys | undefined {
  const adminKey = env.TOSEND_ADMIN_KEY?.trim();
  if (!adminKey) return undefined;
  if (!mail) throw new Error('TOSEND_ADMIN_KEY needs STORE_SMTP_PASSWORD and STORE_MAIL_FROM too');
  if (!adminKey.startsWith('tsend_admin_')) throw new Error('TOSEND_ADMIN_KEY must be a toSend admin key (tsend_admin_…), not a sending key');
  const domain = mail.from.split('@')[1]!.toLowerCase();
  return new ToSendAdmin(adminKey, domain, env.TOSEND_API_URL?.trim() || undefined);
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
    // The releases key is scoped to this one bucket, and R2 refuses such keys on path-style requests.
    virtualHost: true,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const secretsKey = env.SECRETS_KEY;
  if (!secretsKey) throw new Error('SECRETS_KEY is required (32 random bytes, base64: openssl rand -base64 32)');
  const provisioner = env.PROVISIONER ?? 'fake';
  if (provisioner !== 'fake' && provisioner !== 'coolify') throw new Error('PROVISIONER must be fake or coolify');
  const coolify = provisioner === 'coolify' ? loadCoolify(env) : undefined;
  const platformDomain = env.PLATFORM_DOMAIN?.trim().toLowerCase().replace(/\.$/, '') || undefined;
  const brandDomain = env.BRAND_DOMAIN?.trim().toLowerCase().replace(/\.$/, '') || undefined;
  return {
    databaseUrl,
    port: Number(env.PORT ?? 4111),
    storesDomain: env.STORES_DOMAIN ?? 'stores.waas.example',
    versionsDomain: env.VERSIONS_DOMAIN ?? 'versions.waas.example',
    platformDomain,
    brandDomain,
    secretsKey,
    backupRetentionDays: Number(env.BACKUP_RETENTION_DAYS ?? 90),
    adminToken: env.ADMIN_TOKEN || undefined,
    provisioner,
    coolify,
    sendingDomains: coolify?.mailKeys instanceof ToSendAdmin ? coolify.mailKeys : undefined,
    domainConnect: loadDomainConnectConfig(env, brandDomain ?? platformDomain),
    releases: loadReleases(env),
    dbBackup: loadDbBackupConfig(env),
    storeBackup: loadStoreBackupConfig(env),
    requestLogDays: requestLogDays(env.REQUEST_LOG_DAYS),
    publicUrl: env.PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined,
    webhooks: loadWebhookConfig(env),
    auth: loadAuthConfig(env),
    storefrontProductId: loadStorefrontProductId(env.STOREFRONT_PRODUCT_ID),
    applicationNotify: loadEmails('APPLICATION_NOTIFY_EMAILS', env.APPLICATION_NOTIFY_EMAILS),
  };
}

function loadStorefrontProductId(value: string | undefined): string | undefined {
  const id = value?.trim().toLowerCase();
  if (!id) return undefined;
  if (!isUuid(id)) throw new Error('STOREFRONT_PRODUCT_ID must be a product id (a UUID)');
  return id;
}

function loadEmails(name: string, value: string | undefined): string[] | undefined {
  const emails = (value ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  for (const e of emails) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(`${name}: ${e} is not an email address`);
  return emails.length ? emails : undefined;
}

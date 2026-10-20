import { randomBytes } from 'node:crypto';
import type { Brand, CreateStoreInput, PhpConstant, Provisioner, StoreSender } from '../provisioner.ts';
import { S3, type S3Config } from '../s3.ts';
import type { StoreMailKeys } from '../../tosend.ts';
import { CoolifyClient, CoolifyError, type CoolifyEnv, type CoolifyService, type CoolifyTask } from './client.ts';
import { encodeConstants, renderCompose } from './compose.ts';

export interface CoolifyProvisionerConfig {
  /** e.g. https://coolify.example.com */
  url: string;
  /** API token (read, write, deploy). Unset when a proxy adds credentials. */
  token?: string;
  /** The server new stores and version sites run on. */
  serverUuid: string;
  /** The "WaaS Stores" project. The driver never touches anything outside it. */
  projectUuid: string;
  s3: S3Config;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long a deploy or restart may take to come up healthy. */
  deployTimeoutMs?: number;
  /**
   * How long to wait for Coolify to show that a restart began (some container not running healthy)
   * before going on to wait for healthy anyway.
   */
  restartSeenTimeoutMs?: number;
  /** How long one agent command may run. */
  taskTimeoutSeconds?: number;
  pollMs?: number;
  /** The relay stores send email through. Unset: stores send none (the WordPress image has no mailer). */
  mail?: StoreMail;
  /**
   * Gives each store its own relay password (a toSend sending key) in place of `mail.pass`, so one
   * store's key can be revoked alone and is revoked when the store is deleted. Unset: all stores
   * share `mail.pass`.
   */
  mailKeys?: StoreMailKeys;
  /** Who suspended stores' "website unavailable" page credits, unless a suspend names its own. */
  brand?: Brand;
  /**
   * The store's site key (src/sitekeys.ts), given to it as WAAS_SITE_KEY so WaaS Client accepts the
   * API's signed site-editing requests. Unset: stores get none and can't be edited through the API.
   */
  siteKey?: (storeId: string) => string;
}

/** An SMTP relay, e.g. toSend's. `from` must be on a domain verified with it. */
export interface StoreMail {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/** The store variable carrying StoreMail as base64 JSON (compose.ts, the waas-mail mu-plugin). */
const MAIL_ENV = 'WAAS_MAIL_B64';
/** The id of the store's own relay key (CoolifyProvisionerConfig.mailKeys), to revoke it later. */
const MAIL_KEY_ENV = 'WAAS_MAIL_KEY_ID';

/**
 * A variable's value as stored. Not real_value: Coolify hands a literal variable's real_value back
 * wrapped in single quotes, so writing it back added a layer of quotes on every store start until
 * the store's .env no longer parsed and it would not start.
 */
const envValue = (envs: CoolifyEnv[], key: string) => {
  const env = envs.find((e) => e.key === key);
  return env && (env.value ?? env.real_value);
};
/** A value without the quotes that envValue's old reading of real_value left around it. */
const unquote = (value: string | undefined) => value?.replace(/^'+|'+$/g, '');
const decodeMail = (value: string | undefined): Partial<StoreMail> | null => {
  try {
    return value ? JSON.parse(Buffer.from(value, 'base64').toString()) : null;
  } catch {
    return null;
  }
};

export const DEFAULT_BRAND: Brand = { name: 'AnyPress' };

const STORES_ENV = 'stores';
const VERSIONS_ENV = 'versions';
/** On-demand tasks are created disabled; Coolify still wants a valid schedule (it rejects Feb 31st). */
const NEVER = '0 0 1 1 *';
const AGENT = 'php /tmp/waas-agent.php';
/** Coolify stores a scheduled task's command in a varchar(255). */
const MAX_COMMAND = 255;
const STAGE_CHUNK = 200;
/**
 * WP-CLI for the cron task. The CLI image's PHP allows 128 MB, and a store with every template plugin needs about
 * that just to load them in WP-CLI (no opcache), so cron died there. 192 MB fits the agent's 256 MB. No --path: the
 * agent's working directory is /var/www/html, and the command has to fit Coolify's 255 characters.
 */
const WP = 'php -d memory_limit=192M /usr/local/bin/wp';

/**
 * Each store's cron: WP-cron and Action Scheduler every minute, from the agent container (which
 * runs as uid 33, as WordPress does), since DISABLE_WP_CRON keeps page loads from running them
 * (compose.ts). Skipped while the store is suspended: the contract says its cron stops. `flock`
 * keeps a slow run from overlapping the next one in the agent's 256 MB. No single quotes:
 * Coolify wraps the command in sh -c '...'.
 */
export const CRON_TASK = {
  name: 'wp-cron',
  container: 'agent',
  frequency: '* * * * *',
  timeout: 300,
  enabled: true,
  command:
    '[ -f /var/www/html/wp-content/.waas-suspended ] || flock -n /tmp/waas-cron.lock sh -c ' +
    `"${WP} action-scheduler run --quiet; ${WP} cron event run --due-now --quiet"`,
};

const isCronTask = (t: CoolifyTask) =>
  t.command === CRON_TASK.command &&
  t.container === CRON_TASK.container &&
  t.frequency === CRON_TASK.frequency &&
  Number(t.timeout) === CRON_TASK.timeout &&
  Boolean(t.enabled);

/**
 * What the driver keeps in a Service's description, so it needs no table of its own. Coolify
 * allows only letters, digits, spaces and some punctuation there (no JSON), hence a plain format:
 * "WaaS version, WordPress 6.8, PHP 8.3" or "WaaS store, version <id>, setup <n>" (no setup: 1).
 */
export interface VersionMeta {
  kind: 'version';
  wordPressVersion: string;
  phpVersion: string;
}
export interface StoreMeta {
  kind: 'store';
  versionId: string;
  /** The STORE_SETUP the store's compose and agent files were last brought to; new stores get the current one. */
  setup?: number;
}

/**
 * Which store setup new stores get. Bump it when a change to the compose file (compose.ts) or to the files the
 * agent installs (install_guard in agent.php) should reach existing stores: on the API's next start,
 * ensureStoreSetup gives each older store the new compose, restarts it once and reinstalls the agent's files.
 * 2: at most 8 Apache workers, and the page cache.
 * 3: WAAS_SITE_KEY, for site editing through the API.
 */
export const STORE_SETUP = 3;

const storeName = (storeId: string) => `store-${storeId}`;
const versionName = (versionId: string) => `version-${versionId}`;
const https = (domain: string) => `https://${domain}`;
const urlsFor = (domains: string[]) => [{ name: 'wordpress', url: domains.map(https).join(',') }];
const b64 = (s: string) => Buffer.from(s).toString('base64');

/** Object keys in the bucket. */
const keys = {
  upload: (versionId: string, zip: boolean) => `uploads/${versionId}.${zip ? 'zip' : 'tgz'}`,
  base: (id: string) => `base/${id}.zip`,
  code: (versionId: string) => `versions/${versionId}/code.zip`,
  snapshot: (id: string) => `snapshots/${id}.zip`,
  backup: (id: string) => `backups/${id}.zip`,
};

/**
 * Runs each store as one Coolify Service (WordPress, MariaDB and a WP-CLI agent) in the
 * "WaaS Stores" project, and keeps archives in an S3-compatible bucket. Design and the reasons
 * behind it: docs/coolify.md.
 *
 * Services are found by name (store-<id>, version-<id>), so every method is idempotent and the
 * API's database holds no Coolify ids. Store-side work runs through the agent as Coolify
 * scheduled tasks executed on demand.
 */
export class CoolifyProvisioner implements Provisioner {
  readonly coolify: CoolifyClient;
  readonly s3: S3;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly envIds = new Map<string, number>();

  constructor(private readonly config: CoolifyProvisionerConfig) {
    this.coolify = new CoolifyClient(config.url, config.token, config.fetch);
    this.s3 = new S3(config.s3, config.fetch);
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private get pollMs() {
    return this.config.pollMs ?? 3000;
  }

  // Coolify lookups

  /** The id of one of the project's environments, created on first use. */
  private async environmentId(name: string): Promise<number> {
    const cached = this.envIds.get(name);
    if (cached !== undefined) return cached;
    let env;
    try {
      env = await this.coolify.getEnvironment(this.config.projectUuid, name);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      await this.coolify.createEnvironment(this.config.projectUuid, name);
      env = await this.coolify.getEnvironment(this.config.projectUuid, name);
    }
    this.envIds.set(name, env.id);
    return env.id;
  }

  /** The Service with this name in this project's environment, if any. */
  async findService(envName: string, name: string): Promise<CoolifyService | null> {
    const envId = await this.environmentId(envName);
    const services = await this.coolify.listServices();
    return services.find((s) => s.name === name && s.environment_id === envId) ?? null;
  }

  private async requireService(envName: string, name: string): Promise<CoolifyService> {
    const service = await this.findService(envName, name);
    if (!service) throw new Error(`Coolify: no service ${name}`);
    return service;
  }

  private async versionMeta(versionId: string): Promise<VersionMeta> {
    const service = await this.requireService(VERSIONS_ENV, versionName(versionId));
    const meta = parseMeta(service.description);
    if (meta?.kind !== 'version') throw new Error(`Coolify: ${versionName(versionId)} has no version metadata`);
    return meta;
  }

  /** Creates the Service unless it exists, sets its variables and starts it. Returns its uuid. */
  private async ensureService(input: {
    envName: string;
    name: string;
    meta: VersionMeta | StoreMeta;
    wordPressVersion: string;
    phpVersion: string;
    domains: string[];
    envs: Record<string, string>;
  }): Promise<string> {
    let service = await this.findService(input.envName, input.name);
    if (!service) {
      const created = await this.coolify.createService({
        name: input.name,
        description: formatMeta(input.meta),
        project_uuid: this.config.projectUuid,
        environment_name: input.envName,
        server_uuid: this.config.serverUuid,
        docker_compose_raw: b64(renderCompose(input)),
        urls: urlsFor(input.domains),
        // Variables first, then start.
        instant_deploy: false,
      });
      service = { uuid: created.uuid, name: input.name };
    }
    if (Object.keys(input.envs).length) await this.coolify.setEnvs(service.uuid, input.envs);
    await this.coolify.startService(service.uuid).catch((err: unknown) => {
      // A retried job finds the Service it created last time already up; that is the goal anyway.
      if (!(err instanceof CoolifyError && err.status === 400 && /already running/i.test(err.message))) throw err;
    });
    await this.waitHealthy(service.uuid);
    return service.uuid;
  }

  /** Waits until every container of the Service runs and none is unhealthy. */
  async waitHealthy(uuid: string): Promise<void> {
    const deadline = Date.now() + (this.config.deployTimeoutMs ?? 10 * 60_000);
    let last = 'unknown';
    for (;;) {
      const statuses = await this.statuses(uuid);
      last = statuses.join(', ') || 'unknown';
      if (allHealthy(statuses)) {
        // The agent is the last container up; a ping confirms it can run commands.
        await this.exec(uuid, 'ping', {});
        return;
      }
      if (Date.now() > deadline) break;
      await this.sleep(this.pollMs);
    }
    throw new Error(`Coolify: service ${uuid} did not become healthy (${last})`);
  }

  /** The status of each of the Service's containers, as Coolify last saw them. */
  private async statuses(uuid: string): Promise<string[]> {
    const service = await this.coolify.getService(uuid);
    const statuses = [...(service.applications ?? []), ...(service.databases ?? [])].map((c) => c.status ?? '');
    if (!statuses.length && service.status) statuses.push(service.status);
    return statuses;
  }

  /**
   * Restarts the Service and waits until it is healthy again. Coolify updates container statuses
   * from a periodic check, so for a while after the restart call they still read the old
   * "running:healthy"; waiting for healthy straight away would run the next agent command in the
   * old containers just before they stop. So first wait until a status shows the restart, then
   * wait for healthy. If no status ever shows it (a restart faster than Coolify's check), go on
   * after restartSeenTimeoutMs.
   */
  private async restart(uuid: string) {
    await this.coolify.restartService(uuid);
    const deadline = Date.now() + (this.config.restartSeenTimeoutMs ?? 3 * 60_000);
    while (allHealthy(await this.statuses(uuid)) && Date.now() < deadline) await this.sleep(this.pollMs);
    await this.waitHealthy(uuid);
  }

  /**
   * Runs one agent operation in the Service's agent container: an on-demand scheduled task,
   * deleted afterwards because its command can carry pre-signed URLs. Coolify keeps a task's
   * command in 255 characters, so longer arguments are first staged in the container in chunks.
   */
  async exec(uuid: string, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = b64(JSON.stringify(args));
    const direct = `${AGENT} ${op} ${payload}`;
    if (direct.length <= MAX_COMMAND) return this.runTask(uuid, op, direct);
    const id = randomBytes(6).toString('hex');
    for (let i = 0; i < payload.length; i += STAGE_CHUNK) {
      await this.runTask(uuid, 'stage', `${AGENT} stage ${id} ${payload.slice(i, i + STAGE_CHUNK)}`);
    }
    return this.runTask(uuid, op, `${AGENT} ${op} @${id}`);
  }

  private async runTask(uuid: string, op: string, command: string): Promise<Record<string, unknown>> {
    const timeout = this.config.taskTimeoutSeconds ?? 1800;
    const task = await this.coolify.createTask(uuid, {
      name: `waas-${op}-${randomBytes(4).toString('hex')}`,
      command,
      container: 'agent',
      frequency: NEVER,
      timeout,
      enabled: false,
    });
    try {
      await this.coolify.executeTask(uuid, task.uuid);
      const deadline = Date.now() + (timeout + 60) * 1000;
      for (;;) {
        await this.sleep(this.pollMs);
        const executions = await this.coolify.listExecutions(uuid, task.uuid);
        const finished = executions.find((e) => e.status === 'success' || e.status === 'failed' || e.finished_at);
        if (finished) {
          if (finished.message === undefined) {
            // Coolify hides task output from tokens without read:sensitive, and the result is in that output.
            throw new Error(`Store agent ${op}: Coolify hid the task output; the API's COOLIFY_TOKEN needs the read:sensitive permission`);
          }
          const output = finished.message ?? '';
          const result = /^WAAS_RESULT (.*)$/m.exec(output);
          if (finished.status === 'success' && result) return JSON.parse(result[1]!);
          const error = /^WAAS_ERROR (.*)$/m.exec(output)?.[1] ?? output.slice(-300);
          throw new Error(`Store agent ${op} failed (${finished.status}): ${error}`);
        }
        if (Date.now() > deadline) throw new Error(`Store agent ${op} timed out`);
      }
    } finally {
      await this.coolify.deleteTask(uuid, task.uuid).catch(() => undefined);
    }
  }

  private async deleteService(envName: string, name: string) {
    const service = await this.findService(envName, name);
    if (!service) return;
    await this.coolify.deleteService(service.uuid);
    // Deletion is queued in Coolify; wait until the name is free again.
    const deadline = Date.now() + (this.config.deployTimeoutMs ?? 10 * 60_000);
    while (await this.findService(envName, name)) {
      if (Date.now() > deadline) throw new Error(`Coolify: ${name} was not deleted in time`);
      await this.sleep(this.pollMs);
    }
  }

  // Versions

  async createUploadUrl({ versionId, asZip }: { versionId: string; asZip: boolean }) {
    return this.s3.presign('PUT', keys.upload(versionId, asZip), 3600);
  }

  async buildVersion(input: Parameters<Provisioner['buildVersion']>[0]) {
    const meta: VersionMeta = { kind: 'version', wordPressVersion: input.wordPressVersion, phpVersion: input.phpVersion };
    const uuid = await this.ensureService({ envName: VERSIONS_ENV, name: versionName(input.versionId), meta, ...meta, domains: [input.domain], envs: {} });
    let sourceKey: string;
    if ('snapshotId' in input.source) sourceKey = keys.snapshot(input.source.snapshotId);
    else if ('baseSnapshotId' in input.source) sourceKey = keys.base(input.source.baseSnapshotId);
    else {
      const zip = keys.upload(input.versionId, true);
      sourceKey = (await this.s3.head(zip)) !== null ? zip : keys.upload(input.versionId, false);
    }
    if ((await this.s3.head(sourceKey)) === null) throw new Error(`No archive at ${sourceKey}`);
    await this.exec(uuid, 'restore', { url: this.s3.presign('GET', sourceKey), home: https(input.domain), title: 'Version site' });
    await this.exec(uuid, 'code-export', { url: this.s3.presign('PUT', keys.code(input.versionId)) });
  }

  async deleteVersion({ versionId }: { versionId: string }) {
    await this.deleteService(VERSIONS_ENV, versionName(versionId));
    await this.s3.delete(keys.code(versionId));
    await this.s3.delete(keys.upload(versionId, true));
    await this.s3.delete(keys.upload(versionId, false));
  }

  // Snapshots

  async copySnapshot({ snapshotId, newSnapshotId }: Parameters<Provisioner['copySnapshot']>[0]) {
    await this.s3.copy(keys.snapshot(snapshotId), keys.snapshot(newSnapshotId));
  }

  async copyBaseSnapshot({ baseSnapshotId, newSnapshotId }: Parameters<Provisioner['copyBaseSnapshot']>[0]) {
    if ((await this.s3.head(keys.base(baseSnapshotId))) === null) throw new Error(`No base snapshot ${baseSnapshotId} uploaded`);
    await this.s3.copy(keys.base(baseSnapshotId), keys.snapshot(newSnapshotId));
  }

  async createBaseSnapshotUpload({ baseSnapshotId }: { baseSnapshotId: string }) {
    return { uploadUrl: this.s3.presign('PUT', keys.base(baseSnapshotId), 3600), uri: this.s3.objectUrl(keys.base(baseSnapshotId)) };
  }

  async deleteBaseSnapshot({ baseSnapshotId }: { baseSnapshotId: string }) {
    await this.s3.delete(keys.base(baseSnapshotId));
  }

  async snapshotUpload({ versionId, snapshotId }: { versionId: string; snapshotId: string }) {
    const version = await this.requireService(VERSIONS_ENV, versionName(versionId));
    await this.exec(version.uuid, 'snapshot', { url: this.s3.presign('PUT', keys.snapshot(snapshotId)) });
  }

  async downloadSnapshot({ snapshotId }: { snapshotId: string }) {
    return this.s3.get(keys.snapshot(snapshotId));
  }

  // Stores

  async createStore(input: CreateStoreInput) {
    await this.buildStore(input, keys.snapshot(input.snapshotId));
  }

  async restoreDeletedStore(input: Parameters<Provisioner['restoreDeletedStore']>[0]) {
    const { backupId, ...store } = input;
    await this.buildStore(store, keys.backup(backupId));
  }

  private async buildStore(input: Omit<CreateStoreInput, 'snapshotId'>, sourceKey: string) {
    const version = await this.versionMeta(input.versionId);
    if ((await this.s3.head(sourceKey)) === null) throw new Error(`No archive at ${sourceKey}`);
    const envs: Record<string, string> = { WAAS_CONSTANTS_B64: encodeConstants(input.phpConstants) };
    if (input.user?.password) envs.WAAS_INIT_PASSWORD = input.user.password;
    Object.assign(envs, this.siteKeyEnvs(input.storeId));
    // A retried create finds the Service, and the key it minted, from last time.
    const existing = await this.findService(STORES_ENV, storeName(input.storeId));
    Object.assign(envs, await this.storeMailEnvs(input.storeId, existing ? await this.coolify.listEnvs(existing.uuid) : []));
    const uuid = await this.ensureService({
      envName: STORES_ENV,
      name: storeName(input.storeId),
      meta: { kind: 'store', versionId: input.versionId },
      wordPressVersion: version.wordPressVersion,
      phpVersion: version.phpVersion,
      domains: [input.mainDomain, ...input.redirectDomains],
      envs,
    });
    const home = https(input.mainDomain);
    try {
      await this.exec(uuid, 'restore', { url: this.s3.presign('GET', sourceKey), home });
      await this.exec(uuid, 'code-import', { url: this.s3.presign('GET', keys.code(input.versionId)) });
      await this.exec(uuid, 'configure', {
        home,
        options: input.wpOptions,
        user: input.user && { name: input.user.name, email: input.user.email, role: input.user.role },
      });
    } finally {
      // The first user's password is needed once; don't leave it in Coolify.
      if (envs.WAAS_INIT_PASSWORD) await this.removeEnv(uuid, 'WAAS_INIT_PASSWORD');
    }
    await this.ensureCron(uuid);
  }

  /**
   * Makes the Service's `wp-cron` task exist exactly once, as CRON_TASK says. Found by name, so a
   * retry reuses it; a task of that name that differs (or a duplicate) is replaced.
   */
  private async ensureCron(uuid: string): Promise<'created' | 'updated' | 'unchanged'> {
    const named = (await this.coolify.listTasks(uuid)).filter((t) => t.name === CRON_TASK.name);
    const keep = named.find(isCronTask);
    for (const task of named) if (task !== keep) await this.coolify.deleteTask(uuid, task.uuid);
    if (keep) return named.length > 1 ? 'updated' : 'unchanged';
    await this.coolify.createTask(uuid, CRON_TASK);
    return named.length ? 'updated' : 'created';
  }

  /**
   * Brings a store set up before STORE_SETUP to it: the current compose file, one restart, then the
   * agent's files (configure). The description is updated last, so a store that fails part-way is
   * tried again on the next start.
   */
  async ensureStoreSetup({ storeId }: { storeId: string }): Promise<'updated' | 'unchanged'> {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = parseMeta(store.description);
    if (meta?.kind !== 'store') throw new Error(`Coolify: ${store.name} has no store metadata`);
    if ((meta.setup ?? 1) >= STORE_SETUP) return 'unchanged';
    await this.coolify.updateService(store.uuid, { docker_compose_raw: b64(renderCompose(await this.versionMeta(meta.versionId))) });
    const siteKey = this.siteKeyEnvs(storeId);
    if (Object.keys(siteKey).length) await this.coolify.setEnvs(store.uuid, siteKey);
    await this.restart(store.uuid);
    await this.exec(store.uuid, 'configure', {});
    await this.coolify.updateService(store.uuid, { description: formatMeta({ ...meta, setup: STORE_SETUP }) });
    return 'updated';
  }

  /**
   * Gives a store created before stores had a cron task its task. Such a store's compose also
   * predates DISABLE_WP_CRON, so it is re-rendered from the store's version and the store restarted
   * once, before the task is added: a store with the task is left alone, so this runs once.
   */
  async ensureStoreCron({ storeId }: { storeId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    if (!(await this.coolify.listTasks(store.uuid)).some((t) => t.name === CRON_TASK.name)) {
      const meta = parseMeta(store.description);
      if (meta?.kind !== 'store') throw new Error(`Coolify: ${store.name} has no store metadata`);
      await this.coolify.updateService(store.uuid, { docker_compose_raw: b64(renderCompose(await this.versionMeta(meta.versionId))) });
      await this.restart(store.uuid);
    }
    return this.ensureCron(store.uuid);
  }

  private siteKeyEnvs(storeId: string): Record<string, string> {
    return this.config.siteKey ? { WAAS_SITE_KEY: this.config.siteKey(storeId) } : {};
  }

  /**
   * A store's mail variables: the relay settings, with the store's own key when keys are per store
   * (reusing the one it already holds while it sends from the same address), or nothing when stores
   * send no email. With `sender`, it sends from the platform's address name at its own domain, with
   * a key restricted to that domain.
   */
  private async storeMailEnvs(storeId: string, current: CoolifyEnv[], sender?: StoreSender): Promise<Record<string, string>> {
    const mail = this.config.mail;
    if (!mail) return {};
    const envs: Record<string, string> = {};
    let pass = mail.pass;
    let from = mail.from;
    if (sender) {
      if (!this.config.mailKeys) throw new Error('A store sending from its own domain needs per-store keys (TOSEND_ADMIN_KEY)');
      from = `${mail.from.split('@')[0]}@${sender.domain}`;
    }
    if (this.config.mailKeys) {
      const keyId = unquote(envValue(current, MAIL_KEY_ENV));
      const held = keyId ? decodeMail(unquote(envValue(current, MAIL_ENV))) : null;
      if (keyId && held?.pass && held.from === from) {
        envs[MAIL_KEY_ENV] = keyId;
        pass = held.pass;
      } else if (sender) {
        // No fallback here: the shared key can't send from the store's domain.
        const key = await this.config.mailKeys.create(storeId, sender.domainId);
        envs[MAIL_KEY_ENV] = key.id;
        pass = key.key;
      } else {
        // toSend being down or refusing must not stop a store from being created: it sends with
        // the shared key until ensureStoreMail succeeds on a later start.
        const key = await this.config.mailKeys.create(storeId).catch((err: unknown) => {
          console.error(`Store ${storeId}: own mail key not created, using the shared one: ${(err as Error).message}`);
          return null;
        });
        if (key) {
          envs[MAIL_KEY_ENV] = key.id;
          pass = key.key;
        }
      }
    }
    envs[MAIL_ENV] = b64(JSON.stringify({ host: mail.host, port: mail.port, user: mail.user, pass, from }));
    return envs;
  }

  /**
   * Gives a store the current mail relay settings: a store created before stores sent email, before
   * keys were per store, or after the relay's settings changed. Such a store gets the variables, a
   * compose that passes them to WordPress (re-rendered from its version, as ensureStoreCron does),
   * one restart, and the mu-plugin. A store already holding the same settings is left alone, so
   * this runs once. A `sender` moves the store to its own domain; leaving it out moves it back.
   */
  async ensureStoreMail({ storeId, sender }: { storeId: string; sender?: StoreSender }): Promise<'created' | 'updated' | 'unchanged'> {
    if (!this.config.mail) return 'unchanged';
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const current = await this.coolify.listEnvs(store.uuid);
    const had = current.some((e) => e.key === MAIL_ENV);
    // Coolify hides values from a token without read:sensitive; then nothing can be compared.
    if (had && envValue(current, MAIL_ENV) === undefined) return 'unchanged';
    const want = await this.storeMailEnvs(storeId, current, sender);
    if (Object.entries(want).every(([key, value]) => envValue(current, key) === value)) return 'unchanged';
    if (!had) {
      const meta = parseMeta(store.description);
      if (meta?.kind !== 'store') throw new Error(`Coolify: ${store.name} has no store metadata`);
      await this.coolify.updateService(store.uuid, { docker_compose_raw: b64(renderCompose(await this.versionMeta(meta.versionId))) });
    }
    await this.coolify.setEnvs(store.uuid, want);
    await this.restart(store.uuid);
    await this.exec(store.uuid, 'configure', {});
    // A key the store no longer uses (its value was lost, or it changed domains) is revoked.
    const oldKeyId = unquote(envValue(current, MAIL_KEY_ENV));
    if (oldKeyId && oldKeyId !== want[MAIL_KEY_ENV]) await this.config.mailKeys?.delete(oldKeyId);
    return had ? 'updated' : 'created';
  }

  private async removeEnv(uuid: string, key: string) {
    const envs = await this.coolify.listEnvs(uuid);
    for (const env of envs.filter((e) => e.key === key)) await this.coolify.deleteEnv(uuid, env.uuid);
  }

  async setDomains({ storeId, mainDomain, redirectDomains }: Parameters<Provisioner['setDomains']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.coolify.updateService(store.uuid, { urls: urlsFor([mainDomain, ...redirectDomains]) });
    await this.restart(store.uuid);
    await this.exec(store.uuid, 'configure', { home: https(mainDomain) });
  }

  async updateStore({ storeId, wpOptions, phpConstants }: { storeId: string; wpOptions?: Record<string, string>; phpConstants?: Record<string, PhpConstant> }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    if (phpConstants) {
      // The complete set (see Provisioner.updateStore); Coolify's API does not hand values back to merge with.
      await this.coolify.setEnvs(store.uuid, { WAAS_CONSTANTS_B64: encodeConstants(phpConstants) });
      await this.restart(store.uuid);
    }
    if (wpOptions && Object.keys(wpOptions).length) await this.exec(store.uuid, 'configure', { options: wpOptions });
  }

  async moveStore({ storeId, targetVersionId }: { storeId: string; targetVersionId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const version = await this.versionMeta(targetVersionId);
    // The agent's files are not reinstalled here, so the store keeps its setup for ensureStoreSetup to finish.
    const current = parseMeta(store.description);
    await this.coolify.updateService(store.uuid, {
      description: formatMeta({ kind: 'store', versionId: targetVersionId, setup: current?.kind === 'store' ? current.setup : 1 }),
      docker_compose_raw: b64(renderCompose(version)),
    });
    await this.restart(store.uuid);
    await this.exec(store.uuid, 'code-import', { url: this.s3.presign('GET', keys.code(targetVersionId)) });
    await this.exec(store.uuid, 'update-db', {});
  }

  async snapshotStore({ storeId, snapshotId }: { storeId: string; snapshotId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'snapshot', { url: this.s3.presign('PUT', keys.snapshot(snapshotId)) });
  }

  async restoreStore({ storeId, snapshotId }: { storeId: string; snapshotId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = parseMeta(store.description);
    // Keep the store's current main domain: read it from WordPress before replacing the database.
    const home = await this.currentHome(store.uuid);
    await this.exec(store.uuid, 'restore', { url: this.s3.presign('GET', keys.snapshot(snapshotId)), home });
    if (meta?.kind === 'store') await this.exec(store.uuid, 'code-import', { url: this.s3.presign('GET', keys.code(meta.versionId)) });
  }

  async rollbackStore({ storeId, backupId, wpOptions, mainDomain }: Parameters<Provisioner['rollbackStore']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = parseMeta(store.description);
    if (meta?.kind !== 'store') throw new Error(`Coolify: ${store.name} has no store metadata`);
    if ((await this.s3.head(keys.backup(backupId))) === null) throw new Error(`No archive at ${keys.backup(backupId)}`);
    // Keep the store's current main domain: read it from WordPress before replacing the database.
    // A store whose WordPress is gone (an emptied volume) has none, so it takes its main domain on record.
    // The agent keeps the suspension flag and page across the restore.
    const home = await this.currentHome(store.uuid, mainDomain);
    await this.exec(store.uuid, 'restore', { url: this.s3.presign('GET', keys.backup(backupId)), home });
    // The code of the version the store runs now, and its database brought up to that WordPress.
    await this.exec(store.uuid, 'code-import', { url: this.s3.presign('GET', keys.code(meta.versionId)) });
    await this.exec(store.uuid, 'update-db', {});
    await this.exec(store.uuid, 'configure', { options: wpOptions });
  }

  private async currentHome(uuid: string, fallbackDomain?: string): Promise<string> {
    const result = await this.exec(uuid, 'home', {});
    if (typeof result.home === 'string') return result.home;
    if (fallbackDomain) return https(fallbackDomain);
    throw new Error('Store agent did not report the home URL');
  }

  async backupStore({ storeId, backupId }: { storeId: string; backupId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const result = await this.exec(store.uuid, 'snapshot', { url: this.s3.presign('PUT', keys.backup(backupId)) });
    const sizeBytes = (await this.s3.head(keys.backup(backupId))) ?? Number(result.sizeBytes ?? 0);
    return { sizeBytes };
  }

  async deleteBackup({ backupId }: { backupId: string }) {
    await this.s3.delete(keys.backup(backupId));
  }

  async suspendStore({ storeId, brand }: { storeId: string; brand?: Brand }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'suspend', { brand: brand ?? this.config.brand ?? DEFAULT_BRAND });
  }

  async resumeStore({ storeId }: { storeId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'resume', {});
  }

  async deleteStore({ storeId }: { storeId: string }) {
    // The store's own relay key goes first: once the Service is gone, so is the record of its id.
    const store = this.config.mailKeys && (await this.findService(STORES_ENV, storeName(storeId)));
    const keyId = store ? envValue(await this.coolify.listEnvs(store.uuid), MAIL_KEY_ENV) : undefined;
    if (keyId) await this.config.mailKeys!.delete(keyId);
    await this.deleteService(STORES_ENV, storeName(storeId));
  }
}

/** Every container runs and none is unhealthy or still starting. */
function allHealthy(statuses: string[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s.startsWith('running') && !s.includes('unhealthy') && !s.includes('starting'));
}

export function formatMeta(meta: VersionMeta | StoreMeta): string {
  return meta.kind === 'version'
    ? `WaaS version, WordPress ${meta.wordPressVersion}, PHP ${meta.phpVersion}`
    : `WaaS store, version ${meta.versionId}, setup ${meta.setup ?? STORE_SETUP}`;
}

export function parseMeta(description: string | null | undefined): VersionMeta | StoreMeta | null {
  const version = /^WaaS version, WordPress ([\d.]+), PHP ([\d.]+)$/.exec(description ?? '');
  if (version) return { kind: 'version', wordPressVersion: version[1]!, phpVersion: version[2]! };
  const store = /^WaaS store, version ([\w-]+)(?:, setup (\d+))?$/.exec(description ?? '');
  return store ? { kind: 'store', versionId: store[1]!, setup: Number(store[2] ?? 1) } : null;
}

import { randomBytes } from 'node:crypto';
import { DEFAULT_SIZE, isSize, type Size } from '../../plans.ts';
import { storeFromAddress, type Brand, type CreateStoreInput, type Provisioner, type RestoreTestResult, type SiteCheck, type StoreMailFrom } from '../provisioner.ts';
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
const domainOf = (address: string | undefined) => address?.split('@')[1]?.toLowerCase();
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
 * The Coolify scheduled task that ran a store's cron before setup 9, when the agent container took it over
 * (AGENT_COMMAND in compose.ts). A store still on an older setup keeps it, as it was, until ensureStoreSetup
 * brings the store to the current one; then ensureStoreCron removes it. Every 5 minutes, not every minute: each
 * run is a Coolify job plus a "task done" event, and at a minute per store they came in faster than Coolify's
 * queue could work them off, so deploys and service starts waited behind them (2026-10-23). No single quotes:
 * Coolify wraps the command in sh -c '...'.
 */
export const CRON_TASK = {
  name: 'wp-cron',
  container: 'agent',
  frequency: '*/5 * * * *',
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
 * "WaaS version, WordPress 6.8, PHP 8.3" or "WaaS store, version <id>, setup <n>, size <size>" (no setup: 1;
 * no size: small, which every store ran as before sizes).
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
  /** The size (plans.ts) the store's compose file was last rendered with. */
  size: Size;
}

/**
 * Which store setup new stores get. Bump it when a change to the compose file (compose.ts) or to the files the
 * agent installs (install_guard in agent.php) should reach existing stores: on the API's next start,
 * ensureStoreSetup gives each older store the new compose, restarts it once and reinstalls the agent's files.
 * 2: at most 8 Apache workers, and the page cache.
 * 3: sizes and the plan mu-plugin.
 * 4: WAAS_SITE_KEY, for site editing through the API.
 * 5: email packs: the plan mu-plugin adds pack emails to the month's allowance, and the agent's mail-packs operation.
 * 6: the platform's count of the store's email: the plan mu-plugin goes by the higher of it and its own, the agent's
 *    mail-count operation, and replies to the store's own mailbox reach its administrator.
 * 7: the mail mu-plugin fills in each Fluent plugin's own sender (From and Reply-To) with how the store sends.
 * 8: the owner mu-plugin fills in the owner's address, phone, time zone, currency and name from the purchase.
 * 9: the agent container runs the store's cron (AGENT_COMMAND in compose.ts) instead of a Coolify scheduled task,
 *    and health checks run every minute instead of every 5 or 10 seconds.
 * 10: the agent container is held to half a core, the database to the plan's cores, and each cron command stops
 *    after CRON_LIMIT seconds.
 * 11: the agent script travels gzipped (WAAS_AGENT_GZ), as plain base64 it no longer fit in one environment variable.
 */
export const STORE_SETUP = 11;

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
  /** A wordpress.org plugin zip for plugin choices; never changes once stored. */
  plugin: (slug: string, version: string) => `plugins/wporg/${slug}/${version}.zip`,
  /** A plugin zip a seller uploaded. */
  pluginUpload: (uploadId: string) => `plugins/uploads/${uploadId}.zip`,
  /** A version's plugin choices with signed links to their zips, for the agent's plugins step. */
  pluginChoices: (versionId: string) => `versions/${versionId}/plugin-choices.json`,
  backup: (id: string) => `backups/${id}.zip`,
  /** A site being moved in: a zip or a gzipped tar, so no extension. */
  import: (storeId: string) => `imports/${storeId}`,
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

  /** A store's compose file, from its version's WordPress and PHP and its size, as the Service's docker_compose_raw. */
  private async storeCompose(meta: StoreMeta): Promise<string> {
    return b64(renderCompose({ ...(await this.versionMeta(meta.versionId)), size: meta.size }));
  }

  private storeMeta(store: CoolifyService): StoreMeta {
    const meta = parseMeta(store.description);
    if (meta?.kind !== 'store') throw new Error(`Coolify: ${store.name} has no store metadata`);
    return meta;
  }

  /** Creates the Service unless it exists, sets its variables and starts it. Returns its uuid. */
  private async ensureService(input: {
    envName: string;
    name: string;
    meta: VersionMeta | StoreMeta;
    wordPressVersion: string;
    phpVersion: string;
    /** A store's; version sites have none. */
    size?: Size;
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
    // Always run: it also undoes choices an earlier version applied to the archive this one comes from. The
    // choices, with a signed link to each zip, go in a file the agent fetches: too long for task commands.
    let pluginArgs: Record<string, unknown> = { plugins: [] };
    if (input.plugins?.length) {
      const plugins = input.plugins.map((p) =>
        p.action === 'add' ? { ...p, url: this.s3.presign('GET', p.uploadId ? keys.pluginUpload(p.uploadId) : keys.plugin(p.slug, p.version!), 3600) } : p,
      );
      await this.s3.put(keys.pluginChoices(input.versionId), new TextEncoder().encode(JSON.stringify({ plugins })), 'application/json');
      pluginArgs = { manifest: this.s3.presign('GET', keys.pluginChoices(input.versionId)) };
    }
    // The manifest can hold licence keys, so it's removed as soon as the agent has read it.
    const applied = await this.exec(uuid, 'plugins', pluginArgs).finally(() => (input.plugins?.length ? this.s3.delete(keys.pluginChoices(input.versionId)) : undefined));
    await this.exec(uuid, 'code-export', { url: this.s3.presign('PUT', keys.code(input.versionId)) });
    return { pluginFiles: (applied.files ?? {}) as Record<string, string> };
  }

  async storePluginPackage({ slug, version, body }: { slug: string; version: string; body: Uint8Array }) {
    if ((await this.s3.head(keys.plugin(slug, version))) !== null) return;
    await this.s3.put(keys.plugin(slug, version), body, 'application/zip');
  }

  async createPluginUpload({ uploadId }: { uploadId: string }) {
    return { uploadUrl: this.s3.presign('PUT', keys.pluginUpload(uploadId), 3600) };
  }

  async readPluginUpload({ uploadId, maxBytes }: { uploadId: string; maxBytes: number }) {
    const size = await this.s3.head(keys.pluginUpload(uploadId));
    if (size === null) return null;
    if (size > maxBytes) throw new Error(`The upload is larger than ${maxBytes} bytes`);
    return this.s3.get(keys.pluginUpload(uploadId));
  }

  async deletePluginUpload({ uploadId }: { uploadId: string }) {
    await this.s3.delete(keys.pluginUpload(uploadId));
  }

  async deleteVersion({ versionId }: { versionId: string }) {
    await this.deleteService(VERSIONS_ENV, versionName(versionId));
    await this.s3.delete(keys.code(versionId));
    await this.s3.delete(keys.pluginChoices(versionId));
    await this.s3.delete(keys.upload(versionId, true));
    await this.s3.delete(keys.upload(versionId, false));
  }

  async stopVersion({ versionId }: { versionId: string }) {
    const service = await this.findService(VERSIONS_ENV, versionName(versionId));
    // Already stopped: no Coolify job, as daily maintenance asks for every built version.
    if (service && !service.status?.startsWith('exited')) await this.coolify.stopService(service.uuid);
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
    return this.buildStore(input, input.snapshotId === null ? keys.import(input.storeId) : keys.snapshot(input.snapshotId), input.snapshotId === null);
  }

  async restoreDeletedStore(input: Parameters<Provisioner['restoreDeletedStore']>[0]) {
    const { backupId, ...store } = input;
    await this.buildStore(store, keys.backup(backupId));
  }

  /**
   * `imported`: the source is a site moved in from another host, which the agent cleans up on the way in and holds
   * until it goes live. It comes with its own options, so the store's are not written over them, and it is checked
   * once built (check-site): the answer carries what the check found.
   */
  private async buildStore(input: Omit<CreateStoreInput, 'snapshotId'>, sourceKey: string, imported = false): Promise<{ check?: SiteCheck }> {
    const version = await this.versionMeta(input.versionId);
    if ((await this.s3.head(sourceKey)) === null) throw new Error(`No archive at ${sourceKey}`);
    const envs: Record<string, string> = { WAAS_CONSTANTS_B64: encodeConstants(input.phpConstants) };
    if (input.user?.password) envs.WAAS_INIT_PASSWORD = input.user.password;
    Object.assign(envs, this.siteKeyEnvs(input.storeId));
    // A retried create finds the Service, and the key it minted, from last time.
    const existing = await this.findService(STORES_ENV, storeName(input.storeId));
    Object.assign(envs, await this.storeMailEnvs(input.storeId, existing ? await this.coolify.listEnvs(existing.uuid) : [], { mailbox: input.mailbox }));
    const uuid = await this.ensureService({
      envName: STORES_ENV,
      name: storeName(input.storeId),
      meta: { kind: 'store', versionId: input.versionId, size: input.size },
      wordPressVersion: version.wordPressVersion,
      phpVersion: version.phpVersion,
      size: input.size,
      domains: [input.mainDomain, ...input.redirectDomains],
      envs,
    });
    const home = https(input.mainDomain);
    const hold = imported || input.hold === true;
    let check: SiteCheck | undefined;
    try {
      await this.exec(uuid, 'restore', { url: this.s3.presign('GET', sourceKey), home, ...(imported && { import: true }), ...(hold && !imported && { hold: true }) });
      if (!input.ownCode) await this.exec(uuid, 'code-import', { url: this.s3.presign('GET', keys.code(input.versionId)) });
      // A site from elsewhere may come from an older WordPress than the version runs.
      if (imported) await this.exec(uuid, 'update-db', {});
      await this.exec(uuid, 'configure', {
        home,
        // A site moved in keeps its own title and settings.
        options: imported ? {} : input.wpOptions,
        user: input.user && { name: input.user.name, email: input.user.email, role: input.user.role },
        ...(hold && { holdAllow: input.holdAllow ?? [] }),
      });
      // Whether the moved site serves with its plugins loaded. The store is built either way: what the check found
      // is reported with the move, not a reason to build it again.
      if (imported) {
        check = await this.exec(uuid, 'check-site', { home }).then(
          (found) => found as unknown as SiteCheck,
          (err: unknown) => ({ ok: false, error: (err as Error).message.slice(0, 300) }),
        );
      }
    } finally {
      // The first user's password is needed once; don't leave it in Coolify.
      if (envs.WAAS_INIT_PASSWORD) await this.removeEnv(uuid, 'WAAS_INIT_PASSWORD');
    }
    // Its agent runs its cron from now on (configure set the flag, unless the store is held); a task left by an older retry goes.
    await this.removeCron(uuid);
    return check ? { check } : {};
  }

  /**
   * Makes the Service's `wp-cron` task exist exactly once, as CRON_TASK says, for a store on a setup
   * before 9. Found by name, so a retry reuses it; a task of that name that differs (or a duplicate) is replaced.
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
   * Brings a store set up before STORE_SETUP, or running at another size than its record says, to the
   * current setup at that size: the compose file, one restart, then the agent's files (configure). The
   * description is updated last, so a store that fails part-way is tried again on the next start.
   */
  async ensureStoreSetup({ storeId, size }: { storeId: string; size: Size }): Promise<'updated' | 'unchanged'> {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = this.storeMeta(store);
    if ((meta.setup ?? 1) >= STORE_SETUP && meta.size === size) return 'unchanged';
    const want: StoreMeta = { ...meta, setup: STORE_SETUP, size };
    await this.coolify.updateService(store.uuid, { docker_compose_raw: await this.storeCompose(want) });
    const siteKey = this.siteKeyEnvs(storeId);
    if (Object.keys(siteKey).length) await this.coolify.setEnvs(store.uuid, siteKey);
    await this.restart(store.uuid);
    await this.exec(store.uuid, 'configure', {});
    await this.coolify.updateService(store.uuid, { description: formatMeta(want) });
    return 'updated';
  }

  /** Removes the Service's `wp-cron` tasks: a store on the current setup runs its cron in its agent. */
  private async removeCron(uuid: string): Promise<'updated' | 'unchanged'> {
    const named = (await this.coolify.listTasks(uuid)).filter((t) => t.name === CRON_TASK.name);
    for (const task of named) await this.coolify.deleteTask(uuid, task.uuid);
    return named.length ? 'updated' : 'unchanged';
  }

  /**
   * Makes sure a store's scheduled jobs run. A store on the current setup runs them in its agent, so its
   * Coolify `wp-cron` task, if any, is removed. A store on an older setup keeps its task (CRON_TASK) until
   * ensureStoreSetup brings it to the current one; one with no task at all is brought to the current setup
   * here (new compose, one restart).
   */
  async ensureStoreCron({ storeId }: { storeId: string }): Promise<'created' | 'updated' | 'unchanged'> {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = this.storeMeta(store);
    if ((meta.setup ?? 1) < STORE_SETUP) {
      if ((await this.coolify.listTasks(store.uuid)).some((t) => t.name === CRON_TASK.name)) return this.ensureCron(store.uuid);
      await this.ensureStoreSetup({ storeId, size: meta.size });
      await this.removeCron(store.uuid);
      return 'created';
    }
    return this.removeCron(store.uuid);
  }

  private siteKeyEnvs(storeId: string): Record<string, string> {
    return this.config.siteKey ? { WAAS_SITE_KEY: this.config.siteKey(storeId) } : {};
  }

  mailFrom(from: StoreMailFrom): string | null {
    return this.config.mail ? storeFromAddress(this.config.mail.from, from) : null;
  }

  /**
   * A store's mail variables: the relay settings, with the store's own key when keys are per store
   * (reusing the one it already holds while it sends from the same domain: keys are restricted to a
   * domain, not an address), or nothing when stores send no email. With `sender`, it sends from the
   * platform's address name at its own domain, with a key restricted to that domain; with `mailbox`,
   * from that name at the platform's domain.
   */
  private async storeMailEnvs(storeId: string, current: CoolifyEnv[], { sender, mailbox }: StoreMailFrom = {}): Promise<Record<string, string>> {
    const mail = this.config.mail;
    if (!mail) return {};
    const envs: Record<string, string> = {};
    let pass = mail.pass;
    if (sender && !this.config.mailKeys) throw new Error('A store sending from its own domain needs per-store keys (TOSEND_ADMIN_KEY)');
    const from = storeFromAddress(mail.from, { sender, mailbox });
    if (this.config.mailKeys) {
      const keyId = unquote(envValue(current, MAIL_KEY_ENV));
      const held = keyId ? decodeMail(unquote(envValue(current, MAIL_ENV))) : null;
      if (keyId && held?.pass && domainOf(held.from) === domainOf(from)) {
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

  /** The mail variables the store should hold, when they differ from `current`; null when they don't or can't be compared. */
  private async mailChange(storeId: string, current: CoolifyEnv[], from: StoreMailFrom): Promise<Record<string, string> | null> {
    if (!this.config.mail) return null;
    // Coolify hides values from a token without read:sensitive; then nothing can be compared.
    if (current.some((e) => e.key === MAIL_ENV) && envValue(current, MAIL_ENV) === undefined) return null;
    const want = await this.storeMailEnvs(storeId, current, from);
    return Object.entries(want).every(([key, value]) => envValue(current, key) === value) ? null : want;
  }

  /** Revokes a key the store no longer uses (its value was lost, or it changed domains). */
  private async revokeOldMailKey(current: CoolifyEnv[], want: Record<string, string>) {
    const oldKeyId = unquote(envValue(current, MAIL_KEY_ENV));
    if (oldKeyId && oldKeyId !== want[MAIL_KEY_ENV]) await this.config.mailKeys?.delete(oldKeyId);
  }

  /**
   * Gives a store the current mail relay settings: a store created before stores sent email, before
   * keys were per store, after the relay's settings changed, or whose sender changed. Such a store gets
   * the variables, a compose that passes them to WordPress (re-rendered from its version, as
   * ensureStoreCron does), one restart, and the mu-plugin. A store set up before STORE_SETUP gets the
   * current setup with that same restart (ensureStoreSetup then has nothing left to do). A store
   * already holding the same settings is left alone, so this runs once. A `sender` moves the store to
   * its own domain; leaving it out moves it back, to its `mailbox` at the platform's domain.
   */
  async ensureStoreMail({ storeId, ...from }: { storeId: string } & StoreMailFrom): Promise<'created' | 'updated' | 'unchanged'> {
    if (!this.config.mail) return 'unchanged';
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const current = await this.coolify.listEnvs(store.uuid);
    const had = current.some((e) => e.key === MAIL_ENV);
    const want = await this.mailChange(storeId, current, from);
    if (!want) return 'unchanged';
    const meta = parseMeta(store.description);
    if (!had) await this.coolify.updateService(store.uuid, { docker_compose_raw: await this.storeCompose(this.storeMeta(store)) });
    await this.coolify.setEnvs(store.uuid, want);
    if (meta?.kind === 'store' && (meta.setup ?? 1) < STORE_SETUP) {
      await this.ensureStoreSetup({ storeId, size: meta.size });
    } else {
      await this.restart(store.uuid);
      await this.exec(store.uuid, 'configure', {});
    }
    await this.revokeOldMailKey(current, want);
    return had ? 'updated' : 'created';
  }

  private async removeEnv(uuid: string, key: string) {
    const envs = await this.coolify.listEnvs(uuid);
    for (const env of envs.filter((e) => e.key === key)) await this.coolify.deleteEnv(uuid, env.uuid);
  }

  async setDomains({ storeId, mainDomain, redirectDomains, mail }: Parameters<Provisioner['setDomains']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.coolify.updateService(store.uuid, { urls: urlsFor([mainDomain, ...redirectDomains]) });
    // The new sender rides on this restart. A store that never had mail settings needs a new compose
    // for them first, which ensureStoreMail gives it.
    const current = mail && this.config.mail ? await this.coolify.listEnvs(store.uuid) : [];
    const want = mail && current.some((e) => e.key === MAIL_ENV) ? await this.mailChange(storeId, current, mail) : null;
    if (want) await this.coolify.setEnvs(store.uuid, want);
    await this.restart(store.uuid);
    await this.exec(store.uuid, 'configure', { home: https(mainDomain) });
    if (want) await this.revokeOldMailKey(current, want);
  }

  async updateStore({ storeId, wpOptions, phpConstants, size }: Parameters<Provisioner['updateStore']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    // A new size is a new compose file (resources and quotas). With the restart and configure below the store also
    // has the current setup; the description says both once the store runs them.
    const resized: StoreMeta | undefined = size && { ...this.storeMeta(store), setup: STORE_SETUP, size };
    if (resized) await this.coolify.updateService(store.uuid, { docker_compose_raw: await this.storeCompose(resized) });
    if (phpConstants) {
      // The complete set (see Provisioner.updateStore); Coolify's API does not hand values back to merge with.
      await this.coolify.setEnvs(store.uuid, { WAAS_CONSTANTS_B64: encodeConstants(phpConstants) });
    }
    if (resized || phpConstants) await this.restart(store.uuid);
    if (resized || (wpOptions && Object.keys(wpOptions).length)) await this.exec(store.uuid, 'configure', wpOptions ? { options: wpOptions } : {});
    if (resized) await this.coolify.updateService(store.uuid, { description: formatMeta(resized) });
  }

  /**
   * The agent script comes with the store's compose file, so a store set up before email packs has neither the
   * mail-packs operation nor a plan mu-plugin that counts packs: it is brought to the current setup first (one
   * restart), as the next API start would.
   */
  async setEmailPacks({ storeId, purchased }: { storeId: string; purchased: number }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = this.storeMeta(store);
    if ((meta.setup ?? 1) < STORE_SETUP) await this.ensureStoreSetup({ storeId, size: meta.size });
    await this.exec(store.uuid, 'mail-packs', { purchased });
  }

  /** As setEmailPacks: a store set up before the platform counted its email is brought to the current setup first. */
  async setMailCount({ storeId, month, sent }: { storeId: string; month: string; sent: number }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = this.storeMeta(store);
    if ((meta.setup ?? 1) < STORE_SETUP) await this.ensureStoreSetup({ storeId, size: meta.size });
    await this.exec(store.uuid, 'mail-count', { month, sent });
  }

  async moveStore({ storeId, targetVersionId, ownCode }: Parameters<Provisioner['moveStore']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const version = await this.versionMeta(targetVersionId);
    // The agent's files are not reinstalled here, so the store keeps its setup for ensureStoreSetup to finish.
    // It keeps its size too.
    const current = parseMeta(store.description);
    const size = current?.kind === 'store' ? current.size : DEFAULT_SIZE;
    await this.coolify.updateService(store.uuid, {
      description: formatMeta({ kind: 'store', versionId: targetVersionId, setup: current?.kind === 'store' ? current.setup : 1, size }),
      docker_compose_raw: b64(renderCompose({ ...version, size })),
    });
    await this.restart(store.uuid);
    if (!ownCode) await this.exec(store.uuid, 'code-import', { url: this.s3.presign('GET', keys.code(targetVersionId)) });
    await this.exec(store.uuid, 'update-db', {});
  }

  async snapshotStore({ storeId, snapshotId }: { storeId: string; snapshotId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'snapshot', { url: this.s3.presign('PUT', keys.snapshot(snapshotId)) });
  }

  async restoreStore({ storeId, snapshotId, ownCode }: Parameters<Provisioner['restoreStore']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = parseMeta(store.description);
    // Keep the store's current main domain: read it from WordPress before replacing the database.
    const home = await this.currentHome(store.uuid);
    await this.exec(store.uuid, 'restore', { url: this.s3.presign('GET', keys.snapshot(snapshotId)), home });
    if (meta?.kind === 'store' && !ownCode) await this.exec(store.uuid, 'code-import', { url: this.s3.presign('GET', keys.code(meta.versionId)) });
  }

  async rollbackStore({ storeId, backupId, wpOptions, mainDomain, ownCode }: Parameters<Provisioner['rollbackStore']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = parseMeta(store.description);
    if (meta?.kind !== 'store') throw new Error(`Coolify: ${store.name} has no store metadata`);
    if ((await this.s3.head(keys.backup(backupId))) === null) throw new Error(`No archive at ${keys.backup(backupId)}`);
    // Keep the store's current main domain: read it from WordPress before replacing the database.
    // A store whose WordPress is gone (an emptied volume) has none, so it takes its main domain on record.
    // The agent keeps the suspension flag and page across the restore.
    const home = await this.currentHome(store.uuid, mainDomain);
    await this.exec(store.uuid, 'restore', { url: this.s3.presign('GET', keys.backup(backupId)), home });
    // The code of the version the store runs now (unless it keeps its own), and its database brought up to that WordPress.
    if (!ownCode) await this.exec(store.uuid, 'code-import', { url: this.s3.presign('GET', keys.code(meta.versionId)) });
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

  // Sites moved in

  async createImportUpload({ storeId, expiresInSeconds }: { storeId: string; expiresInSeconds: number }) {
    return this.s3.presign('PUT', keys.import(storeId), expiresInSeconds);
  }

  async importSize({ storeId }: { storeId: string }) {
    return this.s3.head(keys.import(storeId));
  }

  async deleteImport({ storeId }: { storeId: string }) {
    await this.s3.delete(keys.import(storeId));
  }

  async suspendStore({ storeId, brand }: { storeId: string; brand?: Brand }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'suspend', { brand: brand ?? this.config.brand ?? DEFAULT_BRAND });
  }

  async resumeStore({ storeId }: { storeId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'resume', {});
  }

  async goLive({ storeId }: { storeId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'go-live', {});
  }

  async passwordLink({ storeId, email }: { storeId: string; email: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const { url } = await this.exec(store.uuid, 'password-link', { email });
    if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error(`Store ${storeId}: no password link`);
    return url;
  }

  async deleteStore({ storeId }: { storeId: string }) {
    // The store's own relay key goes first: once the Service is gone, so is the record of its id.
    const store = this.config.mailKeys && (await this.findService(STORES_ENV, storeName(storeId)));
    const keyId = store ? envValue(await this.coolify.listEnvs(store.uuid), MAIL_KEY_ENV) : undefined;
    if (keyId) await this.config.mailKeys!.delete(keyId);
    await this.deleteService(STORES_ENV, storeName(storeId));
  }

  /**
   * The test store is an ordinary store Service named after the test (store-restore-test-<id>) on a
   * domain that never resolves, with no mail relay or site key. It is never configured, so its agent runs
   * no cron. It is suspended before the backup goes in, so even a request that reached it would get the
   * "unavailable" page.
   */
  async testRestore({ testId, backupId, versionId, size }: Parameters<Provisioner['testRestore']>[0]): Promise<RestoreTestResult> {
    const key = keys.backup(backupId);
    if ((await this.s3.head(key)) === null) throw new Error(`No archive at ${key}`);
    const version = await this.versionMeta(versionId);
    const domain = restoreTestDomain(testId);
    let failed = false;
    try {
      const uuid = await this.ensureService({
        envName: STORES_ENV,
        name: storeName(restoreTestStoreId(testId)),
        meta: { kind: 'store', versionId, size },
        wordPressVersion: version.wordPressVersion,
        phpVersion: version.phpVersion,
        size,
        domains: [domain],
        envs: { WAAS_CONSTANTS_B64: encodeConstants({}) },
      });
      await this.exec(uuid, 'suspend', { brand: this.config.brand ?? DEFAULT_BRAND });
      await this.exec(uuid, 'restore', { url: this.s3.presign('GET', key), home: https(domain) });
      const found = await this.exec(uuid, 'verify', {});
      return {
        name: typeof found.name === 'string' ? found.name : null,
        home: typeof found.home === 'string' ? found.home : null,
        tables: Number(found.tables ?? 0),
        posts: Number(found.posts ?? 0),
      };
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      // The restore's own error matters more; a test store left behind is deleted on the next run.
      await this.deleteRestoreTest({ testId }).catch((err: unknown) => {
        if (!failed) throw err;
      });
    }
  }

  async deleteRestoreTest({ testId }: { testId: string }) {
    await this.deleteService(STORES_ENV, storeName(restoreTestStoreId(testId)));
  }
}

const restoreTestStoreId = (testId: string) => `restore-test-${testId}`;
/** .invalid never resolves (RFC 2606), so no visitor can reach a test store. */
const restoreTestDomain = (testId: string) => `restore-test-${testId}.invalid`;

/** Every container runs and none is unhealthy or still starting. */
function allHealthy(statuses: string[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s.startsWith('running') && !s.includes('unhealthy') && !s.includes('starting'));
}

export function formatMeta(meta: VersionMeta | StoreMeta): string {
  return meta.kind === 'version'
    ? `WaaS version, WordPress ${meta.wordPressVersion}, PHP ${meta.phpVersion}`
    : `WaaS store, version ${meta.versionId}, setup ${meta.setup ?? STORE_SETUP}, size ${meta.size}`;
}

export function parseMeta(description: string | null | undefined): VersionMeta | StoreMeta | null {
  const version = /^WaaS version, WordPress ([\d.]+), PHP ([\d.]+)$/.exec(description ?? '');
  if (version) return { kind: 'version', wordPressVersion: version[1]!, phpVersion: version[2]! };
  const store = /^WaaS store, version ([\w-]+)(?:, setup (\d+))?(?:, size (\w+))?$/.exec(description ?? '');
  if (!store) return null;
  const size = store[3] ?? DEFAULT_SIZE;
  // A size this API does not know (a newer one's) is no metadata it can act on.
  return isSize(size) ? { kind: 'store', versionId: store[1]!, setup: Number(store[2] ?? 1), size } : null;
}

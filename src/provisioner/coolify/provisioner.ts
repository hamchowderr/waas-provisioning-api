import { randomBytes } from 'node:crypto';
import type { CreateStoreInput, PhpConstant, Provisioner } from '../provisioner.ts';
import { S3, type S3Config } from '../s3.ts';
import { CoolifyClient, type CoolifyService } from './client.ts';
import { decodeConstants, encodeConstants, renderCompose } from './compose.ts';

export interface CoolifyProvisionerConfig {
  /** e.g. https://coolify.otakusolutions.io */
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
  /** How long one agent command may run. */
  taskTimeoutSeconds?: number;
  pollMs?: number;
}

const STORES_ENV = 'stores';
const VERSIONS_ENV = 'versions';
/** Feb 31st: an on-demand task's schedule never fires. */
const NEVER = '0 0 31 2 *';

/**
 * What the driver keeps in a Service's description, so it needs no table of its own. Coolify
 * allows only letters, digits, spaces and some punctuation there (no JSON), hence a plain format:
 * "WaaS version, WordPress 6.8, PHP 8.3" or "WaaS store, version <id>".
 */
export interface VersionMeta {
  kind: 'version';
  wordPressVersion: string;
  phpVersion: string;
}
export interface StoreMeta {
  kind: 'store';
  versionId: string;
}

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
 * behind it: docs/adr/0001-coolify-provisioner.md.
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
    await this.coolify.startService(service.uuid);
    await this.waitHealthy(service.uuid);
    return service.uuid;
  }

  /** Waits until every container of the Service runs and none is unhealthy. */
  async waitHealthy(uuid: string): Promise<void> {
    const deadline = Date.now() + (this.config.deployTimeoutMs ?? 10 * 60_000);
    let last = 'unknown';
    for (;;) {
      const service = await this.coolify.getService(uuid);
      const statuses = [...(service.applications ?? []), ...(service.databases ?? [])].map((c) => c.status ?? '');
      if (!statuses.length && service.status) statuses.push(service.status);
      last = statuses.join(', ') || 'unknown';
      if (statuses.length && statuses.every((s) => s.startsWith('running') && !s.includes('unhealthy') && !s.includes('starting'))) {
        // The agent is the last container up; a ping confirms it can run commands.
        await this.exec(uuid, 'ping', {});
        return;
      }
      if (Date.now() > deadline) break;
      await this.sleep(this.pollMs);
    }
    throw new Error(`Coolify: service ${uuid} did not become healthy (${last})`);
  }

  private async restart(uuid: string) {
    await this.coolify.restartService(uuid);
    await this.sleep(this.pollMs);
    await this.waitHealthy(uuid);
  }

  /**
   * Runs one agent operation in the Service's agent container: an on-demand scheduled task,
   * deleted afterwards because its command carries pre-signed URLs.
   */
  async exec(uuid: string, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const timeout = this.config.taskTimeoutSeconds ?? 1800;
    const task = await this.coolify.createTask(uuid, {
      name: `waas-${op}-${randomBytes(4).toString('hex')}`,
      command: `php /tmp/waas-agent.php ${op} ${b64(JSON.stringify(args))}`,
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
    if (phpConstants && Object.keys(phpConstants).length) {
      const current = (await this.coolify.listEnvs(store.uuid)).find((e) => e.key === 'WAAS_CONSTANTS_B64');
      const merged = { ...decodeConstants(current?.real_value ?? current?.value), ...Object.fromEntries(Object.entries(phpConstants).map(([k, c]) => [k, c.value])) };
      await this.coolify.setEnvs(store.uuid, { WAAS_CONSTANTS_B64: encodeConstants({}, merged) });
      await this.restart(store.uuid);
    }
    if (wpOptions && Object.keys(wpOptions).length) await this.exec(store.uuid, 'configure', { options: wpOptions });
  }

  async moveStore({ storeId, targetVersionId }: { storeId: string; targetVersionId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const version = await this.versionMeta(targetVersionId);
    await this.coolify.updateService(store.uuid, {
      description: formatMeta({ kind: 'store', versionId: targetVersionId }),
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

  private async currentHome(uuid: string): Promise<string> {
    const result = await this.exec(uuid, 'home', {});
    if (typeof result.home !== 'string') throw new Error('Store agent did not report the home URL');
    return result.home;
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

  async suspendStore({ storeId }: { storeId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'suspend', {});
  }

  async resumeStore({ storeId }: { storeId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'resume', {});
  }

  async deleteStore({ storeId }: { storeId: string }) {
    await this.deleteService(STORES_ENV, storeName(storeId));
  }
}

export function formatMeta(meta: VersionMeta | StoreMeta): string {
  return meta.kind === 'version' ? `WaaS version, WordPress ${meta.wordPressVersion}, PHP ${meta.phpVersion}` : `WaaS store, version ${meta.versionId}`;
}

export function parseMeta(description: string | null | undefined): VersionMeta | StoreMeta | null {
  const version = /^WaaS version, WordPress ([\d.]+), PHP ([\d.]+)$/.exec(description ?? '');
  if (version) return { kind: 'version', wordPressVersion: version[1]!, phpVersion: version[2]! };
  const store = /^WaaS store, version ([\w-]+)$/.exec(description ?? '');
  return store ? { kind: 'store', versionId: store[1]! } : null;
}

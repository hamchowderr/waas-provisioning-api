import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_SIZE, isSize, type Size } from '../../plans.ts';
import { ImportPartsError, storeFromAddress, type Brand, type CreateStoreInput, type Provisioner, type RestoreTestResult, type MoveReport, type SiteCheck, type StoreMailFrom } from '../provisioner.ts';
import { S3, type S3Config } from '../s3.ts';
import type { StoreMailKeys } from '../../tosend.ts';
import { CoolifyClient, CoolifyError, type CoolifyEnv, type CoolifyService, type CoolifyTask } from './client.ts';
import { AGENT_GZ, AGENT_SCRIPT, encodeConstants, renderCompose } from './compose.ts';
import { readZipEntry } from '../../zipentry.ts';
import { step, type StepKey } from '../../progress.ts';

/**
 * Where Service uuids are kept between restarts (src/coolifyids.ts), keyed by "<environment id>/<name>".
 * With it, a lookup never needs Coolify's full Service list once every existing Service was saved once.
 */
export interface ServiceIdStore {
  /** The saved uuid; null when a create was started and its uuid not saved; undefined when there is no row. */
  get(key: string): Promise<string | null | undefined>;
  set(key: string, uuid: string | null): Promise<void>;
  delete(key: string): Promise<void>;
  /** True once `seed` has run. */
  isSeeded(): Promise<boolean>;
  /** Saves every Service from a full list and marks the store seeded. */
  seed(entries: [string, string][]): Promise<void>;
}

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
  /** Keeps Service uuids between restarts. Unset: kept in memory only, so each restart lists once. */
  serviceIds?: ServiceIdStore;
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
   * The store's site key (src/sitekeys.ts), given to it as ANYPRESS_SITE_KEY so AnyPress Client accepts the
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

/** WAAS_CONSTANTS_B64 (encodeConstants) read back as phpConstants; nothing when it is missing or unreadable. */
function decodeConstants(value: string | undefined): Record<string, { value: string }> {
  try {
    const plain = JSON.parse(Buffer.from(unquote(value) ?? '', 'base64').toString('utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(plain).map(([name, v]) => [name, { value: String(v) }]));
  } catch {
    return {};
  }
}
const domainOf = (address: string | undefined) => address?.split('@')[1]?.toLowerCase();
const decodeMail = (value: string | undefined): Partial<StoreMail> | null => {
  try {
    return value ? JSON.parse(Buffer.from(value, 'base64').toString()) : null;
  } catch {
    return null;
  }
};

const STORES_ENV = 'stores';
const VERSIONS_ENV = 'versions';
/** On-demand tasks are created disabled; Coolify still wants a valid schedule (it rejects Feb 31st). */
const NEVER = '0 0 1 1 *';
const AGENT = 'php /tmp/waas-agent.php';
/** Coolify stores a scheduled task's command in a varchar(255). */
const MAX_COMMAND = 255;
/** The progress step each long agent command is (src/progress.ts); quick ones aren't shown. */
const OP_STEPS: Partial<Record<string, StepKey>> = {
  restore: 'restore',
  'code-import': 'code',
  'update-db': 'database',
  configure: 'configure',
  'check-site': 'check',
  snapshot: 'backup',
  'site-download': 'backup',
};
const STAGE_CHUNK = 200;
/** What a task's output says when Coolify ran it in the database or WordPress container: the agent never started. */
const WRONG_CONTAINER = /php: not found|Could not open input file: \/tmp\/waas-agent\.php/;
/** Tries per agent command when it keeps landing in the wrong container. */
const WRONG_CONTAINER_ATTEMPTS = 4;

class WrongContainerError extends Error {}
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
  /** Whether the store has its own Redis object cache (renderCompose's `cache`): its site type wants one (CACHED_SITE_TYPES). */
  cache?: boolean;
}

/** Site types whose stores get their own Redis object cache: their visitors are mostly logged-in members. */
const CACHED_SITE_TYPES = ['community', 'everything'];

/** Whether a store with these phpConstants gets an object cache (its ANYPRESS_TENANT_ROLES). */
function wantsCache(phpConstants: Record<string, { value: string }> | null | undefined): boolean {
  const roles = phpConstants?.ANYPRESS_TENANT_ROLES?.value ?? '';
  return roles.split(',').some((type) => CACHED_SITE_TYPES.includes(type.trim()));
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
 * 12: https://<each store domain>/assistant goes to the website assistant's panel (assistantLabels in compose.ts).
 * 13: at /.assistant instead, an address no WordPress page can have, so no page of the store is hidden behind it.
 * 14: the agent's update-plugin operation, which pushes AnyPress Host to storefronts (src/hostupdates.ts). The agent
 *    script travels in the compose file, so a new operation reaches a store only with a new setup or a move.
 * 15: update-plugin also switches the plugin on when its new folder is already there but active_plugins still names
 *    an older folder (a storefront moved onto a version that has AnyPress Host).
 * 16: the agent's crm-prospects operation, which writes prospect finder results into a storefront's FluentCRM
 *    (src/prospectcrm.ts).
 * 17: the outreach mu-plugin (an email to a FluentCRM "Prospect" goes only through the seller's own mailbox, never the
 *    relay) and the agent's outreach-mailbox operation (src/outreach.ts).
 * 18: the outreach mu-plugin starts prospects on the Sales Kit's outreach automations a few a day and stops them when
 *    tagged Replied or Customer, and the agent's crm-automation operation makes those automations (src/outreachautomation.ts).
 * 19: the guard mu-plugin answers a signed preview link (?anypress_preview=) on any of the store's addresses instead
 *    of redirecting it to the main domain, so AI apps can frame previews from the platform address.
 * 20: community and everything stores get their own Redis object cache (renderCompose's `cache`), and every store the
 *    agent's object-cache.php drop-in, which uses it where there is one (install_object_cache in agent.php).
 * 21: server settings from WordPress's hosting handbook and the plugins' own docs: memory per size for its workers,
 *    PHP's memory, upload and OPcache limits, cron every minute, security and browser-caching headers,
 *    DISALLOW_FILE_EDIT, and the login safety mu-plugin (FluentAuth's XML-RPC and REST usernames off, once).
 * 22: Nginx in front of PHP-FPM instead of Apache (renderCompose): the `wordpress` service, which keeps the store's
 *    domains, is Nginx, and WordPress runs in a new `php` service with the size's workers.
 * 23: community and everything stores take uploads up to 512 MB (renderCompose's uploadMb), for members' videos.
 * 24: storage 10 / 20 / 30 GB by size (plans.ts), and storage packs: the plan mu-plugin adds the packs' storage
 *    (the agent's storage-packs operation) to the plan's.
 * 25: Nginx hides readme.html, license.txt and wp-config-sample.php, which name WordPress's version.
 */
export const STORE_SETUP = 25;

const storeName = (storeId: string) => `store-${storeId}`;
const versionName = (versionId: string) => `version-${versionId}`;
const https = (domain: string) => `https://${domain}`;
const urlsFor = (domains: string[]) => [{ name: 'wordpress', url: domains.map(https).join(',') }];
const assistantFor = (storeId: string, domains: string[]) => ({ router: `${storeName(storeId)}-assistant`, domains });
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
  /** A photo in a demo draft (src/demodrafts.ts). */
  demoImage: (draftId: string, name: string) => `demos/${draftId}/${name}`,
  /** A file of a prospect's branded demo (src/prospectdemos.ts). */
  prospectFile: (code: string, name: string) => `prospects/${code}/${name}`,
  /** A version's plugin choices with signed links to their zips, for the agent's plugins step. */
  pluginChoices: (versionId: string) => `versions/${versionId}/plugin-choices.json`,
  backup: (id: string) => `backups/${id}.zip`,
  /** A copy of a store for its owner to download (downloadStore), deleted after a week. */
  download: (id: string) => `downloads/${id}.zip`,
  /** A site being moved in: a zip or a gzipped tar, so no extension. */
  import: (storeId: string) => `imports/${storeId}`,
  /** Businesses for a store's FluentCRM (addCrmProspects), read once by its agent. */
  crmBatch: (id: string) => `crm/${id}.json`,
  /** The seller's mailbox for setOutreachMailbox, read once by the store's agent: it holds a password. */
  mailbox: (id: string) => `crm/mailbox-${id}.json`,
  /** An outreach plan for addOutreachAutomation, read once by the store's agent. */
  automation: (id: string) => `crm/automation-${id}.json`,
  /** The current agent script, gzipped, for swapAgent; named by its hash, so it never changes once stored. */
  agent: (sha: string) => `agents/${sha}.gz`,
};

/** The agent script's hash: what swapAgent checks the downloaded script against. */
const AGENT_SHA = createHash('sha256').update(AGENT_SCRIPT).digest('hex');

/** A compose file without the agent's code: two that match differ in nothing but the agent script. */
const withoutAgent = (compose: string) => compose.replace(/WAAS_AGENT_GZ: \S+/, 'WAAS_AGENT_GZ: -').trim();

/** A PHP single-quoted string. */
const phpString = (value: string) => `'${value.replace(/[\\']/g, '\\$&')}'`;

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
  /**
   * Service uuids by environment and name. A Service keeps its uuid for life, so after the first full
   * list a lookup reads only that one Service: Coolify's full list (every store's compose file, many
   * megabytes) is slow for Coolify to build on the same server the stores run on.
   */
  private readonly serviceUuids = new Map<string, string>();
  private seeded = false;

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

  private async serviceKey(envName: string, name: string) {
    return `${await this.environmentId(envName)}/${name}`;
  }

  /** True once every existing Service's uuid is saved, so a Service with no saved uuid doesn't exist. */
  private async allSaved(): Promise<boolean> {
    if (!this.seeded && this.config.serviceIds) this.seeded = await this.config.serviceIds.isSeeded();
    return this.seeded;
  }

  /**
   * The Service with this name in this project's environment, if any. Reads the one Service by its
   * saved uuid. Coolify's full list (every Service's compose file, many megabytes) is read only before
   * the uuids were first saved, or to find a Service whose create stopped before its uuid was saved.
   */
  async findService(envName: string, name: string): Promise<CoolifyService | null> {
    const envId = await this.environmentId(envName);
    const key = `${envId}/${name}`;
    const ids = this.config.serviceIds;
    let known = this.serviceUuids.get(key);
    if (known === undefined && ids) {
      const saved = await ids.get(key);
      if (saved) known = saved;
      else if (saved === undefined && (await this.allSaved())) return null;
    }
    if (known) {
      try {
        const service = await this.coolify.getService(known);
        if (service.name === name && service.environment_id === envId && !(service as { deleted_at?: string | null }).deleted_at) {
          this.serviceUuids.set(key, known);
          return service;
        }
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
      }
      this.serviceUuids.delete(key);
      if (ids) {
        await ids.delete(key);
        if (await this.allSaved()) return null;
      }
    }
    const services = await this.coolify.listServices();
    const entries: [string, string][] = [];
    for (const s of services) {
      if (s.environment_id === undefined) continue;
      this.serviceUuids.set(`${s.environment_id}/${s.name}`, s.uuid);
      entries.push([`${s.environment_id}/${s.name}`, s.uuid]);
    }
    const found = services.find((s) => s.name === name && s.environment_id === envId) ?? null;
    if (ids) {
      await ids.seed(entries);
      this.seeded = true;
      // A create that stopped before Coolify made the Service: nothing to find next time either.
      if (!found) await ids.delete(key);
    }
    return found;
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

  /**
   * A store's compose file, from its version's WordPress and PHP, its size and its domains, as the Service's
   * docker_compose_raw. Without `domains`, the ones the Service has now.
   */
  private async storeCompose(storeId: string, meta: StoreMeta, uuid: string, domains?: string[]): Promise<string> {
    return b64(await this.storeComposeText(storeId, meta, uuid, domains));
  }

  private async storeComposeText(storeId: string, meta: StoreMeta, uuid: string, domains?: string[]): Promise<string> {
    const hosts = domains ?? (await this.serviceDomains(uuid));
    return renderCompose({ ...(await this.versionMeta(meta.versionId)), size: meta.size, cache: meta.cache, assistant: assistantFor(storeId, hosts) });
  }

  /** The domains a store's Service answers on (its wordpress URLs). */
  private async serviceDomains(uuid: string): Promise<string[]> {
    const service = await this.coolify.getService(uuid);
    const fqdn = service.applications?.find((a) => a.name === 'wordpress')?.fqdn ?? '';
    return fqdn
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean)
      .map((url) => new URL(url).hostname);
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
    /** A store's object cache (StoreMeta's `cache`). */
    cache?: boolean;
    domains: string[];
    /** Plain http: Coolify then asks for no TLS certificate (a restore test's .invalid name can't get one). */
    plainHttp?: boolean;
    envs: Record<string, string>;
  }): Promise<string> {
    let service = await this.findService(input.envName, input.name);
    if (!service) {
      const key = await this.serviceKey(input.envName, input.name);
      // Saved before the create, so a job stopped right after it lists once and finds the Service.
      await this.config.serviceIds?.set(key, null);
      const created = await this.coolify.createService({
        name: input.name,
        description: formatMeta(input.meta),
        project_uuid: this.config.projectUuid,
        environment_name: input.envName,
        server_uuid: this.config.serverUuid,
        docker_compose_raw: b64(
          renderCompose({
            ...input,
            assistant: input.meta.kind === 'store' && !input.plainHttp ? { router: `${input.name}-assistant`, domains: input.domains } : undefined,
          }),
        ),
        urls: input.plainHttp ? [{ name: 'wordpress', url: input.domains.map((d) => `http://${d}`).join(',') }] : urlsFor(input.domains),
        // Variables first, then start.
        instant_deploy: false,
      });
      service = { uuid: created.uuid, name: input.name };
      this.serviceUuids.set(key, created.uuid);
      await this.config.serviceIds?.set(key, created.uuid);
    }
    if (Object.keys(input.envs).length) await this.coolify.setEnvs(service.uuid, input.envs);
    await this.coolify.startService(service.uuid).catch((err: unknown) => {
      // A retried job finds the Service it created last time already up; that is the goal anyway.
      if (!(err instanceof CoolifyError && err.status === 400 && /already running/i.test(err.message))) throw err;
    });
    step('start');
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
    step('start');
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
    const named = OP_STEPS[op];
    if (named) step(named);
    try {
      return await this.execOnce(uuid, op, args);
    } catch (err) {
      // An agent older than this API (its container restarted outside Coolify after a swapAgent): swap again, once.
      if (!(err instanceof Error && /unknown operation/.test(err.message)) || !(await this.swapAgent(uuid))) throw err;
      return this.execOnce(uuid, op, args);
    }
  }

  private async execOnce(uuid: string, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = b64(JSON.stringify(args));
    const direct = `${AGENT} ${op} ${payload}`;
    if (direct.length <= MAX_COMMAND) return this.runTask(uuid, op, direct);
    const id = randomBytes(6).toString('hex');
    for (let i = 0; i < payload.length; i += STAGE_CHUNK) {
      await this.runTask(uuid, 'stage', `${AGENT} stage ${id} ${payload.slice(i, i + STAGE_CHUNK)}`);
    }
    return this.runTask(uuid, op, `${AGENT} ${op} @${id}`);
  }

  /**
   * Runs one agent command, again when Coolify ran it in the wrong container. Coolify runs a task in whichever
   * container is the only one it has as running, whatever the task's container name, and its statuses lag just
   * after a start: a new store's command then lands in MariaDB (`php: not found`) or WordPress (no agent
   * script), where nothing runs. Each time, wait until every container is up again and send it once more.
   */
  private async runTask(uuid: string, op: string, command: string): Promise<Record<string, unknown>> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runTaskOnce(uuid, op, command);
      } catch (err) {
        if (!(err instanceof WrongContainerError) || attempt >= WRONG_CONTAINER_ATTEMPTS) throw err;
        await this.sleep(this.pollMs);
        await this.waitRunning(uuid);
      }
    }
  }

  /** Waits until Coolify has every container of the Service as running, without the agent ping waitHealthy sends. */
  private async waitRunning(uuid: string): Promise<void> {
    const deadline = Date.now() + (this.config.deployTimeoutMs ?? 10 * 60_000);
    while (!allHealthy(await this.statuses(uuid))) {
      if (Date.now() > deadline) return;
      await this.sleep(this.pollMs);
    }
  }

  private async runTaskOnce(uuid: string, op: string, command: string): Promise<Record<string, unknown>> {
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
          if (!result && WRONG_CONTAINER.test(output)) throw new WrongContainerError(`Store agent ${op} ran outside the agent container: ${error}`);
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
    // Deletion is queued in Coolify; wait until the Service is gone.
    const deadline = Date.now() + (this.config.deployTimeoutMs ?? 10 * 60_000);
    for (;;) {
      try {
        const left = await this.coolify.getService(service.uuid);
        if ((left as { deleted_at?: string | null }).deleted_at) break;
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
        break;
      }
      if (Date.now() > deadline) throw new Error(`Coolify: ${name} was not deleted in time`);
      await this.sleep(this.pollMs);
    }
    const key = await this.serviceKey(envName, name);
    this.serviceUuids.delete(key);
    await this.config.serviceIds?.delete(key);
  }

  // Versions

  async createUploadUrl({ versionId, asZip }: { versionId: string; asZip: boolean }) {
    return await this.s3.presign('PUT', keys.upload(versionId, asZip), 3600);
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
    await this.exec(uuid, 'restore', { url: await this.s3.presign('GET', sourceKey), home: https(input.domain), title: 'Version site' });
    // Always run: it also undoes choices an earlier version applied to the archive this one comes from. The
    // choices, with a signed link to each zip, go in a file the agent fetches: too long for task commands.
    let pluginArgs: Record<string, unknown> = { plugins: [] };
    if (input.plugins?.length) {
      const plugins = await Promise.all(
        input.plugins.map(async (p) =>
          p.action === 'add' ? { ...p, url: await this.s3.presign('GET', p.uploadId ? keys.pluginUpload(p.uploadId) : keys.plugin(p.slug, p.version!), 3600) } : p,
        ),
      );
      await this.s3.put(keys.pluginChoices(input.versionId), new TextEncoder().encode(JSON.stringify({ plugins })), 'application/json');
      pluginArgs = { manifest: await this.s3.presign('GET', keys.pluginChoices(input.versionId)) };
    }
    // The manifest can hold licence keys, so it's removed as soon as the agent has read it.
    const applied = await this.exec(uuid, 'plugins', pluginArgs).finally(() => (input.plugins?.length ? this.s3.delete(keys.pluginChoices(input.versionId)) : undefined));
    await this.exec(uuid, 'code-export', { url: await this.s3.presign('PUT', keys.code(input.versionId)) });
    return { pluginFiles: (applied.files ?? {}) as Record<string, string> };
  }

  async storePluginPackage({ slug, version, body }: { slug: string; version: string; body: Uint8Array }) {
    if ((await this.s3.head(keys.plugin(slug, version))) !== null) return;
    await this.s3.put(keys.plugin(slug, version), body, 'application/zip');
  }

  async createPluginUpload({ uploadId }: { uploadId: string }) {
    return { uploadUrl: await this.s3.presign('PUT', keys.pluginUpload(uploadId), 3600) };
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

  async createDemoImageUpload({ draftId, name, expiresInSeconds }: { draftId: string; name: string; expiresInSeconds: number }) {
    return this.s3.presign('PUT', keys.demoImage(draftId, name), expiresInSeconds);
  }

  async demoImageSize({ draftId, name }: { draftId: string; name: string }) {
    return this.s3.head(keys.demoImage(draftId, name));
  }

  async demoImageUrl({ draftId, name, expiresInSeconds }: { draftId: string; name: string; expiresInSeconds: number }) {
    return this.s3.presign('GET', keys.demoImage(draftId, name), expiresInSeconds);
  }

  async deleteDemoDraft({ draftId, names }: { draftId: string; names: string[] }) {
    for (const name of names) await this.s3.delete(keys.demoImage(draftId, name));
  }

  async putProspectFile({ code, name, body, contentType }: { code: string; name: string; body: Uint8Array; contentType: string }) {
    await this.s3.put(keys.prospectFile(code, name), body, contentType);
  }

  async readProspectFile({ code, name }: { code: string; name: string }) {
    return this.s3.getIfExists(keys.prospectFile(code, name));
  }

  async deleteProspectFiles({ code, names }: { code: string; names: string[] }) {
    for (const name of names) await this.s3.delete(keys.prospectFile(code, name));
  }

  async deleteVersion({ versionId }: { versionId: string }) {
    await this.deleteService(VERSIONS_ENV, versionName(versionId));
    await this.s3.delete(keys.code(versionId));
    await this.s3.delete(keys.pluginChoices(versionId));
    await this.s3.delete(keys.upload(versionId, true));
    await this.s3.delete(keys.upload(versionId, false));
  }

  async readVersionRoles({ versionId }: { versionId: string }) {
    const key = keys.code(versionId);
    const size = await this.s3.head(key);
    if (size === null) return null;
    const read = async (start: number, end: number) => Buffer.from(await this.s3.getRange(key, start, end));
    const bytes = await readZipEntry(read, size, 'wp-content/plugins/anypress-client-data/roles.json', 1024 * 1024);
    return bytes ? (JSON.parse(bytes.toString('utf8')) as unknown) : null;
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
    return { uploadUrl: await this.s3.presign('PUT', keys.base(baseSnapshotId), 3600), uri: this.s3.objectUrl(keys.base(baseSnapshotId)) };
  }

  async putBaseSnapshot({ baseSnapshotId, body }: { baseSnapshotId: string; body: Uint8Array }) {
    await this.s3.put(keys.base(baseSnapshotId), body, 'application/zip');
  }

  async deleteBaseSnapshot({ baseSnapshotId }: { baseSnapshotId: string }) {
    await this.s3.delete(keys.base(baseSnapshotId));
  }

  async snapshotUpload({ versionId, snapshotId }: { versionId: string; snapshotId: string }) {
    const version = await this.requireService(VERSIONS_ENV, versionName(versionId));
    await this.exec(version.uuid, 'snapshot', { url: await this.s3.presign('PUT', keys.snapshot(snapshotId)) });
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
  private async buildStore(input: Omit<CreateStoreInput, 'snapshotId'>, sourceKey: string, imported = false): Promise<{ check?: SiteCheck; moved?: MoveReport }> {
    const version = await this.versionMeta(input.versionId);
    // A site copied with Reprint has no archive: the agent fetches it from its host.
    const reprint = imported ? input.reprint : undefined;
    if (!reprint && (await this.s3.head(sourceKey)) === null) throw new Error(`No archive at ${sourceKey}`);
    const envs: Record<string, string> = { WAAS_CONSTANTS_B64: encodeConstants(input.phpConstants) };
    const cache = wantsCache(input.phpConstants);
    if (input.user?.password) envs.WAAS_INIT_PASSWORD = input.user.password;
    Object.assign(envs, this.siteKeyEnvs(input.storeId));
    // A retried create finds the Service, and the key it minted, from last time.
    const existing = await this.findService(STORES_ENV, storeName(input.storeId));
    Object.assign(envs, await this.storeMailEnvs(input.storeId, existing ? await this.coolify.listEnvs(existing.uuid) : [], { mailbox: input.mailbox }));
    const uuid = await this.ensureService({
      envName: STORES_ENV,
      name: storeName(input.storeId),
      meta: { kind: 'store', versionId: input.versionId, size: input.size, cache },
      wordPressVersion: version.wordPressVersion,
      phpVersion: version.phpVersion,
      size: input.size,
      cache,
      domains: [input.mainDomain, ...input.redirectDomains],
      envs,
    });
    const home = https(input.mainDomain);
    const hold = imported || input.hold === true;
    let check: SiteCheck | undefined;
    let moved: MoveReport | undefined;
    try {
      const from = reprint ? { reprint: { site: reprint.site, key: reprint.privateKey } } : { url: await this.s3.presign('GET', sourceKey) };
      const restored = await this.exec(uuid, 'restore', { ...from, home, ...(imported && { import: true }), ...(hold && !imported && { hold: true }) });
      if (imported) moved = moveReport(restored);
      if (!input.ownCode && !imported) await this.exec(uuid, 'code-import', { url: await this.s3.presign('GET', keys.code(input.versionId)) });
      // A site from elsewhere may come from an older WordPress than the version runs.
      if (imported) await this.exec(uuid, 'update-db', {});
      // It keeps its own plugins and themes, and gets AnyPress Client (switched on) and what else the version has that it lacks.
      if (input.ownCode || imported) await this.exec(uuid, 'code-import', { url: await this.s3.presign('GET', keys.code(input.versionId)), add: true });
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
    return { ...(check && { check }), ...(moved && Object.keys(moved).length > 0 && { moved }) };
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
   *
   * When the new compose file differs from the Service's only in the agent script (most new setups: new agent
   * operations and mu-plugins) and the store already has its variables, there is no restart: the new script is
   * swapped into the running agent (swapAgent) and the compose file saved for the next restart. If the swap
   * fails, the store is restarted as before.
   */
  async ensureStoreSetup({ storeId, size }: { storeId: string; size: Size }): Promise<'updated' | 'unchanged'> {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = this.storeMeta(store);
    if ((meta.setup ?? 1) >= STORE_SETUP && meta.size === size) return 'unchanged';
    // A store set up before the object cache (setup 20) has no record of it yet: its site types say.
    const cache = (meta.setup ?? 1) >= 20 ? meta.cache : wantsCache(decodeConstants(envValue(await this.coolify.listEnvs(store.uuid), 'WAAS_CONSTANTS_B64')));
    const want: StoreMeta = { ...meta, setup: STORE_SETUP, size, cache };
    const compose = await this.storeComposeText(storeId, want, store.uuid);
    const siteKey = this.siteKeyEnvs(storeId);
    if (await this.onlyAgentChanged(store.uuid, compose, siteKey)) {
      if (await this.swapAgent(store.uuid)) {
        await this.coolify.updateService(store.uuid, { docker_compose_raw: b64(compose) });
        await this.exec(store.uuid, 'configure', {});
        await this.coolify.updateService(store.uuid, { description: formatMeta(want) });
        return 'updated';
      }
    }
    await this.coolify.updateService(store.uuid, { docker_compose_raw: b64(compose) });
    if (Object.keys(siteKey).length) await this.coolify.setEnvs(store.uuid, siteKey);
    await this.restart(store.uuid);
    await this.exec(store.uuid, 'configure', {});
    await this.coolify.updateService(store.uuid, { description: formatMeta(want) });
    return 'updated';
  }

  /** Whether the Service runs `compose` but for the agent script, with these variables already set. */
  private async onlyAgentChanged(uuid: string, compose: string, envs: Record<string, string>): Promise<boolean> {
    const current = (await this.coolify.getService(uuid)).docker_compose_raw;
    if (!current || withoutAgent(current) !== withoutAgent(compose)) return false;
    if (!Object.keys(envs).length) return true;
    const have = await this.coolify.listEnvs(uuid);
    return Object.entries(envs).every(([key, value]) => unquote(envValue(have, key)) === value);
  }

  /**
   * Puts the current agent script into the store's running agent container, without a restart. The script goes
   * through the bucket (far too long for task commands); a small PHP step, staged like long arguments, downloads
   * it, checks its hash and only then replaces /tmp/waas-agent.php. Any agent can run it: it uses only `stage`.
   * The container still holds the old script in its variables until Coolify next restarts it, which then starts it
   * from the saved compose file; a restart outside Coolify (the server rebooting) brings the old script back, and
   * exec swaps the new one in again when an operation is unknown to it. False when it didn't work.
   */
  private async swapAgent(uuid: string): Promise<boolean> {
    try {
      const key = keys.agent(AGENT_SHA);
      if ((await this.s3.head(key)) === null) await this.s3.put(key, Buffer.from(AGENT_GZ, 'base64'), 'application/gzip');
      const step = [
        `$s = @gzdecode((string) @file_get_contents(${phpString(await this.s3.presign('GET', key, 900))}));`,
        `if ($s === false || hash('sha256', $s) !== ${phpString(AGENT_SHA)}) { echo "WAAS_ERROR the agent script did not download\n"; exit(1); }`,
        "if (@file_put_contents('/tmp/waas-agent.new', $s) === false || !@rename('/tmp/waas-agent.new', '/tmp/waas-agent.php')) { echo \"WAAS_ERROR cannot write the agent script\n\"; exit(1); }",
        "echo 'WAAS_RESULT {\"swapped\":true}', \"\n\";",
      ].join('\n');
      const payload = b64(`<?php\n${step}\n`);
      const id = randomBytes(6).toString('hex');
      for (let i = 0; i < payload.length; i += STAGE_CHUNK) await this.runTask(uuid, 'stage', `${AGENT} stage ${id} ${payload.slice(i, i + STAGE_CHUNK)}`);
      await this.runTask(uuid, 'swap-agent', `base64 -d /tmp/waas-args-${id} > /tmp/waas-swap.php && php /tmp/waas-swap.php; rm -f /tmp/waas-args-${id} /tmp/waas-swap.php`);
      return true;
    } catch {
      return false;
    }
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
    if (!had) await this.coolify.updateService(store.uuid, { docker_compose_raw: await this.storeCompose(storeId, this.storeMeta(store), store.uuid) });
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
    const domains = [mainDomain, ...redirectDomains];
    // The website assistant's router follows the store's domains (assistantLabels), on the same restart.
    const meta = parseMeta(store.description);
    const compose = meta?.kind === 'store' ? await this.storeCompose(storeId, meta, store.uuid, domains) : undefined;
    await this.coolify.updateService(store.uuid, { urls: urlsFor(domains), ...(compose ? { docker_compose_raw: compose } : {}) });
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
    const meta = this.storeMeta(store);
    // New site types can bring or take away the object cache, which is a new compose file too.
    const cache = phpConstants ? wantsCache(phpConstants) : meta.cache;
    const resized: StoreMeta | undefined =
      size || !!cache !== !!meta.cache ? { ...meta, setup: STORE_SETUP, size: size ?? meta.size, cache } : undefined;
    if (resized) await this.coolify.updateService(store.uuid, { docker_compose_raw: await this.storeCompose(storeId, resized, store.uuid) });
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

  /** As setEmailPacks: a store set up before storage packs is brought to the current setup first. */
  async setStoragePacks({ storeId, gb }: { storeId: string; gb: number }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = this.storeMeta(store);
    if ((meta.setup ?? 1) < STORE_SETUP) await this.ensureStoreSetup({ storeId, size: meta.size });
    await this.exec(store.uuid, 'storage-packs', { gb });
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
    // The agent's files are not reinstalled here, so the store keeps its setup for ensureStoreSetup to finish.
    // It keeps its size and its domains' website assistant router too.
    const current = parseMeta(store.description);
    const want: StoreMeta = {
      kind: 'store',
      versionId: targetVersionId,
      setup: current?.kind === 'store' ? current.setup : 1,
      size: current?.kind === 'store' ? current.size : DEFAULT_SIZE,
    };
    await this.coolify.updateService(store.uuid, {
      description: formatMeta(want),
      docker_compose_raw: await this.storeCompose(storeId, want, store.uuid),
    });
    await this.restart(store.uuid);
    // A store with its own code takes only the version's AnyPress Client and what it lacks.
    await this.exec(store.uuid, 'code-import', { url: await this.s3.presign('GET', keys.code(targetVersionId)), ...(ownCode && { add: true }) });
    await this.exec(store.uuid, 'update-db', {});
  }

  async snapshotStore({ storeId, snapshotId }: { storeId: string; snapshotId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'snapshot', { url: await this.s3.presign('PUT', keys.snapshot(snapshotId)) });
  }

  async restoreStore({ storeId, snapshotId, ownCode }: Parameters<Provisioner['restoreStore']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const meta = parseMeta(store.description);
    // Keep the store's current main domain: read it from WordPress before replacing the database.
    const home = await this.currentHome(store.uuid);
    await this.exec(store.uuid, 'restore', { url: await this.s3.presign('GET', keys.snapshot(snapshotId)), home });
    if (meta?.kind === 'store') await this.exec(store.uuid, 'code-import', { url: await this.s3.presign('GET', keys.code(meta.versionId)), ...(ownCode && { add: true }) });
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
    await this.exec(store.uuid, 'restore', { url: await this.s3.presign('GET', keys.backup(backupId)), home });
    // The code of the version the store runs now (a store with its own code takes only AnyPress Client and what it lacks), and its database brought up to that WordPress.
    await this.exec(store.uuid, 'code-import', { url: await this.s3.presign('GET', keys.code(meta.versionId)), ...(ownCode && { add: true }) });
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
    const result = await this.exec(store.uuid, 'snapshot', { url: await this.s3.presign('PUT', keys.backup(backupId)) });
    const sizeBytes = (await this.s3.head(keys.backup(backupId))) ?? Number(result.sizeBytes ?? 0);
    return { sizeBytes };
  }

  async downloadStore({ storeId, downloadId }: { storeId: string; downloadId: string }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const result = await this.exec(store.uuid, 'site-download', { url: await this.s3.presign('PUT', keys.download(downloadId), 3600) });
    const sizeBytes = (await this.s3.head(keys.download(downloadId))) ?? Number(result.sizeBytes ?? 0);
    return { sizeBytes };
  }

  async downloadUrl({ downloadId, fileName, expiresInSeconds }: { downloadId: string; fileName: string; expiresInSeconds: number }) {
    // The browser saves it under the site's own name, not the object's id.
    return this.s3.presign('GET', keys.download(downloadId), expiresInSeconds, {
      'response-content-disposition': `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '-')}"`,
    });
  }

  async deleteDownload({ downloadId }: { downloadId: string }) {
    await this.s3.delete(keys.download(downloadId));
  }

  async deleteBackup({ backupId }: { backupId: string }) {
    await this.s3.delete(keys.backup(backupId));
  }

  // Sites moved in

  async createImportUpload({ storeId, expiresInSeconds }: { storeId: string; expiresInSeconds: number }) {
    return await this.s3.presign('PUT', keys.import(storeId), expiresInSeconds);
  }

  async startImportParts({ storeId }: { storeId: string }) {
    return this.s3.createMultipart(keys.import(storeId));
  }

  async importPartUrls({ storeId, uploadId, parts, expiresInSeconds }: { storeId: string; uploadId: string; parts: number[]; expiresInSeconds: number }) {
    return Object.fromEntries(
      await Promise.all(parts.map(async (n) => [n, await this.s3.presign('PUT', keys.import(storeId), expiresInSeconds, { partNumber: String(n), uploadId })] as const)),
    );
  }

  async importParts({ storeId, uploadId }: { storeId: string; uploadId: string }) {
    const parts = await this.s3.listParts(keys.import(storeId), uploadId);
    return parts && parts.map(({ number, size }) => ({ number, size }));
  }

  async finishImportParts({ storeId, uploadId }: { storeId: string; uploadId: string }) {
    const key = keys.import(storeId);
    const parts = await this.s3.listParts(key, uploadId);
    if (!parts) throw new ImportPartsError('This upload is no longer known. Upload the export again.');
    if (parts.length === 0 || parts.some((p, i) => p.number !== i + 1)) throw new ImportPartsError('Some parts of the export are missing. Upload them, then finish.');
    try {
      await this.s3.completeMultipart(key, uploadId, parts);
    } catch (e) {
      if (/EntityTooSmall|InvalidPart/.test(String(e))) throw new ImportPartsError('The parts of the export do not fit together. Upload the export again.');
      throw e;
    }
  }

  async importSize({ storeId }: { storeId: string }) {
    return this.s3.head(keys.import(storeId));
  }

  async deleteImport({ storeId }: { storeId: string }) {
    await this.s3.delete(keys.import(storeId));
  }

  async suspendStore({ storeId, brand }: { storeId: string; brand?: Brand }) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    await this.exec(store.uuid, 'suspend', { brand: brand ?? this.config.brand ?? { name: '' } });
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

  async updatePlugin({ storeId, ...args }: Parameters<Provisioner['updatePlugin']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const { from, unchanged } = await this.exec(store.uuid, 'update-plugin', args);
    return { from: typeof from === 'string' ? from : null, unchanged: unchanged === true };
  }

  async addCrmProspects({ storeId, contacts }: Parameters<Provisioner['addCrmProspects']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    // Too long for a task command: the agent reads them from a signed link instead, which is gone afterwards.
    const key = keys.crmBatch(randomBytes(8).toString('hex'));
    await this.s3.put(key, new TextEncoder().encode(JSON.stringify({ contacts })), 'application/json');
    try {
      const out = await this.exec(store.uuid, 'crm-prospects', { url: await this.s3.presign('GET', key, 900) });
      const failed = out.failed && typeof out.failed === 'object' && !Array.isArray(out.failed) ? (out.failed as Record<string, string>) : {};
      return { added: Number(out.added) || 0, updated: Number(out.updated) || 0, failed };
    } finally {
      await this.s3.delete(key).catch(() => undefined);
    }
  }

  async setOutreachMailbox({ storeId, mailbox }: Parameters<Provisioner['setOutreachMailbox']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    if (!mailbox) {
      await this.exec(store.uuid, 'outreach-mailbox', { clear: true });
      return { ok: true };
    }
    // Never in the task command, which Coolify keeps: a signed link the agent reads once, gone afterwards.
    const key = keys.mailbox(randomBytes(8).toString('hex'));
    await this.s3.put(key, new TextEncoder().encode(JSON.stringify(mailbox)), 'application/json');
    try {
      const out = await this.exec(store.uuid, 'outreach-mailbox', { url: await this.s3.presign('GET', key, 300) });
      return out.ok === true ? { ok: true } : { ok: false, error: typeof out.error === 'string' ? out.error : 'Could not sign in to the mailbox' };
    } finally {
      await this.s3.delete(key).catch(() => undefined);
    }
  }

  async addOutreachAutomation({ storeId, automation }: Parameters<Provisioner['addOutreachAutomation']>[0]) {
    const store = await this.requireService(STORES_ENV, storeName(storeId));
    const key = keys.automation(randomBytes(8).toString('hex'));
    await this.s3.put(key, new TextEncoder().encode(JSON.stringify(automation)), 'application/json');
    try {
      const out = await this.exec(store.uuid, 'crm-automation', { url: await this.s3.presign('GET', key, 900) });
      return { id: Number(out.id) || 0, created: out.created === true };
    } finally {
      await this.s3.delete(key).catch(() => undefined);
    }
  }

  async deleteStore({ storeId }: { storeId: string }) {
    // The store's own relay key goes first: once the Service is gone, so is the record of its id.
    const store = this.config.mailKeys && (await this.findService(STORES_ENV, storeName(storeId)));
    const keyId = store ? envValue(await this.coolify.listEnvs(store.uuid), MAIL_KEY_ENV) : undefined;
    if (keyId) await this.config.mailKeys!.delete(keyId);
    step('remove');
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
        plainHttp: true,
        envs: { WAAS_CONSTANTS_B64: encodeConstants({}) },
      });
      await this.exec(uuid, 'suspend', { brand: this.config.brand ?? { name: '' } });
      await this.exec(uuid, 'restore', { url: await this.s3.presign('GET', key), home: https(domain) });
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
      // The restore's own error matters more; a test store left behind is deleted on the next run (cleanUpInterruptedTests).
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
    : `WaaS store, version ${meta.versionId}, setup ${meta.setup ?? STORE_SETUP}, size ${meta.size}${meta.cache ? ', cache' : ''}`;
}

export function parseMeta(description: string | null | undefined): VersionMeta | StoreMeta | null {
  const version = /^WaaS version, WordPress ([\d.]+), PHP ([\d.]+)$/.exec(description ?? '');
  if (version) return { kind: 'version', wordPressVersion: version[1]!, phpVersion: version[2]! };
  const store = /^WaaS store, version ([\w-]+)(?:, setup (\d+))?(?:, size (\w+))?(, cache)?$/.exec(description ?? '');
  if (!store) return null;
  const size = store[3] ?? DEFAULT_SIZE;
  // A size this API does not know (a newer one's) is no metadata it can act on.
  return isSize(size) ? { kind: 'store', versionId: store[1]!, setup: Number(store[2] ?? 1), size, ...(store[4] && { cache: true }) } : null;
}

/** The agent's restore answer, as a MoveReport: only well-formed rows and lines. */
export function moveReport(restored: Record<string, unknown>): MoveReport {
  const rows = (Array.isArray(restored.rows) ? restored.rows : [])
    .filter((r): r is { table: string; exported: number; loaded: number } =>
      !!r && typeof r.table === 'string' && Number.isInteger(r.exported) && Number.isInteger(r.loaded))
    .slice(0, 20)
    .map(({ table, exported, loaded }) => ({ table, exported, loaded }));
  const notes = (Array.isArray(restored.notes) ? restored.notes : []).filter((n): n is string => typeof n === 'string').slice(0, 20).map((n) => n.slice(0, 300));
  return { ...(rows.length > 0 && { rows }), ...(notes.length > 0 && { notes }) };
}

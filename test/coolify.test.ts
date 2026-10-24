import { parse } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { AGENT_SCRIPT, renderCompose } from '../src/provisioner/coolify/compose.ts';
import { CRON_TASK, CoolifyProvisioner, formatMeta, parseMeta, STORE_SETUP } from '../src/provisioner/coolify/provisioner.ts';
import { S3 } from '../src/provisioner/s3.ts';

const COOLIFY = 'https://coolify.test';
const S3_ENDPOINT = 'https://s3.test';
const PROJECT = 'proj-waas-stores';
const SERVER = 'server-1';
const STORE_ID = '0b8f6a0e-6f43-4a51-9d0a-3f5d6a1e2c11';
const VERSION_ID = '5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

interface Service {
  uuid: string;
  name: string;
  description: string;
  environment_id: number;
  compose: string;
  urls: { name: string; url: string }[];
  envs: Map<string, { uuid: string; value: string; literal?: boolean }>;
  started: number;
  /** After a restart call: reads that still show the old healthy status, then reads that show it down. */
  restarting?: { stale: number; down: number };
}

/** An in-memory Coolify API and S3 bucket, served through a fetch stub. */
class FakeCloud {
  environments = new Map<string, number>([['stores', 11]]);
  services = new Map<string, Service>();
  tasks = new Map<
    string,
    { service: string; name: string; command: string; container: string; frequency: string; timeout: number; enabled: boolean; executions: { uuid: string; status: string; message: string }[] }
  >();
  objects = new Map<string, Uint8Array>();
  calls: string[] = [];
  /** What the agent does for each command. Defaults to success. */
  /** Like a token without read:sensitive: Coolify leaves `message` out of executions. */
  hideOutput = false;
  agent: (op: string, args: Record<string, unknown>, service: Service) => { status: string; message: string } = (op) => ({
    status: 'success',
    message: `WAAS_RESULT ${JSON.stringify(op === 'snapshot' ? { sizeBytes: 42 } : op === 'home' ? { home: 'https://shop.example.com' } : {})}`,
  });
  agentOps: { op: string; args: Record<string, unknown>; service: string }[] = [];
  /** Each plugin-choices manifest as it was when the agent's plugins step ran. */
  manifests: unknown[] = [];
  staged = new Map<string, string>();
  longestCommand = 0;
  /** How a restart looks through the API (Coolify's statuses lag the restart call). */
  restartPhases = { stale: 2, down: 2 };
  /** Agent commands that ran while a restart was still under way, in containers about to stop. */
  execsDuringRestart = 0;
  private seq = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.origin === S3_ENDPOINT) return this.s3(method, url, init?.headers as Record<string, string>, init?.body);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace('/api/v1', '');
    this.calls.push(`${method} ${path}${url.search}`);
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    let m: RegExpExecArray | null;

    if ((m = /^\/projects\/([^/]+)\/([^/]+)$/.exec(path)) && method === 'GET') {
      if (m[1] !== PROJECT) return json(404, { message: 'Project not found.' });
      const id = this.environments.get(m[2]!);
      return id === undefined ? json(404, { message: 'Environment not found.' }) : json(200, { id, uuid: `env-${id}`, name: m[2] });
    }
    if ((m = /^\/projects\/([^/]+)\/environments$/.exec(path)) && method === 'POST') {
      this.environments.set(body.name, 10 + this.environments.size + 1);
      return json(201, { uuid: `env-${body.name}` });
    }
    if (path === '/services' && method === 'GET') {
      return json(200, [...this.services.values()].map(({ compose: _c, envs: _e, urls: _u, ...s }) => s));
    }
    if (path === '/services' && method === 'POST') {
      const uuid = `svc-${++this.seq}`;
      this.services.set(uuid, {
        uuid,
        name: body.name,
        description: body.description,
        environment_id: this.environments.get(body.environment_name)!,
        compose: Buffer.from(body.docker_compose_raw, 'base64').toString(),
        urls: body.urls,
        envs: new Map(),
        started: 0,
      });
      return json(201, { uuid, domains: [] });
    }
    if ((m = /^\/services\/([^/]+)(\/.*)?$/.exec(path))) {
      const service = this.services.get(m[1]!);
      if (!service) return json(404, { message: 'Service not found.' });
      const rest = m[2] ?? '';
      if (rest === '' && method === 'GET') {
        let status = service.started ? 'running:healthy' : 'exited';
        const r = service.restarting;
        if (r && r.stale > 0) r.stale--;
        else if (r && r.down > 0) {
          r.down--;
          status = 'exited';
        } else service.restarting = undefined;
        return json(200, { ...service, envs: undefined, applications: [{ name: 'wordpress', status }, { name: 'agent', status }], databases: [{ name: 'db', status }] });
      }
      if (rest === '' && method === 'PATCH') {
        if (body.urls) service.urls = body.urls;
        if (body.description) service.description = body.description;
        if (body.docker_compose_raw) service.compose = Buffer.from(body.docker_compose_raw, 'base64').toString();
        return json(200, { uuid: service.uuid });
      }
      if (rest === '' && method === 'DELETE') {
        this.services.delete(service.uuid);
        return json(200, { message: 'Service deletion request queued.' });
      }
      if ((rest === '/start' || rest === '/restart') && method === 'POST') {
        // Coolify refuses to start a Service that is already up.
        if (rest === '/start' && service.started) return json(400, { message: 'Service is already running.' });
        service.started++;
        if (rest === '/restart') service.restarting = { ...this.restartPhases };
        return json(200, { message: 'queued' });
      }
      if (rest === '/envs' && method === 'GET') {
        // Coolify hands a literal variable's real_value back wrapped in single quotes, as it writes it to .env.
        return json(200, [...service.envs].map(([key, e]) => ({ uuid: e.uuid, key, value: e.value, real_value: e.literal ? `'${e.value}'` : e.value })));
      }
      if (rest === '/envs/bulk' && method === 'PATCH') {
        for (const { key, value, is_literal } of body.data) service.envs.set(key, { uuid: `env-${++this.seq}`, value, literal: !!is_literal });
        return json(201, []);
      }
      if ((m = /^\/envs\/([^/]+)$/.exec(rest)) && method === 'DELETE') {
        for (const [key, e] of service.envs) if (e.uuid === m[1]) service.envs.delete(key);
        return json(200, { message: 'Environment variable deleted.' });
      }
      if (rest === '/scheduled-tasks' && method === 'POST') {
        // Coolify keeps the command in a varchar(255) and answers 500 past it.
        if (body.command.length > 255) return json(500, { message: 'Server Error' });
        this.longestCommand = Math.max(this.longestCommand, body.command.length);
        const uuid = `task-${++this.seq}`;
        this.tasks.set(uuid, { service: service.uuid, ...body, executions: [] });
        return json(201, { uuid, ...body });
      }
      if (rest === '/scheduled-tasks' && method === 'GET') {
        // Coolify answers with its own column types: enabled as 0/1.
        const own = [...this.tasks].filter(([, t]) => t.service === service.uuid);
        return json(200, own.map(([uuid, { executions: _x, service: _s, ...t }]) => ({ uuid, ...t, enabled: t.enabled ? 1 : 0 })));
      }
      if ((m = /^\/scheduled-tasks\/([^/]+)\/execute$/.exec(rest)) && method === 'POST') {
        const task = this.tasks.get(m[1]!)!;
        if (service.restarting) this.execsDuringRestart++;
        const [, , op, arg, chunk] = task.command.split(' ');
        if (op === 'stage') {
          this.staged.set(arg!, (this.staged.get(arg!) ?? '') + chunk);
          task.executions.push({ uuid: `exec-${++this.seq}`, status: 'success', message: 'WAAS_RESULT []' });
          return json(200, { message: 'queued' });
        }
        const payload = arg!.startsWith('@') ? this.staged.get(arg!.slice(1))! : arg!;
        const args = JSON.parse(Buffer.from(payload, 'base64').toString());
        this.agentOps.push({ op: op!, args, service: service.uuid });
        if (op === 'plugins' && args.manifest) {
          const key = decodeURIComponent(new URL(String(args.manifest)).pathname).replace(/^\/[^/]+\//, '');
          this.manifests.push(JSON.parse(Buffer.from(this.objects.get(key)!).toString()));
        }
        task.executions.push({ uuid: `exec-${++this.seq}`, ...this.agent(op!, args, service) });
        return json(200, { message: 'queued' });
      }
      if ((m = /^\/scheduled-tasks\/([^/]+)\/executions$/.exec(rest)) && method === 'GET') return json(200, this.tasks.get(m[1]!)!.executions.map(({ message, ...e }) => (this.hideOutput ? e : { ...e, message })));
      if ((m = /^\/scheduled-tasks\/([^/]+)$/.exec(rest)) && method === 'DELETE') {
        this.tasks.delete(m[1]!);
        return json(200, { message: 'Scheduled task deleted.' });
      }
    }
    return json(404, { message: `No route ${method} ${path}` });
  };

  private s3(method: string, url: URL, headers: Record<string, string>, body?: unknown): Response {
    const key = decodeURIComponent(url.pathname.replace(/^\/waas-stores\//, ''));
    if (!url.searchParams.has('X-Amz-Signature') && !headers?.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=TESTKEY/')) return new Response('', { status: 403 });
    const object = this.objects.get(key);
    if (method === 'HEAD') return new Response(null, { status: object ? 200 : 404, headers: object ? { 'content-length': String(object.length) } : {} });
    if (method === 'GET') return object ? new Response(Buffer.from(object)) : new Response('', { status: 404 });
    if (method === 'DELETE') {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT' && headers['x-amz-copy-source']) {
      const source = this.objects.get(decodeURIComponent(headers['x-amz-copy-source']).replace(/^\/waas-stores\//, ''));
      if (!source) return new Response('', { status: 404 });
      this.objects.set(key, source);
      return new Response('<CopyObjectResult/>', { status: 200 });
    }
    if (method === 'PUT' && body instanceof Uint8Array) {
      this.objects.set(key, new Uint8Array(body));
      return new Response(null, { status: 200 });
    }
    return new Response('', { status: 405 });
  }

  addVersion(versionId = VERSION_ID, environmentId = 12) {
    this.environments.set('versions', environmentId);
    const uuid = `svc-${++this.seq}`;
    this.services.set(uuid, {
      uuid,
      name: `version-${versionId}`,
      description: 'WaaS version, WordPress 6.8, PHP 8.3',
      environment_id: environmentId,
      compose: '',
      urls: [],
      envs: new Map(),
      started: 1,
    });
  }
}

/** Tasks other than the store's cron: the agent's on-demand ones, deleted after they run. */
const onDemandTasks = (cloud: FakeCloud) => [...cloud.tasks.values()].filter((t) => t.name !== CRON_TASK.name);
const cronTasks = (cloud: FakeCloud) => [...cloud.tasks.values()].filter((t) => t.name === CRON_TASK.name);

const MAIL = { host: 'smtp.tosend.com', port: 587, user: 'tosend', pass: 'tsend_test_not_real', from: 'store@mail.example' };
const decode = (value: string | undefined) => value && JSON.parse(Buffer.from(value, 'base64').toString());

/** A stand-in for toSend's admin API: keys by id. */
class FakeMailKeys {
  keys = new Map<string, string>();
  domains = new Map<string, string | undefined>();
  private seq = 0;
  async create(storeId: string, domainId?: string) {
    const id = String(++this.seq);
    this.keys.set(id, `tsend_${storeId.slice(0, 8)}_${id}`);
    this.domains.set(id, domainId);
    return { id, key: this.keys.get(id)! };
  }
  async delete(id: string) {
    this.keys.delete(id);
  }
}

function provisioner(
  cloud: FakeCloud,
  extra: { restartSeenTimeoutMs?: number; mail?: typeof MAIL; mailKeys?: FakeMailKeys; siteKey?: (storeId: string) => string } = {},
) {
  return new CoolifyProvisioner({
    ...extra,
    url: COOLIFY,
    serverUuid: SERVER,
    projectUuid: PROJECT,
    s3: { endpoint: S3_ENDPOINT, bucket: 'waas-stores', region: 'auto', accessKeyId: 'TESTKEY', secretAccessKey: 'test-secret-not-real' },
    fetch: cloud.fetch,
    sleep: async () => undefined,
    pollMs: 0,
    deployTimeoutMs: 5000,
  });
}

const storeInput = {
  storeId: STORE_ID,
  versionId: VERSION_ID,
  snapshotId: 'snap-1',
  mainDomain: 'shop.example.com',
  redirectDomains: ['t-0b8f6a0e.stores.example.com'],
  phpConstants: { WPCS_TENANT_ROLES: { value: 'shop_manager' }, API_SECRET: { value: 'private-constant-value', isPrivate: true } },
  wpOptions: { blogname: 'Example Store' },
  size: 'small' as const,
  user: { name: 'owner', email: 'owner@example.com', role: 'administrator', password: 'example-password-123' },
};

describe('CoolifyProvisioner', () => {
  let cloud: FakeCloud;
  let p: CoolifyProvisioner;

  beforeEach(() => {
    cloud = new FakeCloud();
    p = provisioner(cloud);
    cloud.addVersion();
    cloud.objects.set('snapshots/snap-1.zip', new Uint8Array([80, 75, 5, 6]));
  });

  it('creates a store as one Service in the stores environment, restores it, and drops the one-time password', async () => {
    await p.createStore(storeInput);

    const stores = [...cloud.services.values()].filter((s) => s.name === `store-${STORE_ID}`);
    expect(stores).toHaveLength(1);
    const store = stores[0]!;
    expect(store.environment_id).toBe(11);
    expect(store.description).toBe(`WaaS store, version ${VERSION_ID}, setup ${STORE_SETUP}, size small`);
    expect(store.urls).toEqual([{ name: 'wordpress', url: 'https://shop.example.com,https://t-0b8f6a0e.stores.example.com' }]);
    const compose = parse(store.compose);
    expect(compose.services.wordpress.image).toBe('wordpress:6.8-php8.3-apache');
    expect(compose.services.wordpress.mem_limit).toBe('512m');
    expect(compose.services.agent.image).toBe('wordpress:cli-php8.3');
    // The agent loads WordPress with every plugin for the store's cron each minute.
    expect(compose.services.agent.mem_limit).toBe('256m');
    // Created without deploying, so the variables are in place before the first start.
    const create = cloud.calls.indexOf('POST /services');
    expect(cloud.calls.findIndex((c) => c.endsWith('/envs/bulk'))).toBeGreaterThan(create);
    expect(cloud.calls.findIndex((c) => c.endsWith('/start'))).toBeGreaterThan(cloud.calls.findIndex((c) => c.endsWith('/envs/bulk')));

    expect(cloud.agentOps.map((o) => o.op)).toEqual(['ping', 'restore', 'code-import', 'configure']);
    expect(cloud.agentOps[1]!.args).toMatchObject({ home: 'https://shop.example.com' });
    expect(String(cloud.agentOps[1]!.args.url)).toMatch(/^https:\/\/s3\.test\/waas-stores\/snapshots\/snap-1\.zip\?.*X-Amz-Signature=/);
    expect(cloud.agentOps[3]!.args).toEqual({
      home: 'https://shop.example.com',
      options: { blogname: 'Example Store' },
      user: { name: 'owner', email: 'owner@example.com', role: 'administrator' },
    });

    const constants = JSON.parse(Buffer.from(store.envs.get('WAAS_CONSTANTS_B64')!.value, 'base64').toString());
    expect(constants).toEqual({ WPCS_TENANT_ROLES: 'shop_manager', API_SECRET: 'private-constant-value' });
    // The password went in as a variable only, never in a command, and is gone afterwards.
    expect(store.envs.has('WAAS_INIT_PASSWORD')).toBe(false);
    const commands = cloud.agentOps.map((o) => JSON.stringify(o.args)).join('\n');
    expect(commands).not.toContain('example-password-123');
    expect(commands).not.toContain('private-constant-value');
    // Every task is deleted after it runs.
    expect(onDemandTasks(cloud)).toEqual([]);
  });

  it('gives a new store one enabled wp-cron task in the agent, every 5 minutes', async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const crons = cronTasks(cloud);
    expect(crons).toHaveLength(1);
    expect(crons[0]).toMatchObject({ service: store.uuid, container: 'agent', frequency: '*/5 * * * *', timeout: 300, enabled: true });
    const command = crons[0]!.command;
    expect(command.length).toBeLessThanOrEqual(255);
    const wp = 'php -d memory_limit=192M /usr/local/bin/wp';
    expect(command).toContain(`${wp} action-scheduler run --quiet; ${wp} cron event run --due-now --quiet`);
    // Not while suspended, never overlapping, and nothing Coolify's sh -c '...' would cut.
    expect(command).toMatch(/^\[ -f \/var\/www\/html\/wp-content\/\.waas-suspended \] \|\| flock -n /);
    expect(command).not.toContain("'");
    expect(command).not.toContain('$');
    // Created once the store is restored and configured.
    expect(cloud.calls.findLastIndex((c) => c.endsWith('/scheduled-tasks') && c.startsWith('POST'))).toBeGreaterThan(
      cloud.calls.findLastIndex((c) => c.endsWith('/execute')),
    );
  });

  it('does not duplicate the wp-cron task when a create is retried', async () => {
    await p.createStore(storeInput);
    await p.createStore(storeInput);
    expect(cronTasks(cloud)).toHaveLength(1);
  });

  it('replaces a wp-cron task that differs, and removes duplicates', async () => {
    await p.createStore(storeInput);
    const [uuid] = [...cloud.tasks].find(([, t]) => t.name === CRON_TASK.name)!;
    cloud.tasks.get(uuid)!.enabled = false;
    cloud.tasks.set('task-dup', { ...cloud.tasks.get(uuid)!, enabled: true, executions: [] });
    expect(await p.ensureStoreCron({ storeId: STORE_ID })).toBe('updated');
    expect(cronTasks(cloud)).toHaveLength(1);
    expect(cronTasks(cloud)[0]).toMatchObject({ enabled: true, command: CRON_TASK.command });
    expect(await p.ensureStoreCron({ storeId: STORE_ID })).toBe('unchanged');
  });

  it('backfills a store created before stores had a cron: new compose, one restart, then the task', async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    for (const [uuid, t] of cloud.tasks) if (t.name === CRON_TASK.name) cloud.tasks.delete(uuid);
    store.compose = 'old compose';
    const starts = store.started;

    expect(await p.ensureStoreCron({ storeId: STORE_ID })).toBe('created');
    expect(parse(store.compose).services.wordpress.environment.WORDPRESS_CONFIG_EXTRA).toContain("define('DISABLE_WP_CRON', true)");
    expect(store.started).toBe(starts + 1);
    expect(cronTasks(cloud)).toHaveLength(1);

    // Again: nothing to do, no restart.
    cloud.calls = [];
    expect(await p.ensureStoreCron({ storeId: STORE_ID })).toBe('unchanged');
    expect(store.started).toBe(starts + 1);
    expect(cloud.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('brings a store from an older setup to the current one: new compose, one restart, agent files, then the description', async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    store.description = `WaaS store, version ${VERSION_ID}`;
    store.compose = 'old compose';
    const starts = store.started;

    expect(await p.ensureStoreSetup({ storeId: STORE_ID, size: 'small' })).toBe('updated');
    const wordpress = parse(store.compose).services.wordpress;
    expect(wordpress.environment.WORDPRESS_CONFIG_EXTRA).toContain("define('WP_CACHE', true)");
    expect(wordpress.entrypoint[2]).toContain('MaxRequestWorkers 8');
    expect(store.started).toBe(starts + 1);
    expect(cloud.agentOps.at(-1)).toMatchObject({ op: 'configure', args: {} });
    expect(store.description).toBe(`WaaS store, version ${VERSION_ID}, setup ${STORE_SETUP}, size small`);

    // Again: nothing to do, no restart.
    cloud.calls = [];
    expect(await p.ensureStoreSetup({ storeId: STORE_ID, size: 'small' })).toBe('unchanged');
    expect(store.started).toBe(starts + 1);
    expect(cloud.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('gives a store its site key, when created and when an older store is brought to the current setup', async () => {
    p = provisioner(cloud, { siteKey: (storeId) => `site-key-for-${storeId}` });
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    expect(store.envs.get('WAAS_SITE_KEY')?.value).toBe(`site-key-for-${STORE_ID}`);
    expect(parse(store.compose).services.wordpress.environment.WAAS_SITE_KEY).toBe('${WAAS_SITE_KEY:-}');

    store.envs.delete('WAAS_SITE_KEY');
    store.description = `WaaS store, version ${VERSION_ID}, setup 3, size small`;
    expect(await p.ensureStoreSetup({ storeId: STORE_ID, size: 'small' })).toBe('updated');
    expect(store.envs.get('WAAS_SITE_KEY')?.value).toBe(`site-key-for-${STORE_ID}`);
  });

  it('leaves a new store alone: it already has the current setup', async () => {
    await p.createStore(storeInput);
    expect(await p.ensureStoreSetup({ storeId: STORE_ID, size: 'small' })).toBe('unchanged');
  });

  it('tells a store its email packs through the agent, without a restart', async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const starts = store.started;
    await p.setEmailPacks({ storeId: STORE_ID, purchased: 15000 });
    expect(cloud.agentOps.at(-1)).toMatchObject({ op: 'mail-packs', args: { purchased: 15000 } });
    expect(store.started).toBe(starts);
  });

  it('brings a store from before email packs to the current setup first, so its agent has the operation', async () => {
    await p.createStore({ ...storeInput, size: 'medium' });
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    store.description = `WaaS store, version ${VERSION_ID}, setup 4, size medium`;
    store.compose = 'old compose';
    const starts = store.started;
    await p.setEmailPacks({ storeId: STORE_ID, purchased: 5000 });
    expect(store.started).toBe(starts + 1);
    expect(parse(store.compose).services.agent.environment.WAAS_AGENT_B64).toBe(Buffer.from(AGENT_SCRIPT).toString('base64'));
    expect(store.description).toBe(`WaaS store, version ${VERSION_ID}, setup ${STORE_SETUP}, size medium`);
    expect(cloud.agentOps.slice(-2).map((o) => o.op)).toEqual(['configure', 'mail-packs']);
  });

  it('creates a store at its size: resources and quotas in the compose, the size in the description', async () => {
    await p.createStore({ ...storeInput, size: 'medium' });
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    expect(store.description).toBe(`WaaS store, version ${VERSION_ID}, setup ${STORE_SETUP}, size medium`);
    const wordpress = parse(store.compose).services.wordpress;
    expect(wordpress).toMatchObject({ cpus: 2, mem_limit: '512m' });
    expect(wordpress.environment).toMatchObject({ WAAS_STORAGE_GB: '10', WAAS_EMAILS_PER_MONTH: '20000' });
    expect(await p.ensureStoreSetup({ storeId: STORE_ID, size: 'medium' })).toBe('unchanged');
  });

  it('moves a store to the size on record when it runs at another: new compose, one restart, agent files, then the description', async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const starts = store.started;

    expect(await p.ensureStoreSetup({ storeId: STORE_ID, size: 'large' })).toBe('updated');
    const wordpress = parse(store.compose).services.wordpress;
    expect(wordpress).toMatchObject({ cpus: 4, mem_limit: '768m' });
    expect(wordpress.entrypoint[2]).toContain('MaxRequestWorkers 32');
    expect(wordpress.environment).toMatchObject({ WAAS_STORAGE_GB: '25', WAAS_EMAILS_PER_MONTH: '50000' });
    expect(store.started).toBe(starts + 1);
    expect(cloud.agentOps.at(-1)).toMatchObject({ op: 'configure', args: {} });
    expect(store.description).toBe(`WaaS store, version ${VERSION_ID}, setup ${STORE_SETUP}, size large`);

    cloud.calls = [];
    expect(await p.ensureStoreSetup({ storeId: STORE_ID, size: 'large' })).toBe('unchanged');
    expect(cloud.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('resizes a store on update: new compose, one restart with the new constants, then the description', async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const starts = store.started;
    await p.updateStore({ storeId: STORE_ID, size: 'medium', phpConstants: storeInput.phpConstants, wpOptions: { blogdescription: 'New' } });
    expect(parse(store.compose).services.wordpress).toMatchObject({ cpus: 2, environment: { WAAS_EMAILS_PER_MONTH: '20000' } });
    expect(store.started).toBe(starts + 1);
    expect(cloud.agentOps.at(-1)).toMatchObject({ op: 'configure', args: { options: { blogdescription: 'New' } } });
    expect(store.description).toBe(`WaaS store, version ${VERSION_ID}, setup ${STORE_SETUP}, size medium`);
  });

  it('keeps the size when a store moves, or gets its cron or mail backfilled', async () => {
    p = provisioner(cloud, { mail: MAIL });
    await p.createStore({ ...storeInput, size: 'large' });
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    cloud.addVersion('v9');
    await p.moveStore({ storeId: STORE_ID, targetVersionId: 'v9' });
    expect(store.description).toBe(`WaaS store, version v9, setup ${STORE_SETUP}, size large`);
    expect(parse(store.compose).services.wordpress.cpus).toBe(4);

    for (const [uuid, t] of cloud.tasks) if (t.name === CRON_TASK.name) cloud.tasks.delete(uuid);
    store.compose = 'old compose';
    await p.ensureStoreCron({ storeId: STORE_ID });
    expect(parse(store.compose).services.wordpress.cpus).toBe(4);

    store.envs.delete('WAAS_MAIL_B64');
    store.compose = 'old compose';
    await p.ensureStoreMail({ storeId: STORE_ID });
    expect(parse(store.compose).services.wordpress.cpus).toBe(4);
  });

  it('gives a new store the mail relay settings as a variable, never in a command', async () => {
    p = provisioner(cloud, { mail: MAIL });
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value)).toEqual(MAIL);
    expect(parse(store.compose).services.wordpress.environment.WAAS_MAIL_B64).toBe('${WAAS_MAIL_B64:-}');
    expect(cloud.agentOps.map((o) => JSON.stringify(o.args)).join('\n')).not.toContain(MAIL.pass);
    // Already up to date: nothing to do.
    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('unchanged');
  });

  it('sets no mail variable when no relay is configured', async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    expect(store.envs.has('WAAS_MAIL_B64')).toBe(false);
    cloud.calls = [];
    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('unchanged');
    expect(cloud.calls).toEqual([]);
  });

  it('backfills mail on an older store: new compose, the variable, one restart, then the mu-plugin', async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    store.compose = 'old compose';
    const starts = store.started;
    cloud.agentOps = [];

    p = provisioner(cloud, { mail: MAIL });
    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('created');
    expect(parse(store.compose).services.agent.environment.WAAS_MAIL_B64).toBe('${WAAS_MAIL_B64:-}');
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value)).toEqual(MAIL);
    expect(store.started).toBe(starts + 1);
    expect(cloud.agentOps.map((o) => o.op)).toEqual(['ping', 'configure']);
    expect(cloud.execsDuringRestart).toBe(0);

    cloud.calls = [];
    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('unchanged');
    expect(cloud.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);

    // A new key: the variable changes and the store restarts, keeping its compose.
    store.compose = 'kept';
    p = provisioner(cloud, { mail: { ...MAIL, pass: 'tsend_rotated_not_real' } });
    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('updated');
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value).pass).toBe('tsend_rotated_not_real');
    expect(store.compose).toBe('kept');
    expect(store.started).toBe(starts + 2);
  });

  it('gives each store its own relay key when keys are per store, reusing it on a retry and revoking it on delete', async () => {
    const keys = new FakeMailKeys();
    p = provisioner(cloud, { mail: MAIL, mailKeys: keys });
    await p.createStore(storeInput);
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    expect(keys.keys.size).toBe(1);
    const [id, key] = [...keys.keys][0]!;
    expect(store.envs.get('WAAS_MAIL_KEY_ID')?.value).toBe(id);
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value)).toEqual({ ...MAIL, pass: key });
    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('unchanged');

    await p.deleteStore({ storeId: STORE_ID });
    expect(keys.keys.size).toBe(0);
  });

  it('repairs a key id that earlier starts wrapped in quotes, keeping the same key', async () => {
    const keys = new FakeMailKeys();
    p = provisioner(cloud, { mail: MAIL, mailKeys: keys });
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const [id, key] = [...keys.keys][0]!;
    // What reading real_value and writing it back left on live stores: one more layer per start.
    store.envs.get('WAAS_MAIL_KEY_ID')!.value = `''''${id}''''`;
    const starts = store.started;

    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('updated');
    expect(store.envs.get('WAAS_MAIL_KEY_ID')?.value).toBe(id);
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value)).toEqual({ ...MAIL, pass: key });
    expect([...keys.keys.keys()]).toEqual([id]);
    expect(store.started).toBe(starts + 1);
    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('unchanged');
  });

  it('falls back to the shared key when toSend refuses, and moves the store to its own key later', async () => {
    const keys = new FakeMailKeys();
    const create = keys.create.bind(keys);
    keys.create = async () => {
      throw new Error('toSend down');
    };
    p = provisioner(cloud, { mail: MAIL, mailKeys: keys });
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value)).toEqual(MAIL);
    expect(store.envs.has('WAAS_MAIL_KEY_ID')).toBe(false);

    keys.create = create;
    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('updated');
    expect(store.envs.get('WAAS_MAIL_KEY_ID')?.value).toBe('1');
  });

  it('moves a store on the shared key to its own key, once', async () => {
    p = provisioner(cloud, { mail: MAIL });
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const starts = store.started;

    const keys = new FakeMailKeys();
    p = provisioner(cloud, { mail: MAIL, mailKeys: keys });
    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('updated');
    const [id, key] = [...keys.keys][0]!;
    expect(store.envs.get('WAAS_MAIL_KEY_ID')?.value).toBe(id);
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value).pass).toBe(key);
    expect(store.started).toBe(starts + 1);
    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('unchanged');
    expect(keys.keys.size).toBe(1);
  });

  it("moves a store to its own sending domain with a key for that domain, and back again", async () => {
    const keys = new FakeMailKeys();
    p = provisioner(cloud, { mail: MAIL, mailKeys: keys });
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const sender = { domain: 'shop.example', domainId: 'dom1' };

    expect(await p.ensureStoreMail({ storeId: STORE_ID, sender })).toBe('updated');
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value)).toEqual({ ...MAIL, from: `${MAIL.from.split('@')[0]}@shop.example`, pass: keys.keys.get('2') });
    expect(keys.domains.get('2')).toBe('dom1');
    expect([...keys.keys.keys()]).toEqual(['2']); // The platform-domain key was revoked.
    expect(await p.ensureStoreMail({ storeId: STORE_ID, sender })).toBe('unchanged');

    expect(await p.ensureStoreMail({ storeId: STORE_ID })).toBe('updated');
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value)).toEqual({ ...MAIL, pass: keys.keys.get('3') });
    expect([...keys.keys.keys()]).toEqual(['3']);
  });

  it('refuses a sending domain when stores share one key', async () => {
    p = provisioner(cloud, { mail: MAIL });
    await p.createStore(storeInput);
    await expect(p.ensureStoreMail({ storeId: STORE_ID, sender: { domain: 'shop.example', domainId: 'dom1' } })).rejects.toThrow(/per-store keys/);
  });

  it("moves a store to its own mailbox at the platform's domain, keeping its key, with one restart", async () => {
    const keys = new FakeMailKeys();
    p = provisioner(cloud, { mail: MAIL, mailKeys: keys });
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const [id, key] = [...keys.keys][0]!;
    const starts = store.started;

    expect(await p.ensureStoreMail({ storeId: STORE_ID, mailbox: 'acme' })).toBe('updated');
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value)).toEqual({ ...MAIL, from: 'acme@mail.example', pass: key });
    // Keys are restricted to a domain, not an address: the same key sends from the new name.
    expect([...keys.keys.keys()]).toEqual([id]);
    expect(store.envs.get('WAAS_MAIL_KEY_ID')?.value).toBe(id);
    expect(store.started).toBe(starts + 1);
    expect(await p.ensureStoreMail({ storeId: STORE_ID, mailbox: 'acme' })).toBe('unchanged');
    expect(p.mailFrom({ mailbox: 'acme' })).toBe('acme@mail.example');
    expect(p.mailFrom({ sender: { domain: 'shop.example', domainId: 'dom1' }, mailbox: 'acme' })).toBe('store@shop.example');
    expect(p.mailFrom({})).toBe(MAIL.from);
    expect(provisioner(cloud).mailFrom({ mailbox: 'acme' })).toBeNull();

    // A new store gets its mailbox at create.
    await p.deleteStore({ storeId: STORE_ID });
    await p.createStore({ ...storeInput, mailbox: 'acme' });
    const created = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    expect(decode(created.envs.get('WAAS_MAIL_B64')?.value).from).toBe('acme@mail.example');
  });

  it('gives a store from an older setup its new sender and the current setup with the same one restart', async () => {
    p = provisioner(cloud, { mail: MAIL });
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    store.description = `WaaS store, version ${VERSION_ID}, setup 5, size small`;
    store.compose = 'old compose';
    const starts = store.started;
    expect(await p.ensureStoreMail({ storeId: STORE_ID, mailbox: 'acme' })).toBe('updated');
    expect(store.started).toBe(starts + 1);
    expect(store.description).toBe(`WaaS store, version ${VERSION_ID}, setup ${STORE_SETUP}, size small`);
    expect(parse(store.compose).services.agent.environment.WAAS_AGENT_B64).toBe(Buffer.from(AGENT_SCRIPT).toString('base64'));
    expect(await p.ensureStoreSetup({ storeId: STORE_ID, size: 'small' })).toBe('unchanged');
    expect(store.started).toBe(starts + 1);
  });

  it("moves the store's sender with its domains on the same restart", async () => {
    const keys = new FakeMailKeys();
    p = provisioner(cloud, { mail: MAIL, mailKeys: keys });
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const starts = store.started;
    await p.setDomains({ storeId: STORE_ID, mainDomain: 'acme.example.com', redirectDomains: [], mail: { mailbox: 'acme' } });
    expect(decode(store.envs.get('WAAS_MAIL_B64')?.value).from).toBe('acme@mail.example');
    expect(store.started).toBe(starts + 1);
    expect(keys.keys.size).toBe(1);
    expect(await p.ensureStoreMail({ storeId: STORE_ID, mailbox: 'acme' })).toBe('unchanged');
    // The same sender again: just the domains.
    await p.setDomains({ storeId: STORE_ID, mainDomain: 'acme.example.com', redirectDomains: ['shop.example.com'], mail: { mailbox: 'acme' } });
    expect(store.started).toBe(starts + 2);
  });

  it("tells a store the platform's count of its email through the agent, without a restart", async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const starts = store.started;
    await p.setMailCount({ storeId: STORE_ID, month: '2026-10', sent: 42 });
    expect(cloud.agentOps.at(-1)).toMatchObject({ op: 'mail-count', args: { month: '2026-10', sent: 42 } });
    expect(store.started).toBe(starts);
    // A store from before the count gets the current setup first, so its agent has the operation.
    store.description = `WaaS store, version ${VERSION_ID}, setup 5, size small`;
    await p.setMailCount({ storeId: STORE_ID, month: '2026-10', sent: 43 });
    expect(store.started).toBe(starts + 1);
    expect(cloud.agentOps.slice(-2).map((o) => o.op)).toEqual(['configure', 'mail-count']);
  });

  it('stages arguments too long for one task command, keeping every command within 255 characters', async () => {
    await p.createStore({ ...storeInput, wpOptions: { blogname: 'Example Store', blogdescription: 'x'.repeat(2000) } });
    expect(cloud.staged.size).toBeGreaterThan(0);
    expect(cloud.longestCommand).toBeLessThanOrEqual(255);
    // The staged arguments arrive whole.
    expect(cloud.agentOps.find((o) => o.op === 'configure')!.args.options).toEqual({ blogname: 'Example Store', blogdescription: 'x'.repeat(2000) });
    expect(String(cloud.agentOps.find((o) => o.op === 'restore')!.args.url)).toContain('X-Amz-Signature=');
    expect(onDemandTasks(cloud)).toEqual([]);
  });

  it('is idempotent: a retried create reuses the Service, even though it is already running', async () => {
    await p.createStore(storeInput);
    await p.createStore(storeInput);
    expect([...cloud.services.values()].filter((s) => s.name === `store-${STORE_ID}`)).toHaveLength(1);
    expect(cloud.calls.filter((c) => c === 'POST /services')).toHaveLength(1);
    expect(cloud.agentOps.filter((o) => o.op === 'restore')).toHaveLength(2);
  });

  it('only sees Services in its own project environments', async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    store.environment_id = 99; // e.g. the same name in another project
    expect(await p.findService('stores', `store-${STORE_ID}`)).toBeNull();
    await expect(p.suspendStore({ storeId: STORE_ID })).rejects.toThrow(/no service/);
  });

  it('creates the versions environment on first use', async () => {
    cloud.environments.delete('versions');
    cloud.objects.set('base/base-1.zip', new Uint8Array([80, 75]));
    await p.buildVersion({ versionId: 'v2', domain: 'v2.versions.example.com', wordPressVersion: '6.8', phpVersion: '8.2', source: { baseSnapshotId: 'base-1' } });
    expect(cloud.calls).toContain(`POST /projects/${PROJECT}/environments`);
    const version = [...cloud.services.values()].find((s) => s.name === 'version-v2')!;
    expect(version.description).toBe('WaaS version, WordPress 6.8, PHP 8.2');
    // The plugins step runs with no choices too: it undoes any an earlier version applied to the archive.
    expect(cloud.agentOps.map((o) => o.op)).toEqual(['ping', 'restore', 'plugins', 'code-export']);
    expect(cloud.agentOps[2]!.args).toEqual({ plugins: [] });
  });

  it('applies plugin choices with signed links to the kept zips, and keeps each zip once', async () => {
    await p.storePluginPackage({ slug: 'contact-form-7', version: '6.1.2', body: new Uint8Array([80, 75, 1]) });
    expect(cloud.objects.get('plugins/wporg/contact-form-7/6.1.2.zip')).toEqual(new Uint8Array([80, 75, 1]));
    await p.storePluginPackage({ slug: 'contact-form-7', version: '6.1.2', body: new Uint8Array([80, 75, 2]) });
    expect(cloud.objects.get('plugins/wporg/contact-form-7/6.1.2.zip')).toEqual(new Uint8Array([80, 75, 1]));

    cloud.objects.set('base/base-1.zip', new Uint8Array([80, 75]));
    await p.buildVersion({
      versionId: 'v3',
      domain: 'v3.versions.example.com',
      wordPressVersion: '6.8',
      phpVersion: '8.2',
      source: { baseSnapshotId: 'base-1' },
      plugins: [
        { slug: 'contact-form-7', action: 'add', version: '6.1.2', sha256: 'abc', siteTypes: ['website'] },
        { slug: 'wp-fusion-lite', action: 'off', siteTypes: [] },
        { slug: 'gravityforms', action: 'add', version: '2.9.1', sha256: 'def', siteTypes: [], uploadId: 'up-1', constants: { GF_LICENSE_KEY: 'k' } },
      ],
    });
    const op = cloud.agentOps.find((o) => o.op === 'plugins')!;
    expect(String(op.args.manifest)).toMatch(/^https:\/\/s3\.test\/waas-stores\/versions\/v3\/plugin-choices\.json\?.*X-Amz-Signature=/);
    // It can hold licence keys, so it's gone once the step has run.
    expect(cloud.objects.has('versions/v3/plugin-choices.json')).toBe(false);
    const manifest = cloud.manifests.at(-1) as { plugins: unknown[] };
    const [added, off, premium] = manifest.plugins as Record<string, unknown>[];
    expect(added).toMatchObject({ slug: 'contact-form-7', action: 'add', sha256: 'abc', siteTypes: ['website'] });
    expect(String(added!.url)).toMatch(/^https:\/\/s3\.test\/waas-stores\/plugins\/wporg\/contact-form-7\/6\.1\.2\.zip\?.*X-Amz-Signature=/);
    expect(off).toEqual({ slug: 'wp-fusion-lite', action: 'off', siteTypes: [] });
    expect(premium).toMatchObject({ slug: 'gravityforms', constants: { GF_LICENSE_KEY: 'k' } });
    expect(String(premium!.url)).toMatch(/^https:\/\/s3\.test\/waas-stores\/plugins\/uploads\/up-1\.zip\?.*X-Amz-Signature=/);
  });

  it('fails a create when the snapshot archive is missing, before creating anything', async () => {
    await expect(p.createStore({ ...storeInput, snapshotId: 'missing' })).rejects.toThrow(/No archive at snapshots\/missing\.zip/);
    expect(cloud.calls).not.toContain('POST /services');
  });

  it('suspends and resumes through the agent', async () => {
    await p.createStore(storeInput);
    cloud.agentOps = [];
    await p.suspendStore({ storeId: STORE_ID });
    await p.resumeStore({ storeId: STORE_ID });
    expect(cloud.agentOps.map((o) => o.op)).toEqual(['suspend', 'resume']);
    expect(cloud.agentOps[0]!.args).toEqual({ brand: { name: 'AnyPress' } });
  });

  it('brands the unavailable page with the suspend\'s brand over the default', async () => {
    await p.createStore(storeInput);
    cloud.agentOps = [];
    await p.suspendStore({ storeId: STORE_ID, brand: { name: 'Reseller Co', url: 'https://reseller.example' } });
    expect(cloud.agentOps[0]!.args).toEqual({ brand: { name: 'Reseller Co', url: 'https://reseller.example' } });
  });

  it('reports an agent failure with its message and still deletes the task', async () => {
    await p.createStore(storeInput);
    cloud.agent = () => ({ status: 'failed', message: 'some output\nWAAS_ERROR wp db export exited 1: disk full\n' });
    await expect(p.snapshotStore({ storeId: STORE_ID, snapshotId: 'snap-2' })).rejects.toThrow('Store agent snapshot failed (failed): wp db export exited 1: disk full');
    expect(onDemandTasks(cloud)).toEqual([]);
  });

  it('says the token needs read:sensitive when Coolify hides the task output', async () => {
    cloud.hideOutput = true;
    await expect(p.createStore(storeInput)).rejects.toThrow("Store agent ping: Coolify hid the task output; the API's COOLIFY_TOKEN needs the read:sensitive permission");
    expect(onDemandTasks(cloud)).toEqual([]);
  });

  it('backs up to backups/ and returns the size', async () => {
    await p.createStore(storeInput);
    cloud.agent = (op) => {
      cloud.objects.set('backups/b-1.zip', new Uint8Array(1234));
      return { status: 'success', message: `WAAS_RESULT ${JSON.stringify(op === 'snapshot' ? { sizeBytes: 1234 } : {})}` };
    };
    expect(await p.backupStore({ storeId: STORE_ID, backupId: 'b-1' })).toEqual({ sizeBytes: 1234 });
    await p.deleteBackup({ backupId: 'b-1' });
    expect(cloud.objects.has('backups/b-1.zip')).toBe(false);
  });

  it('rolls back a store whose WordPress is gone, to its main domain on record', async () => {
    await p.createStore(storeInput);
    cloud.objects.set('backups/b-1.zip', new Uint8Array(10));
    const agent = cloud.agent;
    cloud.agent = (op, args, service) => (op === 'home' ? { status: 'success', message: 'WAAS_RESULT {"home":null}' } : agent(op, args, service));
    await expect(p.rollbackStore({ storeId: STORE_ID, backupId: 'b-1', wpOptions: {} })).rejects.toThrow(/did not report the home URL/);
    const before = cloud.agentOps.length;
    await p.rollbackStore({ storeId: STORE_ID, backupId: 'b-1', wpOptions: {}, mainDomain: 'shop.example.org' });
    const restore = cloud.agentOps.slice(before).find((o) => o.op === 'restore')!;
    expect(restore.args).toMatchObject({ home: 'https://shop.example.org' });
  });

  it('rolls a store back to a backup in place: same main domain, its current code, its options again', async () => {
    await p.createStore(storeInput);
    await expect(p.rollbackStore({ storeId: STORE_ID, backupId: 'b-1', wpOptions: {} })).rejects.toThrow(/No archive at backups\/b-1\.zip/);
    expect(cloud.agentOps.map((o) => o.op)).not.toContain('home');
    cloud.objects.set('backups/b-1.zip', new Uint8Array(10));
    const before = cloud.agentOps.length;
    await p.rollbackStore({ storeId: STORE_ID, backupId: 'b-1', wpOptions: { blogname: 'Example Store' } });
    const ops = cloud.agentOps.slice(before).filter((o) => o.op !== 'ping');
    expect(ops.map((o) => o.op)).toEqual(['home', 'restore', 'code-import', 'update-db', 'configure']);
    expect(ops[1]!.args).toMatchObject({ home: 'https://shop.example.com' });
    expect(String(ops[1]!.args.url)).toMatch(/^https:\/\/s3\.test\/waas-stores\/backups\/b-1\.zip\?/);
    expect(String(ops[2]!.args.url)).toContain(`/versions/${VERSION_ID}/code.zip`);
    expect(ops[4]!.args).toEqual({ options: { blogname: 'Example Store' } });
  });

  it('replaces the phpConstants with the complete set it is given, and restarts', async () => {
    await p.createStore(storeInput);
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    const starts = store.started;
    await p.updateStore({ storeId: STORE_ID, phpConstants: { ...storeInput.phpConstants, WPCS_TENANT_ROLES: { value: 'editor' } }, wpOptions: { blogdescription: 'New' } });
    const constants = JSON.parse(Buffer.from(store.envs.get('WAAS_CONSTANTS_B64')!.value, 'base64').toString());
    expect(constants).toEqual({ WPCS_TENANT_ROLES: 'editor', API_SECRET: 'private-constant-value' });
    expect(store.started).toBe(starts + 1);
    expect(cloud.agentOps.at(-1)).toMatchObject({ op: 'configure', args: { options: { blogdescription: 'New' } } });
  });

  it('sets domains: new routers, restart, then home follows the main domain', async () => {
    await p.createStore(storeInput);
    await p.setDomains({ storeId: STORE_ID, mainDomain: 'new-shop.example.com', redirectDomains: ['shop.example.com'] });
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    expect(store.urls).toEqual([{ name: 'wordpress', url: 'https://new-shop.example.com,https://shop.example.com' }]);
    expect(cloud.agentOps.at(-1)).toMatchObject({ op: 'configure', args: { home: 'https://new-shop.example.com' } });
  });

  it('after a restart, waits for Coolify to show it before waiting for healthy (statuses lag the call)', async () => {
    await p.createStore(storeInput);
    cloud.addVersion('v9');
    await p.setDomains({ storeId: STORE_ID, mainDomain: 'new-shop.example.com', redirectDomains: [] });
    await p.updateStore({ storeId: STORE_ID, phpConstants: storeInput.phpConstants, wpOptions: { blogdescription: 'New' } });
    await p.moveStore({ storeId: STORE_ID, targetVersionId: 'v9' });
    for (const [uuid, t] of cloud.tasks) if (t.name === CRON_TASK.name) cloud.tasks.delete(uuid);
    await p.ensureStoreCron({ storeId: STORE_ID });
    expect(cloud.calls.filter((c) => c.endsWith('/restart'))).toHaveLength(4);
    // No agent command ran in the old containers.
    expect(cloud.execsDuringRestart).toBe(0);
  });

  it('goes on to wait for healthy when Coolify never shows the restart', async () => {
    p = provisioner(cloud, { restartSeenTimeoutMs: 20 });
    await p.createStore(storeInput);
    cloud.restartPhases = { stale: Number.MAX_SAFE_INTEGER, down: 0 };
    await p.setDomains({ storeId: STORE_ID, mainDomain: 'new-shop.example.com', redirectDomains: [] });
    expect(cloud.agentOps.at(-1)).toMatchObject({ op: 'configure', args: { home: 'https://new-shop.example.com' } });
  });

  it('moves a store: new image, restart, new code, database upgrade', async () => {
    await p.createStore(storeInput);
    cloud.addVersion('v9');
    const v9 = [...cloud.services.values()].find((s) => s.name === 'version-v9')!;
    v9.description = 'WaaS version, WordPress 6.9, PHP 8.4';
    await p.moveStore({ storeId: STORE_ID, targetVersionId: 'v9' });
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    expect(parse(store.compose).services.wordpress.image).toBe('wordpress:6.9-php8.4-apache');
    expect(store.description).toBe(`WaaS store, version v9, setup ${STORE_SETUP}, size small`);
    expect(cloud.agentOps.slice(-2).map((o) => o.op)).toEqual(['code-import', 'update-db']);
  });

  it('deletes a store with all cleanup flags, and a second delete is a no-op', async () => {
    await p.createStore(storeInput);
    await p.deleteStore({ storeId: STORE_ID });
    const isServiceDelete = (c: string) => /^DELETE \/services\/[^/]+\?/.test(c);
    const del = cloud.calls.find(isServiceDelete)!;
    for (const flag of ['delete_configurations=true', 'delete_volumes=true', 'docker_cleanup=true', 'delete_connected_networks=true']) expect(del).toContain(flag);
    expect([...cloud.services.values()].some((s) => s.name === `store-${STORE_ID}`)).toBe(false);
    await p.deleteStore({ storeId: STORE_ID });
    expect(cloud.calls.filter(isServiceDelete)).toHaveLength(1);
  });

  it('tests a restore in a hidden, suspended test store with no mail, key or cron, and deletes it pass or fail', async () => {
    await expect(p.testRestore({ testId: 't-1', backupId: 'b-1', versionId: VERSION_ID, size: 'small' })).rejects.toThrow(/No archive at backups\/b-1\.zip/);
    expect(cloud.calls).not.toContain('POST /services');
    cloud.objects.set('backups/b-1.zip', new Uint8Array(10));
    const agent = cloud.agent;
    cloud.agent = (op, args, service) =>
      op === 'verify' ? { status: 'success', message: 'WAAS_RESULT {"name":"Shop","home":"https://restore-test-t-1.invalid","tables":40,"posts":"12"}' } : agent(op, args, service);
    let seen: Service | undefined;
    const real = cloud.agent;
    cloud.agent = (op, args, service) => ((seen = service), real(op, args, service));

    expect(await p.testRestore({ testId: 't-1', backupId: 'b-1', versionId: VERSION_ID, size: 'medium' })).toEqual({
      name: 'Shop',
      home: 'https://restore-test-t-1.invalid',
      tables: 40,
      posts: 12,
    });
    expect(seen!.name).toBe('store-restore-test-t-1');
    expect(seen!.urls).toEqual([{ name: 'wordpress', url: 'https://restore-test-t-1.invalid' }]);
    expect([...seen!.envs.keys()]).toEqual(['WAAS_CONSTANTS_B64']);
    expect(parse(seen!.compose).services.wordpress.cpus).toBe(2);
    // Suspended before the backup goes in, then checked.
    expect(cloud.agentOps.map((o) => o.op).filter((op) => op !== 'ping')).toEqual(['suspend', 'restore', 'verify']);
    expect(cloud.agentOps.find((o) => o.op === 'restore')!.args).toMatchObject({ home: 'https://restore-test-t-1.invalid' });
    expect(cronTasks(cloud)).toEqual([]);
    expect([...cloud.services.values()].some((s) => s.name === 'store-restore-test-t-1')).toBe(false);

    cloud.agent = (op, args, service) => (op === 'restore' ? { status: 'failed', message: 'WAAS_ERROR wp db exited 1: broken dump' } : agent(op, args, service));
    await expect(p.testRestore({ testId: 't-2', backupId: 'b-1', versionId: VERSION_ID, size: 'small' })).rejects.toThrow('broken dump');
    expect([...cloud.services.values()].some((s) => s.name === 'store-restore-test-t-2')).toBe(false);
  });

  it('copies snapshots and base snapshots in the bucket', async () => {
    await p.copySnapshot({ snapshotId: 'snap-1', newSnapshotId: 'snap-copy', targetVersionId: VERSION_ID });
    expect(cloud.objects.get('snapshots/snap-copy.zip')).toEqual(new Uint8Array([80, 75, 5, 6]));
    await expect(p.copyBaseSnapshot({ baseSnapshotId: 'nope', newSnapshotId: 'x', targetVersionId: VERSION_ID })).rejects.toThrow(/No base snapshot/);
    expect(await p.downloadSnapshot({ snapshotId: 'snap-1' })).toEqual(new Uint8Array([80, 75, 5, 6]));
  });
});

describe('Service metadata', () => {
  it('round-trips store and version descriptions', () => {
    for (const meta of [
      { kind: 'version' as const, wordPressVersion: '6.8', phpVersion: '8.3' },
      { kind: 'store' as const, versionId: VERSION_ID, setup: STORE_SETUP, size: 'small' as const },
      { kind: 'store' as const, versionId: VERSION_ID, setup: 2, size: 'large' as const },
    ]) {
      expect(parseMeta(formatMeta(meta))).toEqual(meta);
    }
  });

  it('reads descriptions from before setups and sizes as setup 1 and small', () => {
    expect(parseMeta(`WaaS store, version ${VERSION_ID}`)).toEqual({ kind: 'store', versionId: VERSION_ID, setup: 1, size: 'small' });
    expect(parseMeta(`WaaS store, version ${VERSION_ID}, setup 2`)).toEqual({ kind: 'store', versionId: VERSION_ID, setup: 2, size: 'small' });
    expect(parseMeta(`WaaS store, version ${VERSION_ID}, setup 3, size huge`)).toBeNull();
  });
});

describe('Store compose file', () => {
  it('gives each size its CPUs, memory, Apache workers and quotas, and the database and agent the same', () => {
    const want = {
      small: { cpus: 1, mem: '512m', workers: 8, storage: '5', emails: '5000' },
      medium: { cpus: 2, mem: '512m', workers: 16, storage: '10', emails: '20000' },
      large: { cpus: 4, mem: '768m', workers: 32, storage: '25', emails: '50000' },
    };
    for (const [size, w] of Object.entries(want)) {
      const compose = parse(renderCompose({ wordPressVersion: '6.8', phpVersion: '8.3', size: size as keyof typeof want }));
      const wordpress = compose.services.wordpress;
      expect(wordpress).toMatchObject({ cpus: w.cpus, mem_limit: w.mem });
      expect(wordpress.entrypoint[2]).toContain(`MaxRequestWorkers ${w.workers}\\n`);
      // The agent runs WordPress's cron, so it sees the quotas too.
      for (const service of [wordpress, compose.services.agent]) {
        expect(service.environment).toMatchObject({ WAAS_STORAGE_GB: w.storage, WAAS_EMAILS_PER_MONTH: w.emails });
      }
      expect(compose.services.db.mem_limit).toBe('384m');
      expect(compose.services.agent.mem_limit).toBe('256m');
    }
  });

  it('runs a version site as small, without quotas', () => {
    const compose = parse(renderCompose({ wordPressVersion: '6.8', phpVersion: '8.3' }));
    expect(compose.services.wordpress).toMatchObject({ cpus: 1, mem_limit: '512m' });
    expect(compose.services.wordpress.environment).not.toHaveProperty('WAAS_STORAGE_GB');
    expect(compose.services.agent.environment).not.toHaveProperty('WAAS_EMAILS_PER_MONTH');
  });

  it('uses `$` only for the variables Coolify fills in', () => {
    const compose = renderCompose({ wordPressVersion: '6.8', phpVersion: '8.3', size: 'large' });
    const vars = compose.match(/\$\{?[A-Za-z0-9_]*/g) ?? [];
    expect(new Set(vars)).toEqual(new Set(['${SERVICE_PASSWORD_DB', '${SERVICE_PASSWORD_ROOT', '${WAAS_CONSTANTS_B64', '${WAAS_MAIL_B64', '${WAAS_INIT_PASSWORD', '${WAAS_SITE_KEY']));
    const parsed = parse(compose);
    expect(Buffer.from(parsed.services.agent.environment.WAAS_AGENT_B64, 'base64').toString()).toBe(AGENT_SCRIPT);
  });

  it('turns off WP-cron on page loads, after the phpConstants so a constant of that name wins', () => {
    const extra: string = parse(renderCompose({ wordPressVersion: '6.8', phpVersion: '8.3' })).services.wordpress.environment.WORDPRESS_CONFIG_EXTRA;
    expect(extra).toContain("defined('DISABLE_WP_CRON') || define('DISABLE_WP_CRON', true);");
    expect(extra.indexOf('WAAS_CONSTANTS_B64')).toBeLessThan(extra.indexOf('DISABLE_WP_CRON'));
  });

  it('turns on the page cache drop-in, after the phpConstants so a constant of that name wins', () => {
    const extra: string = parse(renderCompose({ wordPressVersion: '6.8', phpVersion: '8.3' })).services.wordpress.environment.WORDPRESS_CONFIG_EXTRA;
    expect(extra.endsWith("defined('WP_CACHE') || define('WP_CACHE', true);")).toBe(true);
    expect(extra).not.toContain('$');
  });

  it('caps Apache at 8 workers so a burst of visitors queues instead of running the store out of memory', () => {
    const wordpress = parse(renderCompose({ wordPressVersion: '6.8', phpVersion: '8.3' })).services.wordpress;
    const [shell, flag, script] = wordpress.entrypoint;
    expect([shell, flag]).toEqual(['sh', '-c']);
    expect(script).toContain('MaxRequestWorkers 8');
    expect(script).toContain('> /etc/apache2/conf-enabled/waas-workers.conf');
    // The official image still sets WordPress up: its entrypoint only does that for an apache2* command.
    expect(script.endsWith('&& exec docker-entrypoint.sh apache2-foreground')).toBe(true);
  });

  it('keeps the exact Apache and PHP versions out of response headers', () => {
    const script = parse(renderCompose({ wordPressVersion: '7.1', phpVersion: '8.3' })).services.wordpress.entrypoint[2];
    expect(script).toContain("printf 'ServerTokens Prod\\nServerSignature Off\\n' > /etc/apache2/conf-enabled/waas-hide-versions.conf");
    expect(script).toContain("printf 'expose_php = Off\\n' > /usr/local/etc/php/conf.d/waas-hide-versions.ini");
    expect(script).not.toContain('$');
  });

  it('rejects versions that would not make a valid image tag', () => {
    expect(() => renderCompose({ wordPressVersion: 'latest; rm -rf /', phpVersion: '8.3' })).toThrow(/Unsupported/);
  });
});

describe('S3', () => {
  const s3 = new S3(
    { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'waas-stores', region: 'auto', accessKeyId: 'TESTKEY', secretAccessKey: 'test-secret-not-real' },
    fetch,
    () => new Date('2026-10-07T08:00:00Z'),
  );

  it('pre-signs path-style URLs without leaking the secret', () => {
    const url = new URL(s3.presign('PUT', 'snapshots/a b.zip', 900));
    expect(url.pathname).toBe('/waas-stores/snapshots/a%20b.zip');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('TESTKEY/20261007/auto/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261007T080000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.toString()).not.toContain('test-secret-not-real');
  });

  it('signs deterministically for the same input and differently per method', () => {
    expect(s3.presign('GET', 'k')).toBe(s3.presign('GET', 'k'));
    expect(s3.presign('GET', 'k')).not.toBe(s3.presign('PUT', 'k'));
  });
});

describe('Provisioner selection', () => {
  const base = { DATABASE_URL: 'postgres://x', SECRETS_KEY: 'k' };

  it('defaults to the fake and requires the Coolify settings when asked for Coolify', () => {
    expect(loadConfig(base).provisioner).toBe('fake');
    expect(loadConfig(base).coolify).toBeUndefined();
    expect(() => loadConfig({ ...base, PROVISIONER: 'coolify' })).toThrow(/COOLIFY_URL is required/);
    expect(() => loadConfig({ ...base, PROVISIONER: 'other' })).toThrow(/fake or coolify/);
    const config = loadConfig({
      ...base,
      PROVISIONER: 'coolify',
      COOLIFY_URL: COOLIFY,
      COOLIFY_SERVER_UUID: SERVER,
      COOLIFY_PROJECT_UUID: PROJECT,
      S3_ENDPOINT: S3_ENDPOINT,
      S3_BUCKET: 'waas-stores',
      S3_ACCESS_KEY_ID: 'TESTKEY',
      S3_SECRET_ACCESS_KEY: 'test-secret-not-real',
    });
    expect(config.coolify).toMatchObject({ url: COOLIFY, serverUuid: SERVER, projectUuid: PROJECT, token: undefined, s3: { region: 'auto' } });
  });

  it('turns store mail on with STORE_SMTP_PASSWORD, defaulting to toSend', () => {
    const coolify = {
      ...base,
      PROVISIONER: 'coolify',
      COOLIFY_URL: COOLIFY,
      COOLIFY_SERVER_UUID: SERVER,
      COOLIFY_PROJECT_UUID: PROJECT,
      S3_ENDPOINT: S3_ENDPOINT,
      S3_BUCKET: 'waas-stores',
      S3_ACCESS_KEY_ID: 'TESTKEY',
      S3_SECRET_ACCESS_KEY: 'test-secret-not-real',
    };
    expect(loadConfig(coolify).coolify?.mail).toBeUndefined();
    expect(() => loadConfig({ ...coolify, STORE_SMTP_PASSWORD: 'tsend_x' })).toThrow(/STORE_MAIL_FROM/);
    expect(loadConfig({ ...coolify, STORE_SMTP_PASSWORD: 'tsend_x\n', STORE_MAIL_FROM: 'store@mail.example' }).coolify?.mail).toEqual({
      host: 'smtp.tosend.com',
      port: 587,
      user: 'tosend',
      pass: 'tsend_x',
      from: 'store@mail.example',
    });
    expect(() => loadConfig({ ...coolify, STORE_SMTP_PASSWORD: 'x', STORE_MAIL_FROM: 'a@b.example', STORE_SMTP_PORT: 'smtp' })).toThrow(/STORE_SMTP_PORT/);
  });

  it('turns per-store toSend keys on with TOSEND_ADMIN_KEY, and refuses a sending key there', () => {
    const coolify = {
      ...base,
      PROVISIONER: 'coolify',
      COOLIFY_URL: COOLIFY,
      COOLIFY_SERVER_UUID: SERVER,
      COOLIFY_PROJECT_UUID: PROJECT,
      S3_ENDPOINT: S3_ENDPOINT,
      S3_BUCKET: 'waas-stores',
      S3_ACCESS_KEY_ID: 'TESTKEY',
      S3_SECRET_ACCESS_KEY: 'test-secret-not-real',
    };
    const mail = { STORE_SMTP_PASSWORD: 'tsend_x', STORE_MAIL_FROM: 'no-reply@mail.example' };
    expect(loadConfig({ ...coolify, ...mail }).coolify?.mailKeys).toBeUndefined();
    expect(loadConfig({ ...coolify, ...mail, TOSEND_ADMIN_KEY: 'tsend_admin_x' }).coolify?.mailKeys).toBeDefined();
    // The same admin key counts each store's email on toSend.
    expect(loadConfig({ ...coolify, ...mail }).mailCounter).toBeUndefined();
    expect(loadConfig({ ...coolify, ...mail, TOSEND_ADMIN_KEY: 'tsend_admin_x' }).mailCounter).toBeDefined();
    expect(() => loadConfig({ ...coolify, ...mail, TOSEND_ADMIN_KEY: 'tsend_x' })).toThrow(/admin key/);
    expect(() => loadConfig({ ...coolify, TOSEND_ADMIN_KEY: 'tsend_admin_x' })).toThrow(/STORE_SMTP_PASSWORD/);
  });

  it('trims the release bucket settings, so a key pasted with a trailing newline still signs', () => {
    expect(loadConfig(base).releases).toBeUndefined();
    expect(loadConfig({ ...base, RELEASES_S3_BUCKET: ' \n' }).releases).toBeUndefined();
    const releases = loadConfig({
      ...base,
      RELEASES_S3_BUCKET: 'waas-releases\n',
      S3_ENDPOINT: `${S3_ENDPOINT}\n`,
      S3_ACCESS_KEY_ID: 'BACKUPKEY',
      S3_SECRET_ACCESS_KEY: 'backup-secret',
      RELEASES_S3_ACCESS_KEY_ID: ' READKEY\n',
      RELEASES_S3_SECRET_ACCESS_KEY: 'read-secret\r\n',
    }).releases;
    expect(releases).toEqual({ endpoint: S3_ENDPOINT, bucket: 'waas-releases', region: 'auto', accessKeyId: 'READKEY', secretAccessKey: 'read-secret', virtualHost: true });
    // A blank RELEASES_ value falls back to the backup one, as an unset one does.
    expect(loadConfig({ ...base, RELEASES_S3_BUCKET: 'waas-releases', S3_ENDPOINT, S3_ACCESS_KEY_ID: 'BACKUPKEY', S3_SECRET_ACCESS_KEY: 'backup-secret', RELEASES_S3_ACCESS_KEY_ID: '\n' }).releases?.accessKeyId).toBe('BACKUPKEY');
  });
});

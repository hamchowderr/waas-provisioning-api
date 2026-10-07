import { parse } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { AGENT_SCRIPT, renderCompose } from '../src/provisioner/coolify/compose.ts';
import { CoolifyProvisioner } from '../src/provisioner/coolify/provisioner.ts';
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
  envs: Map<string, { uuid: string; value: string }>;
  started: number;
}

/** An in-memory Coolify API and S3 bucket, served through a fetch stub. */
class FakeCloud {
  environments = new Map<string, number>([['stores', 11]]);
  services = new Map<string, Service>();
  tasks = new Map<string, { service: string; command: string; container: string; executions: { uuid: string; status: string; message: string }[] }>();
  objects = new Map<string, Uint8Array>();
  calls: string[] = [];
  /** What the agent does for each command. Defaults to success. */
  agent: (op: string, args: Record<string, unknown>, service: Service) => { status: string; message: string } = (op) => ({
    status: 'success',
    message: `WAAS_RESULT ${JSON.stringify(op === 'snapshot' ? { sizeBytes: 42 } : op === 'home' ? { home: 'https://shop.example.com' } : {})}`,
  });
  agentOps: { op: string; args: Record<string, unknown>; service: string }[] = [];
  staged = new Map<string, string>();
  longestCommand = 0;
  private seq = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.origin === S3_ENDPOINT) return this.s3(method, url, init?.headers as Record<string, string>);
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
        const status = service.started ? 'running:healthy' : 'exited';
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
        service.started++;
        return json(200, { message: 'queued' });
      }
      if (rest === '/envs' && method === 'GET') return json(200, [...service.envs].map(([key, e]) => ({ uuid: e.uuid, key, value: e.value, real_value: e.value })));
      if (rest === '/envs/bulk' && method === 'PATCH') {
        for (const { key, value } of body.data) service.envs.set(key, { uuid: `env-${++this.seq}`, value });
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
        this.tasks.set(uuid, { service: service.uuid, command: body.command, container: body.container, executions: [] });
        return json(201, { uuid, ...body });
      }
      if ((m = /^\/scheduled-tasks\/([^/]+)\/execute$/.exec(rest)) && method === 'POST') {
        const task = this.tasks.get(m[1]!)!;
        const [, , op, arg, chunk] = task.command.split(' ');
        if (op === 'stage') {
          this.staged.set(arg!, (this.staged.get(arg!) ?? '') + chunk);
          task.executions.push({ uuid: `exec-${++this.seq}`, status: 'success', message: 'WAAS_RESULT []' });
          return json(200, { message: 'queued' });
        }
        const payload = arg!.startsWith('@') ? this.staged.get(arg!.slice(1))! : arg!;
        const args = JSON.parse(Buffer.from(payload, 'base64').toString());
        this.agentOps.push({ op: op!, args, service: service.uuid });
        task.executions.push({ uuid: `exec-${++this.seq}`, ...this.agent(op!, args, service) });
        return json(200, { message: 'queued' });
      }
      if ((m = /^\/scheduled-tasks\/([^/]+)\/executions$/.exec(rest)) && method === 'GET') return json(200, this.tasks.get(m[1]!)!.executions);
      if ((m = /^\/scheduled-tasks\/([^/]+)$/.exec(rest)) && method === 'DELETE') {
        this.tasks.delete(m[1]!);
        return json(200, { message: 'Scheduled task deleted.' });
      }
    }
    return json(404, { message: `No route ${method} ${path}` });
  };

  private s3(method: string, url: URL, headers: Record<string, string>): Response {
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

function provisioner(cloud: FakeCloud) {
  return new CoolifyProvisioner({
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
    expect(store.description).toBe(`WaaS store, version ${VERSION_ID}`);
    expect(store.urls).toEqual([{ name: 'wordpress', url: 'https://shop.example.com,https://t-0b8f6a0e.stores.example.com' }]);
    const compose = parse(store.compose);
    expect(compose.services.wordpress.image).toBe('wordpress:6.8-php8.3-apache');
    expect(compose.services.wordpress.mem_limit).toBe('512m');
    expect(compose.services.agent.image).toBe('wordpress:cli-php8.3');
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
    expect(cloud.tasks.size).toBe(0);
  });

  it('stages arguments too long for one task command, keeping every command within 255 characters', async () => {
    await p.createStore({ ...storeInput, wpOptions: { blogname: 'Example Store', blogdescription: 'x'.repeat(2000) } });
    expect(cloud.staged.size).toBeGreaterThan(0);
    expect(cloud.longestCommand).toBeLessThanOrEqual(255);
    // The staged arguments arrive whole.
    expect(cloud.agentOps.find((o) => o.op === 'configure')!.args.options).toEqual({ blogname: 'Example Store', blogdescription: 'x'.repeat(2000) });
    expect(String(cloud.agentOps.find((o) => o.op === 'restore')!.args.url)).toContain('X-Amz-Signature=');
    expect(cloud.tasks.size).toBe(0);
  });

  it('is idempotent: a retried create reuses the Service', async () => {
    await p.createStore(storeInput);
    await p.createStore(storeInput);
    expect([...cloud.services.values()].filter((s) => s.name === `store-${STORE_ID}`)).toHaveLength(1);
    expect(cloud.calls.filter((c) => c === 'POST /services')).toHaveLength(1);
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
    expect(cloud.agentOps.map((o) => o.op)).toEqual(['ping', 'restore', 'code-export']);
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
  });

  it('reports an agent failure with its message and still deletes the task', async () => {
    await p.createStore(storeInput);
    cloud.agent = () => ({ status: 'failed', message: 'some output\nWAAS_ERROR wp db export exited 1: disk full\n' });
    await expect(p.snapshotStore({ storeId: STORE_ID, snapshotId: 'snap-2' })).rejects.toThrow('Store agent snapshot failed (failed): wp db export exited 1: disk full');
    expect(cloud.tasks.size).toBe(0);
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

  it('moves a store: new image, restart, new code, database upgrade', async () => {
    await p.createStore(storeInput);
    cloud.addVersion('v9');
    const v9 = [...cloud.services.values()].find((s) => s.name === 'version-v9')!;
    v9.description = 'WaaS version, WordPress 6.9, PHP 8.4';
    await p.moveStore({ storeId: STORE_ID, targetVersionId: 'v9' });
    const store = [...cloud.services.values()].find((s) => s.name === `store-${STORE_ID}`)!;
    expect(parse(store.compose).services.wordpress.image).toBe('wordpress:6.9-php8.4-apache');
    expect(store.description).toBe('WaaS store, version v9');
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

  it('copies snapshots and base snapshots in the bucket', async () => {
    await p.copySnapshot({ snapshotId: 'snap-1', newSnapshotId: 'snap-copy', targetVersionId: VERSION_ID });
    expect(cloud.objects.get('snapshots/snap-copy.zip')).toEqual(new Uint8Array([80, 75, 5, 6]));
    await expect(p.copyBaseSnapshot({ baseSnapshotId: 'nope', newSnapshotId: 'x', targetVersionId: VERSION_ID })).rejects.toThrow(/No base snapshot/);
    expect(await p.downloadSnapshot({ snapshotId: 'snap-1' })).toEqual(new Uint8Array([80, 75, 5, 6]));
  });
});

describe('Store compose file', () => {
  it('uses `$` only for the variables Coolify fills in', () => {
    const compose = renderCompose({ wordPressVersion: '6.8', phpVersion: '8.3' });
    const vars = compose.match(/\$\{?[A-Za-z0-9_]*/g) ?? [];
    expect(new Set(vars)).toEqual(new Set(['${SERVICE_PASSWORD_DB', '${SERVICE_PASSWORD_ROOT', '${WAAS_CONSTANTS_B64', '${WAAS_INIT_PASSWORD']));
    const parsed = parse(compose);
    expect(Buffer.from(parsed.services.agent.environment.WAAS_AGENT_B64, 'base64').toString()).toBe(AGENT_SCRIPT);
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
});

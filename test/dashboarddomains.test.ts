// Sellers' own dashboard addresses (docs/branding.md): setting, checking and removing one through a
// fake host, who may set one, the nightly check, and the Vercel calls behind it. Admin answers are
// checked against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { testUtils } from 'better-auth/plugins';
import { parse } from 'yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { maintainDashboardDomains } from '../src/dashboarddomains.ts';
import { createAjv } from '../src/openapi.ts';
import { CoolifyDashboardDomains } from '../src/coolifydashboard.ts';
import { loadDashboardHost, VercelDomains, VercelError, type DashboardHost, type HostDomainState } from '../src/vercel.ts';
import { setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

const AUTH: AuthConfig = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789' };

let t: TestContext;
let app: ReturnType<typeof createApp>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let helpers: any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');

async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await app.request(`/admin${path}`, {
    method,
    headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) {
    const opPath = Object.keys(adminSpec.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(`/admin${path}`))!;
    const schema = adminSpec.paths[opPath][method.toLowerCase()].responses[String(res.status)].content['application/json'].schema;
    const validate = ajv.compile(JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"admin#/components/')));
    const json = await res.clone().json();
    expect(validate(json), `${method} ${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
  return res;
}

const asUser = (cookie: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { Cookie: cookie, 'X-Session-Auth': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signedIn(email: string, productId: string, role: string) {
  const user = await helpers.saveUser(helpers.createUser({ email, name: email.split('@')[0], emailVerified: true }));
  const { rows } = await t.pool.query(
    `INSERT INTO auth.organization (name, slug, "createdAt", "productId") VALUES ('Team', $1::text, now(), $1::uuid)
     ON CONFLICT ("productId") DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [productId],
  );
  await t.pool.query(`INSERT INTO auth.member ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, now())`, [rows[0].id, user.id, role]);
  const { headers } = await helpers.login({ userId: user.id });
  return (headers as Headers).get('cookie')!;
}

/** A host that keeps domains in memory; `ready` holds the ones whose DNS is right. */
class FakeHost implements DashboardHost {
  readonly name = 'fake';
  domains = new Set<string>();
  ready = new Set<string>();
  failRemove = false;
  refuse?: Error;
  private state(domain: string): HostDomainState {
    const ok = this.ready.has(domain);
    return { verified: true, configured: ok, records: ok ? [] : [{ type: 'CNAME', name: domain, value: 'cname.vercel-dns.com' }] };
  }
  async add(domain: string) {
    if (this.refuse) throw this.refuse;
    this.domains.add(domain);
    return this.state(domain);
  }
  async check(domain: string) {
    return this.state(domain);
  }
  async remove(domain: string) {
    if (this.failRemove) throw new Error('host is down');
    this.domains.delete(domain);
  }
}

let host: FakeHost;
let other: string;

beforeAll(async () => {
  t = await setup();
  const auth = createAuth(t.pool, AUTH, [testUtils()]);
  helpers = ((await auth.$context) as unknown as { test: unknown }).test;
  t.deps.config.auth = AUTH;
  t.deps.auth = auth;
  app = createApp(t.deps);
  other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Other storefront') RETURNING id")).rows[0]!.id;
});

beforeEach(async () => {
  host = new FakeHost();
  t.deps.config.dashboardHost = host;
  await t.pool.query('DELETE FROM dashboard_domains');
});

afterAll(() => t.close());

const path = (productId = t.productId) => `/products/${productId}/dashboard-domain`;

describe('dashboard addresses (admin)', () => {
  it('sets one, lists the DNS records to add, and goes active once the DNS is right', async () => {
    expect(await (await admin('GET', path())).json()).toEqual({ enabled: true, dashboardDomain: null });
    const set = await admin('PUT', path(), { domain: 'https://Dashboard.JaneDesigns.example/' });
    expect(set.status).toBe(200);
    const { dashboardDomain } = await set.json();
    expect(dashboardDomain).toMatchObject({ domain: 'dashboard.janedesigns.example', status: 'pending', records: [{ type: 'CNAME', value: 'cname.vercel-dns.com' }] });
    expect(host.domains.has('dashboard.janedesigns.example')).toBe(true);
    host.ready.add('dashboard.janedesigns.example');
    const checked = await (await admin('POST', `${path()}/check`)).json();
    expect(checked.dashboardDomain).toMatchObject({ status: 'active', records: [], error: null });
  });

  it('replaces the address before, and removes it', async () => {
    await admin('PUT', path(), { domain: 'one.jane.example' });
    await admin('PUT', path(), { domain: 'two.jane.example' });
    expect([...host.domains]).toEqual(['two.jane.example']);
    expect((await admin('DELETE', path())).status).toBe(200);
    expect(host.domains.size).toBe(0);
    expect((await admin('DELETE', path())).status).toBe(404);
  });

  it("refuses the platform's own domains, bare domains, and ones in use", async () => {
    for (const domain of ['dash.waas.example', 'x.brand.example', 'jane.example', 'not a domain']) {
      expect((await admin('PUT', path(), { domain })).status, domain).toBe(400);
    }
    const other = (await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Other') RETURNING id")).rows[0]!.id;
    await admin('PUT', path(other), { domain: 'dashboard.taken.example' });
    expect((await admin('PUT', path(), { domain: 'dashboard.taken.example' })).status).toBe(400);
  });

  it("passes on the host's refusal in words", async () => {
    host.refuse = new VercelError(409, 'domain_already_in_use', 'Cannot add');
    const res = await admin('PUT', path(), { domain: 'dashboard.elsewhere.example' });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/already used by another site/);
  });

  it('answers 503 when the server does not offer own addresses', async () => {
    t.deps.config.dashboardHost = undefined;
    expect(await (await admin('GET', path())).json()).toEqual({ enabled: false, dashboardDomain: null });
    expect((await admin('PUT', path(), { domain: 'dashboard.jane.example' })).status).toBe(503);
  });
});

describe('dashboard addresses (signed in)', () => {
  it("lets a seller's owner set theirs, members only look, and no one reach another storefront's", async () => {
    const owner = await signedIn('owner@seller.example', t.productId, 'owner');
    expect((await asUser(owner, 'PUT', `/account${path()}`, { domain: 'dashboard.seller.example' })).status).toBe(200);
    const member = await signedIn('member@seller.example', t.productId, 'member');
    expect((await asUser(member, 'GET', `/account${path()}`)).status).toBe(200);
    expect((await asUser(member, 'DELETE', `/account${path()}`)).status).toBe(403);
    expect((await asUser(owner, 'GET', `/account${path(other)}`)).status).toBe(404);
  });
});

describe('nightly check', () => {
  it('activates addresses whose DNS is now right, and retries removals the host missed', async () => {
    await admin('PUT', path(), { domain: 'dashboard.later.example' });
    host.failRemove = true;
    await admin('PUT', path(), { domain: 'dashboard.next.example' });
    const { rows } = await t.pool.query("SELECT domain, status, product_id FROM dashboard_domains ORDER BY domain");
    expect(rows).toEqual([
      { domain: 'dashboard.later.example', status: 'removing', product_id: null },
      { domain: 'dashboard.next.example', status: 'pending', product_id: t.productId },
    ]);
    host.failRemove = false;
    host.ready.add('dashboard.next.example');
    await maintainDashboardDomains(t.pool, host);
    const after = await t.pool.query('SELECT domain, status FROM dashboard_domains');
    expect(after.rows).toEqual([{ domain: 'dashboard.next.example', status: 'active' }]);
    expect(host.domains.has('dashboard.later.example')).toBe(false);
  });
});

describe('the Vercel calls', () => {
  /** A fake Vercel API: answers by method and path, and records each call. */
  function fakeVercel(routes: Record<string, () => { status: number; body?: unknown }>) {
    const calls: string[] = [];
    const fetchFn = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      calls.push(`${key}?${url.searchParams}`);
      const route = routes[key];
      const { status, body } = route ? route() : { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { calls, vercel: new VercelDomains({ token: 'tok', projectId: 'prj_1', teamId: 'team_1' }, fetchFn) };
  }

  it('adds a new domain to the project and reports the CNAME to add', async () => {
    const { calls, vercel } = fakeVercel({
      'POST /v10/projects/prj_1/domains': () => ({ status: 200, body: { name: 'dashboard.jane.example', verified: true } }),
      'GET /v6/domains/dashboard.jane.example/config': () => ({ status: 200, body: { misconfigured: true, recommendedCNAME: [{ rank: 1, value: 'abc.vercel-dns-017.com.' }] } }),
    });
    expect(await vercel.add('dashboard.jane.example')).toEqual({
      verified: true,
      configured: false,
      records: [{ type: 'CNAME', name: 'dashboard.jane.example', value: 'abc.vercel-dns-017.com' }],
    });
    expect(calls[0]).toBe('GET /v9/projects/prj_1/domains/dashboard.jane.example?teamId=team_1');
  });

  it('asks for the TXT record while ownership is unproven, and verifies once asked to check', async () => {
    let verified = false;
    const domain = () => ({
      status: 200,
      body: { name: 'dashboard.jane.example', verified, verification: [{ type: 'TXT', domain: '_vercel.jane.example', value: 'vc-domain-verify=x' }] },
    });
    const { vercel } = fakeVercel({
      'GET /v9/projects/prj_1/domains/dashboard.jane.example': domain,
      'POST /v9/projects/prj_1/domains/dashboard.jane.example/verify': () => (verified ? domain() : { status: 400, body: { error: { code: 'missing_txt_record', message: 'TXT missing' } } }),
      'GET /v6/domains/dashboard.jane.example/config': () => ({ status: 200, body: { misconfigured: false } }),
    });
    expect((await vercel.check('dashboard.jane.example')).records).toEqual([{ type: 'TXT', name: '_vercel.jane.example', value: 'vc-domain-verify=x' }]);
    verified = true;
    expect(await vercel.check('dashboard.jane.example')).toEqual({ verified: true, configured: true, records: [] });
  });

  it('removes a domain, and a domain already gone is fine', async () => {
    const { vercel } = fakeVercel({});
    await expect(vercel.remove('gone.jane.example')).resolves.toBeUndefined();
    const failing = fakeVercel({ 'DELETE /v9/projects/prj_1/domains/x.jane.example': () => ({ status: 403, body: { error: { code: 'forbidden', message: 'No access' } } }) });
    await expect(failing.vercel.remove('x.jane.example')).rejects.toThrow('No access');
  });
});

describe('the Coolify option', () => {
  /** A Coolify application with domains, answering GET, PATCH and deploy, and DNS pointing where told. */
  function fakeCoolify(fqdn: string, dns: Record<string, { cname?: string[]; a?: string[] }>) {
    const app = { fqdn };
    const calls: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const path = url.replace('https://coolify.example/api/v1', '');
      calls.push(`${init.method} ${path}`);
      if (init.method === 'PATCH') app.fqdn = JSON.parse(String(init.body)).domains;
      return new Response(JSON.stringify(path.startsWith('/deploy') ? { deployments: [] } : app), { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = (kind: 'cname' | 'a') => async (name: string) => {
      const found = dns[name]?.[kind];
      if (!found) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return found;
    };
    const host = new CoolifyDashboardDomains(
      { url: 'https://coolify.example', token: 't', appUuid: 'app1', target: 'app.platform.example' },
      fetchFn,
      { resolveCname: lookup('cname'), resolve4: lookup('a') },
    );
    return { host, app, calls };
  }

  it('asks for a CNAME, and adds the address and deploys only once the DNS points at the dashboard', async () => {
    const dns: Record<string, { cname?: string[]; a?: string[] }> = { 'app.platform.example': { a: ['203.0.113.5'] } };
    const { host, app, calls } = fakeCoolify('https://app.platform.example', dns);
    expect(await host.add('dash.seller.example')).toEqual({
      verified: true,
      configured: false,
      records: [{ type: 'CNAME', name: 'dash.seller.example', value: 'app.platform.example' }],
    });
    expect(calls).toEqual([]);
    dns['dash.seller.example'] = { cname: ['app.platform.example.'] };
    expect(await host.check('dash.seller.example')).toEqual({ verified: true, configured: true, records: [] });
    expect(app.fqdn).toBe('https://app.platform.example,https://dash.seller.example');
    expect(calls).toEqual(['GET /applications/app1', 'PATCH /applications/app1', 'POST /deploy?uuid=app1&force=false']);
    // Already there: nothing to change.
    await host.check('dash.seller.example');
    expect(calls).toHaveLength(4);
  });

  it('accepts an A record to the same address, and removes only that domain', async () => {
    const dns = { 'app.platform.example': { a: ['203.0.113.5'] }, 'dash.other.example': { a: ['203.0.113.5'] }, 'dash.wrong.example': { a: ['198.51.100.1'] } };
    const { host, app } = fakeCoolify('https://app.platform.example', dns);
    expect((await host.check('dash.wrong.example')).configured).toBe(false);
    expect((await host.check('dash.other.example')).configured).toBe(true);
    await host.remove('dash.other.example');
    expect(app.fqdn).toBe('https://app.platform.example');
  });

  it('is set up from the environment', () => {
    const env = { DASHBOARD_DOMAINS: 'coolify', COOLIFY_URL: 'https://coolify.example', COOLIFY_TOKEN: 't', DASHBOARD_COOLIFY_APP: 'app1', DASHBOARD_TARGET: 'https://app.platform.example/' };
    expect(loadDashboardHost(env)?.name).toBe('coolify');
    expect(() => loadDashboardHost({ ...env, DASHBOARD_TARGET: '' })).toThrow(/DASHBOARD_TARGET/);
    expect(() => loadDashboardHost({ DASHBOARD_DOMAINS: 'netlify' })).toThrow(/vercel, coolify or off/);
  });
});

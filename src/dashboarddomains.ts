import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import type { Pool } from './db.ts';
import { badRequest, HttpError } from './errors.ts';
import { isUuid, readJson, scopedProduct } from './http.ts';
import { domainInUse, normalizeDomain } from './tenants.ts';
import { VercelError, type DashboardHost, type DnsRecord, type HostDomainState } from './vercel.ts';

/**
 * Sellers' own dashboard addresses (docs/branding.md): a storefront's team signs in to the dashboard
 * at dashboard.theirbusiness.com instead of the platform's address. Each one is added to whatever
 * serves the dashboard (config.dashboardHost, Vercel today), which serves it and gets its certificate
 * once the domain's DNS points there. Signed-in sellers and resellers set their own; clients' storefronts
 * are the platform admin's to set.
 */

export type DashboardDomainStatus = 'pending' | 'active' | 'removing';

interface Row {
  id: string;
  domain: string;
  status: DashboardDomainStatus;
  records: DnsRecord[];
  error: string | null;
  checked_at: Date | null;
}

const view = (r: Row) => ({
  domain: r.domain,
  status: r.status,
  records: r.records,
  error: r.error,
  checkedAt: r.checked_at ? r.checked_at.toISOString() : null,
});

const statusOf = (s: HostDomainState): DashboardDomainStatus => (s.verified && s.configured ? 'active' : 'pending');

/** What the host said, in words for the person who typed the domain. */
function hostMessage(err: unknown): string {
  if (err instanceof VercelError) {
    if (err.code === 'domain_already_in_use' || err.status === 409) return 'That domain is already used by another site on our host. Remove it there first, or pick another.';
    if (err.code === 'invalid_domain' || err.status === 400) return `The host refused this domain: ${err.message}`;
    return `The host answered ${err.status}: ${err.message}`;
  }
  return (err as Error).message;
}

/** host → the storefront whose live dashboard address it is, or null; kept 30 seconds. */
const hostCache = new Map<string, { productId: string | null; until: number }>();

/** Forgets what dashboardHostProduct looked up, after an address changes. */
export const forgetDashboardHosts = () => hostCache.clear();

/** The storefront whose live (active) dashboard address `host` is, or null. */
export async function dashboardHostProduct(pool: Pool, host: string): Promise<string | null> {
  const key = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const hit = hostCache.get(key);
  if (hit && hit.until > Date.now()) return hit.productId;
  const { rows } = await pool.query("SELECT product_id FROM dashboard_domains WHERE domain = $1 AND status = 'active' AND product_id IS NOT NULL", [key]);
  const productId = (rows[0]?.product_id as string | undefined) ?? null;
  hostCache.set(key, { productId, until: Date.now() + 30_000 });
  return productId;
}

/** The storefront's live (active) dashboard address, or null. */
export async function activeDashboardDomain(pool: Pool, productId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT domain FROM dashboard_domains WHERE product_id = $1 AND status = 'active'", [productId]);
  return (rows[0]?.domain as string | undefined) ?? null;
}

async function current(pool: Pool, productId: string) {
  const { rows } = await pool.query<Row>("SELECT * FROM dashboard_domains WHERE product_id = $1 AND status <> 'removing'", [productId]);
  return rows[0];
}

/** Removes a domain from the host, or leaves it as 'removing' for maintenance to try again. */
async function release(pool: Pool, host: DashboardHost, row: Pick<Row, 'id' | 'domain'>) {
  forgetDashboardHosts();
  try {
    await host.remove(row.domain);
    await pool.query('DELETE FROM dashboard_domains WHERE id = $1', [row.id]);
  } catch (err) {
    await pool.query("UPDATE dashboard_domains SET status = 'removing', product_id = NULL, error = $2 WHERE id = $1", [row.id, hostMessage(err)]);
  }
}

/**
 * Nightly: checks every address still waiting for its DNS, and drops from the host the ones that
 * couldn't be removed before. One failing doesn't stop the others.
 */
export async function maintainDashboardDomains(pool: Pool, host: DashboardHost | undefined, log: Pick<Console, 'error'> = console) {
  if (!host) return;
  const { rows } = await pool.query<Row>("SELECT * FROM dashboard_domains WHERE status IN ('pending', 'removing') ORDER BY date_created");
  for (const row of rows) {
    try {
      if (row.status === 'removing') await release(pool, host, row);
      else await record(pool, row.id, await host.check(row.domain));
    } catch (err) {
      log.error(`Dashboard domain ${row.domain}: ${hostMessage(err)}`);
    }
  }
}

async function record(pool: Pool, id: string, state: HostDomainState, error: string | null = null) {
  forgetDashboardHosts();
  const { rows } = await pool.query<Row>(
    'UPDATE dashboard_domains SET status = $2, records = $3, error = $4, checked_at = now() WHERE id = $1 RETURNING *',
    [id, statusOf(state), JSON.stringify(state.records), error],
  );
  return rows[0]!;
}

/** GET, PUT and DELETE /products/:productId/dashboard-domain, and POST …/check. In the admin API, and /account. */
export function dashboardDomainRoutes(deps: Deps) {
  const { pool, config } = deps;
  const app = new Hono<AppEnv>();

  async function product(c: Context): Promise<string> {
    const id = c.req.param('productId')!;
    const scope = scopedProduct(c);
    const { rows } = isUuid(id) && (!scope || scope === id)
      ? await pool.query('SELECT p.id, EXISTS (SELECT 1 FROM clients cl WHERE cl.product_id = p.id) AS client FROM products p WHERE p.id = $1', [id])
      : { rows: [] };
    if (!rows[0]) throw new HttpError(404, `Product ${id} not found`);
    // Own dashboard addresses come with an approved seller or reseller account (the owner's call, 2026-10-22).
    if (scope && rows[0].client && c.req.method !== 'GET') throw new HttpError(403, 'Ask us to set up your own dashboard address.');
    return id;
  }

  const host = () => {
    if (!config.dashboardHost) throw new HttpError(503, 'Own dashboard addresses are off on this server (DASHBOARD_DOMAINS)');
    return config.dashboardHost;
  };

  /** A domain the seller may use: valid, not the platform's own, and not taken by a store or another dashboard. */
  async function allowed(input: unknown, productId: string): Promise<string> {
    if (typeof input !== 'string' || !input.trim()) throw badRequest('domain is required, like dashboard.yourbusiness.com');
    const domain = normalizeDomain(input.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
    if (domain.split('.').length < 3) throw badRequest('Use an address under your domain, like dashboard.yourbusiness.com');
    const platform = [config.platformDomain, config.brandDomain, config.storesDomain, config.versionsDomain].filter((d): d is string => !!d);
    if (platform.some((d) => domain === d || domain.endsWith(`.${d}`))) throw badRequest(`${domain} belongs to the platform. Use your own domain.`);
    const mine = await pool.query('SELECT 1 FROM dashboard_domains WHERE domain = $1 AND product_id = $2', [domain, productId]);
    if (!mine.rowCount && (await domainInUse(pool, domain, config.platformDomain, config.brandDomain))) throw badRequest(`${domain} is already in use`);
    return domain;
  }

  app.get('/products/:productId/dashboard-domain', async (c) => {
    const row = await current(pool, await product(c));
    return c.json({ enabled: !!config.dashboardHost, dashboardDomain: row ? view(row) : null });
  });

  // Sets the address, replacing the one before. The answer says which DNS records to add.
  app.put('/products/:productId/dashboard-domain', async (c) => {
    const productId = await product(c);
    const h = host();
    const body = ((await readJson(c)) ?? {}) as { domain?: unknown };
    const domain = await allowed(body.domain, productId);
    const before = await current(pool, productId);
    if (before?.domain === domain) return c.json({ enabled: true, dashboardDomain: view(before) });
    let state: HostDomainState;
    try {
      state = await h.add(domain);
    } catch (err) {
      throw badRequest(hostMessage(err));
    }
    if (before) await release(pool, h, before);
    const { rows } = await pool.query<Row>(
      'INSERT INTO dashboard_domains (product_id, domain, status, records, checked_at) VALUES ($1, $2, $3, $4, now()) RETURNING *',
      [productId, domain, statusOf(state), JSON.stringify(state.records)],
    );
    return c.json({ enabled: true, dashboardDomain: view(rows[0]!) });
  });

  // Asks the host to look again, after the seller has added the records.
  app.post('/products/:productId/dashboard-domain/check', async (c) => {
    const row = await current(pool, await product(c));
    if (!row) throw new HttpError(404, 'This storefront has no dashboard address');
    let updated: Row;
    try {
      updated = await record(pool, row.id, await host().check(row.domain));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const { rows } = await pool.query<Row>('UPDATE dashboard_domains SET error = $2, checked_at = now() WHERE id = $1 RETURNING *', [row.id, hostMessage(err)]);
      updated = rows[0]!;
    }
    return c.json({ enabled: true, dashboardDomain: view(updated) });
  });

  // Stops using the address. The dashboard stays at the platform's address.
  app.delete('/products/:productId/dashboard-domain', async (c) => {
    const row = await current(pool, await product(c));
    if (!row) throw new HttpError(404, 'This storefront has no dashboard address');
    await release(pool, host(), row);
    return c.json({ enabled: true, dashboardDomain: null });
  });

  return app;
}

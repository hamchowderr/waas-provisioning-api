import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { withTransaction, type Client } from '../db.ts';
import { badRequest } from '../errors.ts';
import { readJson, uuidQuery } from '../http.ts';
import { validateBody } from '../openapi.ts';
import { enqueue } from '../queue.ts';
import { Status, statusName } from '../status.ts';
import { domainInUse, findTenant, normalizeDomain } from '../tenants.ts';

interface AddDomainParams {
  domainName: string;
  setAsMainDomain?: boolean;
}

/** Tenant-domain routes, mounted at /v1/tenants. Every change re-applies the domains in a queue job. */
export function domainRoutes({ pool, boss, config }: Deps) {
  const app = new Hono<AppEnv>();

  async function changeableTenant(c: Context<AppEnv>) {
    const tenant = await findTenant(pool, c);
    if (tenant.status === Status.Removing || tenant.status === Status.Failed) {
      throw badRequest(`Tenant ${tenant.external_id} is ${statusName(tenant.status)}`);
    }
    return tenant;
  }

  /** Marks the tenant Pending and queues a job that applies its domains. Runs inside `change`'s transaction. */
  async function applyDomains(tenantId: string, change: (client: Client) => Promise<void>) {
    await withTransaction(pool, async (client) => {
      await change(client);
      await client.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1', [tenantId, Status.Pending]);
      await enqueue(boss, client, { type: 'tenant.domains', tenantId });
    });
  }

  async function addDomain(c: Context<AppEnv>) {
    const tenant = await changeableTenant(c);
    const body = validateBody<AddDomainParams>('AddTenantDomainsParams', await readJson(c));
    const domain = normalizeDomain(body.domainName);
    const setAsMain = body.setAsMainDomain === true;
    const { rows } = await pool.query('SELECT id FROM tenant_domains WHERE tenant_id = $1 AND domain_name = $2', [tenant.id, domain]);
    const existing = rows[0];
    if (!existing && (await domainInUse(pool, domain, config.platformDomain))) throw badRequest(`Domain ${domain} is already in use`);

    if (!existing || setAsMain) {
      await applyDomains(tenant.id, async (client) => {
        if (setAsMain) await client.query('UPDATE tenant_domains SET is_main = false WHERE tenant_id = $1 AND is_main', [tenant.id]);
        if (existing) await client.query('UPDATE tenant_domains SET is_main = true WHERE id = $1', [existing.id]);
        else await client.query('INSERT INTO tenant_domains (tenant_id, domain_name, is_main) VALUES ($1, $2, $3)', [tenant.id, domain, setAsMain]);
      });
    }
    return c.json({ tenantId: tenant.id, externalId: tenant.external_id, domain, setAsMainDomain: setAsMain });
  }

  // Deprecated path, same behaviour.
  app.post('/domain', addDomain);
  app.post('/domains', addDomain);

  app.get('/domains', async (c) => {
    const tenant = await findTenant(pool, c);
    const { rows } = await pool.query('SELECT * FROM tenant_domains WHERE tenant_id = $1 ORDER BY date_created', [tenant.id]);
    return c.json(rows.map((d) => ({ id: d.id, domainName: d.domain_name, isMainDomain: d.is_main, isBaseDomain: d.is_base })));
  });

  /** The tenant's domain named by domainId or domainName (query or body). */
  async function findDomain(tenantId: string, domainId: string | undefined, domainName: string | undefined) {
    if (!domainId && !domainName) throw badRequest('domainId or domainName is required');
    const { rows } = domainId
      ? await pool.query('SELECT * FROM tenant_domains WHERE tenant_id = $1 AND id = $2', [tenantId, domainId])
      : await pool.query('SELECT * FROM tenant_domains WHERE tenant_id = $1 AND domain_name = $2', [tenantId, normalizeDomain(domainName!)]);
    if (!rows[0]) throw badRequest(`Domain ${domainId ?? domainName} not found on this tenant`);
    return rows[0];
  }

  app.delete('/domains', async (c) => {
    const tenant = await changeableTenant(c);
    const domain = await findDomain(tenant.id, uuidQuery(c, 'domainId'), c.req.query('domainName') || undefined);
    if (domain.is_main) throw badRequest('The main domain cannot be removed; set another domain as main first');
    if (domain.is_base) throw badRequest('The base domain cannot be removed');
    await applyDomains(tenant.id, async (client) => {
      await client.query('DELETE FROM tenant_domains WHERE id = $1', [domain.id]);
    });
    return c.json({ id: domain.id, domainName: domain.domain_name });
  });

  app.put('/domains/main', async (c) => {
    const tenant = await changeableTenant(c);
    const body = validateBody<{ domainName?: string; domainId?: string }>('SetMainDomainParams', await readJson(c));
    const domain = await findDomain(tenant.id, body.domainId, body.domainName);
    if (!domain.is_main) {
      await applyDomains(tenant.id, async (client) => {
        await client.query('UPDATE tenant_domains SET is_main = false WHERE tenant_id = $1 AND is_main', [tenant.id]);
        await client.query('UPDATE tenant_domains SET is_main = true WHERE id = $1', [domain.id]);
      });
    }
    return c.json({ id: domain.id, domainName: domain.domain_name });
  });

  // 400 means "not a valid domain" to the storefront plugin; otherwise it reads `available`.
  app.get('/domains/available', async (c) => {
    const domain = normalizeDomain(c.req.query('domain') ?? '');
    return c.json({ available: !(await domainInUse(pool, domain, config.platformDomain)) });
  });

  return app;
}

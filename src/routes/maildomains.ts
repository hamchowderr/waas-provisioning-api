import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { badRequest } from '../errors.ts';
import { readJson } from '../http.ts';
import { getMailDomain, removeMailDomain, setMailDomain } from '../maildomains.ts';
import { findTenant } from '../tenants.ts';
import { assertChangeable } from './domains.ts';

/**
 * A store's own sending domain, for the storefront plugin's customer account page. Mounted at
 * /v1/tenants; outside the WPCS contract (openapi/store-mail.yaml). Same behaviour as the admin
 * API's /admin/tenants/{id}/mail-domain, for the product's own tenants.
 */
export function mailDomainRoutes(deps: Deps) {
  const { pool, config } = deps;
  const app = new Hono<AppEnv>();

  app.get('/mail-domain', async (c) => {
    const tenant = await findTenant(pool, c);
    return c.json({ mailDomain: await getMailDomain(pool, config.sendingDomains, tenant.id) });
  });

  app.put('/mail-domain', async (c) => {
    const tenant = await findTenant(pool, c);
    assertChangeable(tenant);
    const body = (await readJson(c)) as { domainName?: unknown };
    if (typeof body?.domainName !== 'string' || !body.domainName.trim()) throw badRequest('domainName is required');
    const from = config.coolify?.mail?.from;
    if (!from) throw badRequest('Stores send no email: STORE_SMTP_PASSWORD is not set on the API');
    return c.json({ mailDomain: await setMailDomain(pool, config.sendingDomains, tenant.id, body.domainName, from) });
  });

  app.delete('/mail-domain', async (c) => {
    const tenant = await findTenant(pool, c);
    const removed = await removeMailDomain(pool, tenant.id);
    if (!removed) throw badRequest('This store has no sending domain');
    return c.json(removed);
  });

  return app;
}

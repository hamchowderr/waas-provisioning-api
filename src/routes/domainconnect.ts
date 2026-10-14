import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { domainConnectLink, parseService, storeVariables, type DomainConnectLink } from '../domainconnect.ts';
import { badRequest } from '../errors.ts';
import { findTenant } from '../tenants.ts';

/**
 * The Domain Connect link for one of a store's domains, or for its sending domain, given its id.
 * Shared by the storefront route below and the admin API.
 */
export async function storeDomainConnect(deps: Deps, tenantId: string, domainName: string | undefined, serviceName: string | undefined): Promise<DomainConnectLink> {
  const { pool, config } = deps;
  if (!config.domainConnect) throw badRequest('Domain Connect is off: PLATFORM_DOMAIN is not set on the API');
  if (!domainName?.trim()) throw badRequest('domainName is required');
  const service = parseService(serviceName);
  const { domain, variables } = await storeVariables(pool, config.sendingDomains, config.storesDomain, tenantId, domainName, service, deps.domainConnectNet);
  return domainConnectLink(config.domainConnect, domain, service, variables, deps.domainConnectNet);
}

/**
 * GET /v1/tenants/domain-connect?externalId=&domainName=&service=website|email, for the storefront
 * plugin's customer account page. Described in openapi/store-mail.yaml.
 */
export function domainConnectRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.get('/domain-connect', async (c) => {
    const tenant = await findTenant(deps.pool, c);
    return c.json(await storeDomainConnect(deps, tenant.id, c.req.query('domainName'), c.req.query('service')));
  });
  return app;
}

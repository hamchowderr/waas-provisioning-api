import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { badRequest, HttpError } from '../errors.ts';
import { readJson } from '../http.ts';
import { validateBody } from '../openapi.ts';
import { callSite, siteKeys, type SiteRequest } from '../sitekeys.ts';
import { Status, statusName } from '../status.ts';
import { findTenant } from '../tenants.ts';

/**
 * Site editing (docs/site-editing.md, tag TenantSite): passes one request on to the store's WaaS
 * Client site routes, signed with the store's site key, and answers with the store's reply.
 * Mounted at /v1/tenants.
 */
export function siteRoutes(deps: Deps) {
  const { pool, config } = deps;
  const app = new Hono<AppEnv>();
  const keyFor = siteKeys(config.secretsKey);

  app.post('/site', async (c) => {
    const tenant = await findTenant(pool, c);
    const request = validateBody<SiteRequest>('SiteRequestParams', await readJson(c));
    if (tenant.status !== Status.Done) throw badRequest(`Tenant ${tenant.external_id} is ${statusName(tenant.status)}; wait until it is Done`);
    if (tenant.is_suspended) throw badRequest(`Tenant ${tenant.external_id} is suspended`);
    if (!tenant.main_domain) throw badRequest(`Tenant ${tenant.external_id} has no main domain`);
    let answer;
    try {
      answer = await callSite(keyFor(tenant.id), tenant.main_domain, request, deps.siteFetch);
    } catch (error) {
      throw new HttpError(502, `The store did not answer: ${(error as Error).message}`);
    }
    if (answer.status === 401) {
      throw new HttpError(502, 'The store refused the request: it has no site key yet (it gets one on its next setup) or its WaaS Client is older than 2.3.0');
    }
    return c.json({ status: answer.status, body: answer.body });
  });

  return app;
}

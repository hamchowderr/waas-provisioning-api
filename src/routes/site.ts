import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { badRequest, HttpError } from '../errors.ts';
import { isUuid, readJson } from '../http.ts';
import { codeRedirect, issueCode, publicBase, sameRedirectUri } from '../oauth.ts';
import { validateBody } from '../openapi.ts';
import { scopeOf } from '../../mcp/src/scopes.ts';
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

  // The storefront vouches for a store's owner it has signed in (its "website assistant" button), so the
  // owner skips "Sign in with your website": a code for the app's own sign-in (PKCE), for this one website.
  // Nothing new is reachable: the storefront's key can already edit the site through /site.
  app.post('/site/sign-in', async (c) => {
    const tenant = await findTenant(pool, c);
    const { clientId, redirectUri, codeChallenge, state } = validateBody<{ clientId: string; redirectUri: string; codeChallenge: string; state?: string }>(
      'SiteSignInParams',
      await readJson(c),
    );
    if (tenant.status !== Status.Done) throw badRequest(`Tenant ${tenant.external_id} is ${statusName(tenant.status)}; wait until it is Done`);
    if (tenant.is_suspended) throw badRequest(`Tenant ${tenant.external_id} is suspended`);
    const { rows } = isUuid(clientId)
      ? await pool.query<{ redirect_uris: string[] }>('SELECT redirect_uris FROM oauth_clients WHERE id = $1', [clientId])
      : { rows: [] };
    if (!rows[0]) throw badRequest('clientId is not a registered app');
    if (!rows[0].redirect_uris.some((uri) => sameRedirectUri(uri, redirectUri))) throw badRequest('redirectUri is not one the app registered');
    const issuer = publicBase(c, config.publicUrl);
    const code = await issueCode(
      pool,
      { clientId, redirectUri, codeChallenge, resource: `${issuer}/mcp/site` },
      { productId: tenant.product_id, tenantId: tenant.id },
      [scopeOf('site', 'read'), scopeOf('site', 'write')].join(' '),
    );
    return c.json({ redirectUrl: codeRedirect(redirectUri, code, state, issuer) });
  });

  return app;
}

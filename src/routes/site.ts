import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { badRequest, HttpError } from '../errors.ts';
import { readJson } from '../http.ts';
import { clientHasRedirect, createSiteHandoff, siteAuthorizeRequest, storeSignIn } from '../oauth.ts';
import { validateBody } from '../openapi.ts';
import { scopeOf } from '../../mcp/src/scopes.ts';
import { callSite, siteKeys, type SiteRequest } from '../sitekeys.ts';
import { Status, statusName } from '../status.ts';
import { findTenant } from '../tenants.ts';
import { checkAgainstReference } from '../referencecheck.ts';
import { addReferenceProducts } from '../referenceproducts.ts';
import { referenceBundle } from '../references.ts';

/**
 * Site editing (docs/site-editing.md, tag TenantSite): passes one request on to the store's AnyPress
 * Client site routes, signed with the store's site key, and answers with the store's reply.
 * Mounted at /v1/tenants.
 */
export function siteRoutes(deps: Deps) {
  const { pool, config } = deps;
  const app = new Hono<AppEnv>();
  const keyFor = siteKeys(config.secretsKey);

  /** The store, checked it can be edited, and a call to its site API signed with its key. */
  const siteOf = (tenant: { id: string; external_id: string; status: number; is_suspended: boolean; main_domain: string | null }) => {
    if (tenant.status !== Status.Done) throw badRequest(`Tenant ${tenant.external_id} is ${statusName(tenant.status)}; wait until it is Done`);
    if (tenant.is_suspended) throw badRequest(`Tenant ${tenant.external_id} is suspended`);
    if (!tenant.main_domain) throw badRequest(`Tenant ${tenant.external_id} has no main domain`);
    const domain = tenant.main_domain;
    return async (request: SiteRequest) => {
      try {
        return await callSite(keyFor(tenant.id), domain, request, deps.siteFetch);
      } catch (error) {
        throw new HttpError(502, `The store did not answer: ${(error as Error).message}`);
      }
    };
  };

  /**
   * A preview link (AnyPress Client's /site/preview) moved to the store's platform address, so AI apps
   * can frame it from one known domain whatever the store's own domain is. The store answers the
   * preview on any of its addresses before WordPress redirects to its main one.
   */
  const onPlatformDomain = async (tenantId: string, body: unknown) => {
    const preview = body as { url?: unknown } | null;
    if (typeof preview?.url !== 'string') return;
    const { rows } = await pool.query<{ domain_name: string }>('SELECT domain_name FROM tenant_domains WHERE tenant_id = $1 AND is_base', [tenantId]);
    if (!rows[0]) return;
    const url = new URL(preview.url);
    url.host = rows[0].domain_name;
    preview.url = url.toString();
  };

  app.post('/site', async (c) => {
    const tenant = await findTenant(pool, c);
    const request = validateBody<SiteRequest>('SiteRequestParams', await readJson(c));
    const answer = await siteOf(tenant)(request);
    if (answer.status === 401) {
      throw new HttpError(502, 'The store refused the request: it has no site key yet (it gets one on its next setup) or its AnyPress Client is older than 2.3.0');
    }
    if (request.path === '/preview' && answer.status === 200) await onPlatformDomain(tenant.id, answer.body);
    return c.json({ status: answer.status, body: answer.body });
  });

  /** The store's site API for a reference job: a store too old for it, or not answering, is a 502. */
  const referenceCall = (tenant: Parameters<typeof siteOf>[0], minimum: string) => {
    const site = siteOf(tenant);
    return async (request: SiteRequest) => {
      const answer = await site(request);
      if (answer.status === 401) throw new HttpError(502, 'The store refused the request: its AnyPress Client is older than 2.3.0 or it has no site key yet');
      if (answer.status === 404 && request.path === '/products') throw new HttpError(502, `The store's AnyPress Client is older than ${minimum}: it has no product routes yet`);
      return answer;
    };
  };
  const storeAnswered = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `The store did not answer: ${(error as Error).message}`);
    }
  };

  // A store built from a reference, checked against it page by page (src/referencecheck.ts): read-only and free.
  app.post('/site/reference-check', async (c) => {
    const tenant = await findTenant(pool, c);
    const body = validateBody<{ referenceId: string; ownContent?: boolean; offset?: number; limit?: number }>('SiteReferenceCheckParams', await readJson(c));
    const bundle = await referenceBundle(pool, c.get('productId'), body.referenceId);
    const call = referenceCall(tenant, '2.3.0');
    return c.json(await storeAnswered(() => checkAgainstReference(bundle, call, { ownContent: body.ownContent ?? false, offset: body.offset ?? 0, limit: body.limit ?? 50 })));
  });

  // A reference's products into the store's FluentCart (src/referenceproducts.ts), 20 at a time, drafts unless asked.
  app.post('/site/reference-products', async (c) => {
    const tenant = await findTenant(pool, c);
    const body = validateBody<{ referenceId: string; ownContent?: boolean; status?: 'draft' | 'publish'; offset?: number; limit?: number }>('SiteReferenceProductsParams', await readJson(c));
    const bundle = await referenceBundle(pool, c.get('productId'), body.referenceId);
    const call = referenceCall(tenant, '2.19.0');
    return c.json(
      await storeAnswered(() => addReferenceProducts(bundle, call, { ownContent: body.ownContent ?? false, status: body.status ?? 'draft', offset: body.offset ?? 0, limit: body.limit ?? 100 })),
    );
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
    if (!config.auth?.apiUrl) throw badRequest('Signing in apps is off on this server');
    if (!(await clientHasRedirect(deps, clientId, redirectUri))) throw badRequest('clientId is not a registered app with that redirectUri');
    const redirectUrl = await storeSignIn(
      deps,
      { id: tenant.id, product_id: tenant.product_id },
      { authorize: siteAuthorizeRequest(config.auth.apiUrl, { clientId, redirectUri, codeChallenge, state }) },
      [scopeOf('site', 'read'), scopeOf('site', 'write')],
    );
    return c.json({ redirectUrl });
  });

  // The storefront's "Ask the website assistant" button: a one-time handoff of its signed-in owner to the
  // assistant at assistantUrl, for this website only. The assistant needs no list of storefronts: the
  // handoff itself shows the storefront (holding this key) vouched for the owner.
  app.post('/site/handoff', async (c) => {
    const tenant = await findTenant(pool, c);
    const { assistantUrl } = validateBody<{ assistantUrl: string }>('SiteHandoffParams', await readJson(c));
    if (tenant.status !== Status.Done) throw badRequest(`Tenant ${tenant.external_id} is ${statusName(tenant.status)}; wait until it is Done`);
    if (tenant.is_suspended) throw badRequest(`Tenant ${tenant.external_id} is suspended`);
    const assistant = new URL(assistantUrl);
    if (assistant.protocol !== 'https:' && assistant.hostname !== 'localhost') throw badRequest('assistantUrl must be https');
    const handoff = await createSiteHandoff(pool, tenant, assistant.origin + assistant.pathname.replace(/\/$/, ''));
    const url = new URL(`${assistant.origin}${assistant.pathname.replace(/\/$/, '')}/from-shop`);
    url.searchParams.set('handoff', handoff);
    return c.json({ url: url.toString() });
  });

  return app;
}

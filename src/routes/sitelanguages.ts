import type { Context, Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { HttpError, badRequest, conflict } from '../errors.ts';
import { isUuid, readJson, scopedProduct } from '../http.ts';
import { callSite, siteKeys, type SiteRequest } from '../sitekeys.ts';
import { Status, statusName } from '../status.ts';

const STORE = `SELECT t.*, (SELECT domain_name FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_main) AS main_domain
  FROM tenants t WHERE t.id = $1 AND ($2::uuid IS NULL OR t.product_id = $2)`;

/** A store the dashboard may ask something of right now: Done, not suspended and with an address. */
export async function reachableStore(deps: Deps, c: Context<AppEnv>, check?: (tenant: Record<string, unknown>) => void) {
  const id = c.req.param('id') ?? '';
  if (!isUuid(id)) throw new HttpError(404, `Tenant ${id} not found`);
  const { rows } = await deps.pool.query(STORE, [id, scopedProduct(c)]);
  const tenant = rows[0];
  if (!tenant) throw new HttpError(404, `Tenant ${id} not found`);
  check?.(tenant);
  if (tenant.status !== Status.Done) throw conflict(`This site is ${statusName(tenant.status)}; try once it is Done`);
  if (tenant.is_suspended) throw conflict('This site is suspended; resume it first');
  if (!tenant.main_domain) throw conflict('This site has no address yet');
  return tenant;
}

/** Sends one signed request to the store's AnyPress Client; 502 when it doesn't answer. */
export async function askStore(deps: Deps, tenant: { id: string; main_domain: string }, request: SiteRequest, timeoutMs: number) {
  try {
    return await callSite(siteKeys(deps.config.secretsKey)(tenant.id), tenant.main_domain, request, deps.siteFetch, timeoutMs);
  } catch (error) {
    throw new HttpError(502, `The site did not answer: ${(error as Error).message}`);
  }
}

// The store's languages (AnyPress Client 2.25.0, through Polylang): which are on, and turning them on or off with
// the languages besides the site's own. What the owner also sees on Dashboard > Your plan in WordPress.
export function siteLanguageRoutes(app: Hono<AppEnv>, deps: Deps) {
  const answer = (status: number, body: unknown) => {
    if (status === 404) throw conflict('This site runs an older AnyPress Client, without Languages');
    if (status >= 400 && status < 500) throw badRequest((body as { message?: string } | null)?.message ?? `The site answered ${status}`);
    if (status !== 200) throw new HttpError(502, `The site answered ${status}`);
    return body;
  };

  app.get('/tenants/:id/languages', async (c) => {
    const tenant = await reachableStore(deps, c);
    const res = await askStore(deps, tenant, { method: 'GET', path: '/languages' }, 20_000);
    return c.json(answer(res.status, res.body) as object);
  });

  app.put('/tenants/:id/languages', async (c) => {
    const body = ((await readJson(c)) ?? {}) as { on?: unknown; languages?: unknown };
    if (typeof body.on !== 'boolean') throw badRequest('on must be true or false');
    if (body.languages !== undefined && (!Array.isArray(body.languages) || body.languages.some((l) => typeof l !== 'string'))) {
      throw badRequest('languages must be a list of WordPress locales, like ["es_ES", "fr_FR"]');
    }
    const tenant = await reachableStore(deps, c);
    const res = await askStore(deps, tenant, { method: 'PUT', path: '/languages', body: { on: body.on, ...(body.languages ? { languages: body.languages } : {}) } }, 30_000);
    return c.json(answer(res.status, res.body) as object);
  });
}

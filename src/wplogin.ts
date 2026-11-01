import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Deps } from './app.ts';
import { conflict } from './errors.ts';
import { siteKeys } from './sitekeys.ts';
import { Status, statusName } from './status.ts';

/**
 * "Log in to WordPress" from the dashboard (docs/wordpress-login.md): a link that signs the browser in to a
 * store's wp-admin as its first administrator, once, within a few minutes. The API signs it with the store's
 * site key (src/sitekeys.ts); the store's WaaS Client (2.10.0+), or WaaS Host (2.8.0+) on a ready-made
 * storefront, checks it at /wp-json/<plugin>/v1/admin-login.
 *
 * The signature is the site requests' form over the method LOGIN (which no site request uses), the route and
 * an empty body, so a signed site request can't be turned into a login, nor a login link into a site request.
 */

/** How long a link works: the store's limit (SignedRequest::MAX_AGE in WaaS Client). */
export const LOGIN_LINK_SECONDS = 300;

export type LoginPlugin = 'waas-client' | 'waas-host';

export interface WpLogin {
  /** Opens wp-admin signed in when oneClick; else the store's own WordPress login page. */
  url: string;
  /** False when the store's plugin predates one-click login: url is then its login page. */
  oneClick: boolean;
  /** When the link stops working; null when oneClick is false. */
  expiresAt: string | null;
}

/** The link for the store at `domain`, signed with its site key, made at `now`. */
export function adminLoginLink(key: string, domain: string, plugin: LoginPlugin, now = Date.now(), nonce = randomBytes(16).toString('hex')): string {
  const route = `/${plugin}/v1/admin-login`;
  const t = String(Math.floor(now / 1000));
  const payload = [t, nonce, 'LOGIN', route, createHash('sha256').update('').digest('hex')].join('\n');
  const s = createHmac('sha256', key).update(payload).digest('hex');
  const url = new URL(`https://${domain}/wp-json${route}`);
  url.search = new URLSearchParams({ t, n: nonce, s }).toString();
  return url.toString();
}

export interface LoginTenant {
  id: string;
  product_id: string;
  external_id: string;
  status: number;
  is_suspended: boolean;
  main_domain: string | null;
}

/**
 * Whether the store answers the login route at all: an older plugin answers WordPress's 404 "no route",
 * a current one refuses the unsigned request with 403. Anything else (a timeout, a proxy error) counts
 * as yes, so a slow store still gets a link to try.
 */
async function hasLoginRoute(fetchImpl: typeof fetch, domain: string, plugin: LoginPlugin): Promise<boolean> {
  try {
    const response = await fetchImpl(`https://${domain}/wp-json/${plugin}/v1/admin-login`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status !== 404;
  } catch {
    return true;
  }
}

/** A sign-in link for the tenant, for whoever the caller checked may use it. */
export async function wpLogin(deps: Pick<Deps, 'config' | 'siteFetch'>, tenant: LoginTenant, now = Date.now()): Promise<WpLogin> {
  if (tenant.status !== Status.Done) throw conflict(`This site is ${statusName(tenant.status)}; you can log in once it is Done`);
  if (tenant.is_suspended) throw conflict('This site is suspended; resume it to log in');
  if (!tenant.main_domain) throw conflict('This site has no address yet');
  const plugin: LoginPlugin = deps.config.storefrontProductId && tenant.product_id === deps.config.storefrontProductId ? 'waas-host' : 'waas-client';
  if (!(await hasLoginRoute(deps.siteFetch ?? fetch, tenant.main_domain, plugin))) {
    return { url: `https://${tenant.main_domain}/wp-admin/`, oneClick: false, expiresAt: null };
  }
  const key = siteKeys(deps.config.secretsKey)(tenant.id);
  return {
    url: adminLoginLink(key, tenant.main_domain, plugin, now),
    oneClick: true,
    expiresAt: new Date(Math.floor(now / 1000) * 1000 + LOGIN_LINK_SECONDS * 1000).toISOString(),
  };
}

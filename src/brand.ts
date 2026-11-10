/**
 * The platform's own name. An install names itself with BRAND_NAME, or takes its BRAND_DOMAIN
 * (else PLATFORM_DOMAIN) as its name; only an install on AnyPress's own domain says AnyPress and
 * carries AnyPress's address, logo and colours. A self-hosted install never shows AnyPress's.
 */
const ANYPRESS_DOMAIN = 'anypress.io';

export interface PlatformBrand {
  /** On the sign-in button and emails, and on a suspended store's page unless STORE_BRAND_NAME says otherwise. */
  name: string;
  /** BRAND_DOMAIN, lower case. */
  domain?: string;
  /** True only on AnyPress's own install (BRAND_DOMAIN=anypress.io). */
  anypress: boolean;
}

const domainOf = (value: string | undefined) => value?.trim().toLowerCase().replace(/\.$/, '') || undefined;

export function platformBrandOf(env: NodeJS.ProcessEnv): PlatformBrand {
  const domain = domainOf(env.BRAND_DOMAIN);
  const anypress = domain === ANYPRESS_DOMAIN;
  const name = env.BRAND_NAME?.trim() || (anypress ? 'AnyPress' : domain || domainOf(env.PLATFORM_DOMAIN) || 'Websites');
  return { name, domain, anypress };
}

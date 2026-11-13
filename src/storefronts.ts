import { randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import type { Deps } from './app.ts';
import { badRequest, conflict } from './errors.ts';
import { addApiKey, revokeApiKey } from './keys.ts';
import { PRICE_LIST } from './pricing.ts';
import { createTenant } from './routes/tenants.ts';
import { domainInUse, TENANT_SELECT, toTenant } from './tenants.ts';

/**
 * Ready-made storefronts: a WordPress site with AnyPress Host, built for a product so its owner can sell
 * without bringing a site of their own. The storefront is a store of the platform's storefront product
 * (STOREFRONT_PRODUCT_ID), made from that product's production version (templates/seller-storefront),
 * and is connected to the API from the start: its own key and secret for the product it sells for, and
 * the API's address, are written into its wp-config as AnyPress Host's WAAS_API_* constants.
 *
 * A product has at most one; it is the storefront product's store with external ID storefront-<product id>.
 */

type StorefrontDeps = Pick<Deps, 'config' | 'pool' | 'boss' | 'secrets'>;

export interface NewStorefront {
  /** The site's title. */
  name: string;
  /** Its owner: the WordPress administrator, and the site's admin email. */
  email: string;
  /** <subdomain>.<platform domain> as its address; without it, only its generated base domain. */
  subdomain?: string;
  /** The site types it sells (the price list's keys); without them, every type. */
  siteTypes?: string[] | null;
  /** The kinds of customers it has Who we help pages for (applications.ts AUDIENCES); without them, every kind. */
  audiences?: string[];
}

/** The site types a storefront can sell: the price list's (the store template's, except HighLevel's own). */
export const SITE_TYPES: readonly string[] = PRICE_LIST.siteTypes.map((t) => t.key);
/** The kinds of customers a storefront has a Who we help page for (templates/seller-storefront/audiences.json). */
export const AUDIENCES: readonly string[] = ['shops', 'specialty', 'courses', 'associations', 'churches', 'locations', 'freelancers', 'software'];

/** A list of known keys, without repeats; `null` and a missing value give `missing`. */
export function knownKeys(value: unknown, name: string, allowed: readonly string[], missing: string[] | null): string[] | null {
  if (value === undefined || value === null) return missing;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && allowed.includes(v))) {
    throw badRequest(`${name} must be a list of ${allowed.join(', ')}`);
  }
  return [...new Set(value as string[])];
}

/**
 * Which plans and Who we help pages a storefront opens with, as the option the storefront reads on its first visit to
 * narrow its shop (templates/seller-storefront/mu-plugins/seller-storefront.php). None when neither is given.
 */
function setupOption(input: NewStorefront | undefined): Record<string, string> {
  const siteTypes = knownKeys(input?.siteTypes, 'siteTypes', SITE_TYPES, null);
  if (siteTypes && !siteTypes.length) throw badRequest('siteTypes must name at least one site type, or be left out');
  const audiences = knownKeys(input?.audiences, 'audiences', AUDIENCES, null);
  return siteTypes || audiences ? { anypress_storefront_setup: JSON.stringify({ siteTypes, audiences }) } : {};
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The business name as an address label ("Bright Pixel Studio" is bright-pixel-studio), or '' when it isn't free. */
async function freeNameFor(deps: Pick<Deps, 'pool' | 'config'>, name: string, domainBase: string): Promise<string> {
  const label = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
  if (!LABEL.test(label)) return '';
  const taken = await domainInUse(deps.pool, `${label}.${domainBase}`, deps.config.platformDomain, deps.config.brandDomain);
  return taken ? '' : label;
}

export const STOREFRONT_KEY_LABEL = 'Ready-made storefront';

const externalId = (productId: string) => `storefront-${productId}`;

/** Looks up the stores' address; tests swap it. */
export const storefrontDns: { resolve4(name: string): Promise<string[]> } = { resolve4: (name) => resolve4(name) };

/**
 * The DNS records AnyPress Host shows a storefront's customers for their own domain: an A record to the store server and,
 * for www and other subdomains, a CNAME to a name under the stores' wildcard. Empty when the server's address can't be
 * looked up; the storefront then asks customers to contact it, as before.
 */
async function customDomainRecords(storesDomain: string): Promise<Record<string, string>> {
  const host = `www.${storesDomain}`;
  const ips = await storefrontDns.resolve4(host).catch(() => [] as string[]);
  return ips.length ? { anypress_dns_a_records: ips.join(','), anypress_dns_cname_target: host } : {};
}

/** The product's ready-made storefront, or null. */
export async function getStorefront({ config, pool }: Pick<Deps, 'config' | 'pool'>, productId: string) {
  if (!config.storefrontProductId) return null;
  const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.product_id = $1 AND t.external_id = $2`, [config.storefrontProductId, externalId(productId)]);
  return rows[0] ? toTenant(rows[0]) : null;
}

/** Checks the storefront's name, email and the address asked for (empty when none was). */
function readNewStorefront(input: NewStorefront) {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const name = text(input?.name);
  if (!name || name.length > 100) throw badRequest('name is required, at most 100 characters');
  const email = text(input?.email).toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw badRequest('email must be an email address');
  const asked = text(input?.subdomain).toLowerCase();
  if (asked && !LABEL.test(asked)) throw badRequest('subdomain can only contain letters, digits and - (at most 63)');
  return { name, email, asked };
}

/**
 * Builds the product's ready-made storefront. Makes the product a key for it (the secret goes only into the
 * storefront) and creates the store; the build runs as a queue job like any store's. Answers the store.
 */
export async function createStorefront(deps: StorefrontDeps, productId: string, input: NewStorefront, apiUrl: string) {
  const { config, pool } = deps;
  const storefrontProductId = config.storefrontProductId;
  if (!storefrontProductId) throw badRequest('Ready-made storefronts are not set up on this API (STOREFRONT_PRODUCT_ID)');
  if (productId === storefrontProductId) throw badRequest('The storefront product cannot have a ready-made storefront of its own');

  const { name, email, asked } = readNewStorefront(input);
  const domainBase = config.platformDomain ?? config.storesDomain;
  // Without an address of their own choosing, the storefront is named after the business when that name is free,
  // rather than a random t-1a2b3c4d one in the approval email.
  const subdomain = asked || (await freeNameFor(deps, name, domainBase));
  const setup = setupOption(input);

  const existing = await getStorefront(deps, productId);
  if (existing) throw conflict(`This product already has a ready-made storefront (${existing.domainName})`);

  const key = await addApiKey(pool, productId, STOREFRONT_KEY_LABEL);
  try {
    await createTenant(deps, storefrontProductId, {
      name,
      externalId: externalId(productId),
      customDomainName: subdomain ? `${subdomain}.${domainBase}` : undefined,
      wordPressUserName: email,
      wordPressUserEmail: email,
      wordPressUserRole: 'administrator',
      wpOptions: {
        blogname: name,
        admin_email: email,
        // Its customers' websites are named <name>.<platform domain>, like the platform's own.
        // anypress_root_domain for AnyPress Host 2.3.0 and later; the old name for storefront templates with an older one.
        ...(config.platformDomain ? { anypress_root_domain: config.platformDomain } : {}),
        // Custom domains point where the stores' own names do, like the platform's own storefront.
        ...(await customDomainRecords(config.storesDomain)),
        ...setup,
      },
      phpConstants: {
        ANYPRESS_API_BASE_URL: { value: apiUrl },
        ANYPRESS_API_KEY: { value: key.id, isPrivate: true },
        ANYPRESS_API_SECRET: { value: key.secret, isPrivate: true },
        // Encrypts its customers' one-click-login keys (AnyPress Host's PrivateKeyStore); must stay the same.
        ANYPRESS_HOST_KEY_ENCRYPTION_KEY: { value: randomBytes(36).toString('base64'), isPrivate: true },
      },
    });
  } catch (err) {
    // No store, so the key would sit unused with its secret nowhere.
    await revokeApiKey(pool, productId, key.id).catch(() => undefined);
    throw err;
  }
  return (await getStorefront(deps, productId))!;
}

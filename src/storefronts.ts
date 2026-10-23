import { randomBytes } from 'node:crypto';
import type { Deps } from './app.ts';
import { badRequest, conflict } from './errors.ts';
import { addApiKey, revokeApiKey } from './keys.ts';
import { createTenant } from './routes/tenants.ts';
import { TENANT_SELECT, toTenant } from './tenants.ts';

/**
 * Ready-made storefronts: a WordPress site with WaaS Host, built for a product so its owner can sell
 * without bringing a site of their own. The storefront is a store of the platform's storefront product
 * (STOREFRONT_PRODUCT_ID), made from that product's production version (templates/seller-storefront),
 * and is connected to the API from the start: its own key and secret for the product it sells for, and
 * the API's address, are written into its wp-config as WaaS Host's WAAS_API_* constants.
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
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const STOREFRONT_KEY_LABEL = 'Ready-made storefront';

const externalId = (productId: string) => `storefront-${productId}`;

/** The product's ready-made storefront, or null. */
export async function getStorefront({ config, pool }: Pick<Deps, 'config' | 'pool'>, productId: string) {
  if (!config.storefrontProductId) return null;
  const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.product_id = $1 AND t.external_id = $2`, [config.storefrontProductId, externalId(productId)]);
  return rows[0] ? toTenant(rows[0]) : null;
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

  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100) throw badRequest('name is required, at most 100 characters');
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 254) throw badRequest('email must be an email address');
  const subdomain = typeof input?.subdomain === 'string' ? input.subdomain.trim().toLowerCase() : '';
  if (subdomain && !LABEL.test(subdomain)) throw badRequest('subdomain can only contain letters, digits and - (at most 63)');
  const domainBase = config.platformDomain ?? config.storesDomain;

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
        // waas_root_domain for WaaS Host 2.3.0 and later; the old name for storefront templates with an older one.
        ...(config.platformDomain ? { waas_root_domain: config.platformDomain, wpcs_host_settings_root_domain: config.platformDomain } : {}),
      },
      phpConstants: {
        WAAS_API_BASE_URL: { value: apiUrl },
        WAAS_API_KEY: { value: key.id, isPrivate: true },
        WAAS_API_SECRET: { value: key.secret, isPrivate: true },
        // Encrypts its customers' one-click-login keys (WaaS Host's PrivateKeyStore); must stay the same.
        WAAS_HOST_KEY_ENCRYPTION_KEY: { value: randomBytes(36).toString('base64'), isPrivate: true },
      },
    });
  } catch (err) {
    // No store, so the key would sit unused with its secret nowhere.
    await revokeApiKey(pool, productId, key.id).catch(() => undefined);
    throw err;
  }
  return (await getStorefront(deps, productId))!;
}

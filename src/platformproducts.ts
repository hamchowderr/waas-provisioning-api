import type { Config } from './config.ts';
import type { Pool } from './db.ts';

/**
 * The seller storefront template product and the store template product, kept in the database
 * (platform_products) so they don't have to be settings. A setting, when present, wins and is saved
 * as the new choice; without it the saved choice is used. Runs once at start, before anything reads
 * config.storefrontProductId or config.storeTemplateProductId.
 */
const ROLES = [
  ['storefront-template', 'storefrontProductId'],
  ['store-template', 'storeTemplateProductId'],
] as const;

export async function resolvePlatformProducts(pool: Pool, config: Pick<Config, 'storefrontProductId' | 'storeTemplateProductId'>): Promise<void> {
  for (const [role, field] of ROLES) {
    const fromSetting = config[field];
    if (fromSetting) {
      await pool.query(
        `INSERT INTO platform_products (role, product_id) SELECT $1, id FROM products WHERE id = $2
         ON CONFLICT (role) DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now()
         WHERE platform_products.product_id <> EXCLUDED.product_id`,
        [role, fromSetting],
      );
      // Nothing is saved for an id that isn't a product; the setting still applies, as before.
      continue;
    }
    const { rows } = await pool.query<{ product_id: string }>('SELECT product_id FROM platform_products WHERE role = $1', [role]);
    if (rows[0]) config[field] = rows[0].product_id;
  }
}

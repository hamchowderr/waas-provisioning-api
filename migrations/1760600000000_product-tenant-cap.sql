-- Up Migration

-- The most tenants a product (storefront) may have; NULL is no limit. createTenant and
-- restoreTenant refuse with 400 at the limit. Set with PUT /admin/products/{id}.
ALTER TABLE products ADD COLUMN max_tenants integer CHECK (max_tenants >= 0);

-- The test storefronts (storefront-test and storefront-woo-test) share one test-only product,
-- reached through the API key whose id starts eacd7333 (the Basic-auth username, not the secret).
-- Their wp-admin passwords are weak on purpose, so that key gets a small cap: a guessed password
-- can't fill the VPS with stores. Applied once, on deploy; only when exactly one key matches and
-- no cap was set by hand. Elsewhere (tests, local databases) it changes nothing.
UPDATE products SET max_tenants = 5
 WHERE max_tenants IS NULL
   AND id IN (SELECT product_id FROM api_keys WHERE id::text LIKE 'eacd7333-%')
   AND (SELECT count(*) FROM api_keys WHERE id::text LIKE 'eacd7333-%') = 1;

-- Down Migration

ALTER TABLE products DROP COLUMN max_tenants;

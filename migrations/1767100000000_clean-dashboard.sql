-- Up Migration

-- The clean wp-admin Dashboard home on a storefront's stores (AnyPress Client 2.28.0+): WordPress's Welcome, Site
-- Health, Quick Draft, At a Glance, Activity and Events boxes replaced by the store's own home. On unless the seller
-- or reseller turns it off; written to each store as the anypress_clean_dashboard option.
ALTER TABLE products ADD COLUMN clean_dashboard boolean NOT NULL DEFAULT true;

-- Down Migration

ALTER TABLE products DROP COLUMN clean_dashboard;

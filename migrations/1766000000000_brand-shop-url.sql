-- Up Migration

-- Where a storefront's or reseller's customers buy (src/branding.ts, docs/branding.md): the "Start your
-- website" button on their branded demo page. A storefront without one uses its reseller's.
ALTER TABLE dashboard_brands
  ADD COLUMN shop_url text CHECK (char_length(shop_url) <= 500 AND shop_url ~ '^https?://');

-- Down Migration

ALTER TABLE dashboard_brands DROP COLUMN shop_url;

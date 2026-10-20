-- Up Migration

-- A reseller's own brand on the "website unavailable" page its suspended stores show (src/jobs.ts,
-- tenant.suspend), in place of the platform-wide STORE_BRAND_NAME. brand_url is the link on the name.
ALTER TABLE resellers
  ADD COLUMN brand_name text CHECK (char_length(brand_name) BETWEEN 1 AND 60),
  ADD COLUMN brand_url  text CHECK (brand_url ~ '^https?://');

-- Down Migration

ALTER TABLE resellers DROP COLUMN brand_name, DROP COLUMN brand_url;

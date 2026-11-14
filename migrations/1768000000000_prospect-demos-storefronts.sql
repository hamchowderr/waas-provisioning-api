-- Up Migration
-- Prospect demos belong to a storefront (the Sales Kit, src/prospectdemos.ts): each seller and reseller keeps their own
-- list, and AnyPress's own is its shop's (STORE_TEMPLATE_PRODUCT_ID, claimed when the API starts). A read also runs the
-- website check (report), and keeps what the prospect finder found (details: phone, email, address, socials...).
ALTER TABLE prospect_demos
  ADD COLUMN product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  ADD COLUMN place_id text,
  ADD COLUMN details jsonb,
  ADD COLUMN report jsonb,
  -- True until someone picks the demo's site type: the read then picks it from what their website has.
  ADD COLUMN site_type_auto boolean NOT NULL DEFAULT false;
DROP INDEX prospect_demos_website;
CREATE UNIQUE INDEX prospect_demos_website ON prospect_demos (product_id, lower(website)) NULLS NOT DISTINCT WHERE website IS NOT NULL;
CREATE INDEX prospect_demos_product ON prospect_demos (product_id);

-- Website reads per storefront per month (Firecrawl is paid per read), like prospect_searches.
CREATE TABLE prospect_reads (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  month      date NOT NULL,
  reads      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, month)
);

-- Down Migration
DROP TABLE prospect_reads;
DROP INDEX prospect_demos_product;
DROP INDEX prospect_demos_website;
DELETE FROM prospect_demos a USING prospect_demos b WHERE a.website IS NOT NULL AND lower(a.website) = lower(b.website) AND a.id > b.id;
CREATE UNIQUE INDEX prospect_demos_website ON prospect_demos (lower(website)) WHERE website IS NOT NULL;
ALTER TABLE prospect_demos DROP COLUMN site_type_auto, DROP COLUMN report, DROP COLUMN details, DROP COLUMN place_id, DROP COLUMN product_id;

-- Up Migration

-- A reseller's monthly list price for one store of each size, in US cents, before its wholesale
-- discount: what its monthly bill is priced from (GET /admin/resellers/{id}/bill). The platform
-- doesn't know which plan a reseller's client bought, so each reseller has one price per size. The
-- default is the Website plan's price (Small $12, Medium 2x, Large 4x).
ALTER TABLE resellers
  ADD COLUMN price_small_cents  integer NOT NULL DEFAULT 1200 CHECK (price_small_cents >= 0),
  ADD COLUMN price_medium_cents integer NOT NULL DEFAULT 2400 CHECK (price_medium_cents >= 0),
  ADD COLUMN price_large_cents  integer NOT NULL DEFAULT 4800 CHECK (price_large_cents >= 0);

-- Down Migration

ALTER TABLE resellers DROP COLUMN price_small_cents, DROP COLUMN price_medium_cents, DROP COLUMN price_large_cents;

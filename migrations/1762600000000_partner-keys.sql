-- Up Migration

-- Partner keys (docs/resellers.md): an API key that belongs to a reseller instead of one storefront.
-- It works on every storefront the reseller has; /v1 calls say which with the productId query.
-- A key belongs to exactly one of the two. Deleting the reseller deletes its keys.
ALTER TABLE api_keys
  ALTER COLUMN product_id DROP NOT NULL,
  ADD COLUMN reseller_id uuid REFERENCES resellers(id) ON DELETE CASCADE,
  ADD CONSTRAINT api_keys_one_owner CHECK ((product_id IS NULL) <> (reseller_id IS NULL));
CREATE INDEX api_keys_reseller ON api_keys (reseller_id, created_at) WHERE reseller_id IS NOT NULL;

-- Down Migration

DELETE FROM api_keys WHERE reseller_id IS NOT NULL;
DROP INDEX api_keys_reseller;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_one_owner, DROP COLUMN reseller_id, ALTER COLUMN product_id SET NOT NULL;

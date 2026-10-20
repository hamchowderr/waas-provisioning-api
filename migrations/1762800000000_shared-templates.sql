-- Up Migration

-- Shared templates (docs/resellers.md): a base snapshot made with a partner key belongs to the reseller
-- and is offered on every one of its storefronts. A template belongs to exactly one of the two.
ALTER TABLE base_snapshots
  ALTER COLUMN product_id DROP NOT NULL,
  ADD COLUMN reseller_id uuid REFERENCES resellers(id) ON DELETE CASCADE,
  ADD CONSTRAINT base_snapshots_one_owner CHECK ((product_id IS NULL) <> (reseller_id IS NULL));
CREATE INDEX base_snapshots_reseller ON base_snapshots (reseller_id) WHERE reseller_id IS NOT NULL;

-- Down Migration

DELETE FROM base_snapshots WHERE reseller_id IS NOT NULL;
DROP INDEX base_snapshots_reseller;
ALTER TABLE base_snapshots DROP CONSTRAINT base_snapshots_one_owner, DROP COLUMN reseller_id, ALTER COLUMN product_id SET NOT NULL;

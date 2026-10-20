-- Up Migration

-- Reseller accounts (docs/resellers.md): a partner that sells stores from one or more storefronts
-- (products) and pays the platform a wholesale price for every live store across them. The public
-- contract calls this a subscription; its id will be the contract's subscriptionId.
-- max_products: storefronts it may have; max_tenants: stores across all of them (each product's own
-- max_tenants still applies). NULL is no limit. wholesale_percent: the discount off list price.
CREATE TABLE resellers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  max_products       integer CHECK (max_products >= 0),
  max_tenants        integer CHECK (max_tenants >= 0),
  wholesale_percent  integer NOT NULL DEFAULT 40 CHECK (wholesale_percent BETWEEN 0 AND 100),
  billing_email      text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- A storefront's reseller; NULL for a storefront of its own (every one before this migration).
ALTER TABLE products ADD COLUMN reseller_id uuid REFERENCES resellers(id) ON DELETE RESTRICT;
CREATE INDEX products_reseller ON products (reseller_id) WHERE reseller_id IS NOT NULL;

-- When a store first finished building. A store counts as live (billed) from then, while it isn't
-- suspended or being removed: a later update that sets it Pending for a moment doesn't stop it.
ALTER TABLE tenants ADD COLUMN date_live timestamptz;
UPDATE tenants SET date_live = date_created WHERE status = 1;

-- When each store was live, at what size and under which reseller: what usage and wholesale bills
-- are counted from. Kept after the store is deleted (no foreign key). ended_at is NULL while live.
-- Kept up to date by the triggers below, so no code path that changes a store can forget it.
CREATE TABLE tenant_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  product_id   uuid NOT NULL,
  reseller_id  uuid,
  size         text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);
CREATE INDEX tenant_periods_open ON tenant_periods (tenant_id) WHERE ended_at IS NULL;
CREATE INDEX tenant_periods_product ON tenant_periods (product_id, started_at);
CREATE INDEX tenant_periods_reseller ON tenant_periods (reseller_id, started_at) WHERE reseller_id IS NOT NULL;

-- Stores live now start their first period now: nothing earlier was recorded.
INSERT INTO tenant_periods (tenant_id, product_id, reseller_id, size)
SELECT t.id, t.product_id, NULL, t.size FROM tenants t WHERE t.status = 1 AND NOT t.is_suspended;

CREATE FUNCTION tenant_set_date_live() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 1 AND NEW.date_live IS NULL THEN
    NEW.date_live := now();
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenants_date_live BEFORE INSERT OR UPDATE OF status ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenant_set_date_live();

-- Closes the store's open period when it stops being live, changes size or moves product, and opens
-- one when it becomes live (or right after closing one for a size or product change).
CREATE FUNCTION tenant_track_periods() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  was_live boolean := false;
  is_live boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    was_live := OLD.date_live IS NOT NULL AND NOT OLD.is_suspended AND OLD.status <> 3;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    is_live := NEW.date_live IS NOT NULL AND NOT NEW.is_suspended AND NEW.status <> 3;
  END IF;
  IF was_live AND (NOT is_live OR OLD.size <> NEW.size OR OLD.product_id <> NEW.product_id) THEN
    UPDATE tenant_periods SET ended_at = now() WHERE tenant_id = OLD.id AND ended_at IS NULL;
    was_live := false;
  END IF;
  IF is_live AND NOT was_live THEN
    INSERT INTO tenant_periods (tenant_id, product_id, reseller_id, size)
    SELECT NEW.id, NEW.product_id, p.reseller_id, NEW.size FROM products p WHERE p.id = NEW.product_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER tenants_periods AFTER INSERT OR UPDATE OR DELETE ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenant_track_periods();

-- A storefront joining or leaving a reseller: its live stores' periods restart under the new one,
-- so each reseller is billed only for the time the stores were its own.
CREATE FUNCTION product_track_reseller() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH closed AS (
    UPDATE tenant_periods SET ended_at = now()
     WHERE product_id = NEW.id AND ended_at IS NULL
    RETURNING tenant_id, size
  )
  INSERT INTO tenant_periods (tenant_id, product_id, reseller_id, size)
  SELECT tenant_id, NEW.id, NEW.reseller_id, size FROM closed;
  RETURN NULL;
END $$;

CREATE TRIGGER products_reseller_periods AFTER UPDATE OF reseller_id ON products
  FOR EACH ROW WHEN (OLD.reseller_id IS DISTINCT FROM NEW.reseller_id)
  EXECUTE FUNCTION product_track_reseller();

-- Down Migration

DROP TRIGGER products_reseller_periods ON products;
DROP FUNCTION product_track_reseller();
DROP TRIGGER tenants_periods ON tenants;
DROP FUNCTION tenant_track_periods();
DROP TRIGGER tenants_date_live ON tenants;
DROP FUNCTION tenant_set_date_live();
DROP TABLE tenant_periods;
ALTER TABLE tenants DROP COLUMN date_live;
ALTER TABLE products DROP COLUMN reseller_id;
DROP TABLE resellers;

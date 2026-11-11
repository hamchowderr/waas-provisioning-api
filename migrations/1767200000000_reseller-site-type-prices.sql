-- Up Migration

-- Resellers are billed each store's own site type's list price (Website $12, Bookings $19, Store $29,
-- Community $39, Everything $79 for Small; Medium 2x, Large 4x) less their wholesale discount, the
-- prices anypress.io shows. So each live period keeps the store's site types: the ANYPRESS_TENANT_ROLES
-- constant its storefront set (comma-separated keys of the template's roles.json), or NULL when it has
-- none or keeps it private. A store with no known site type is still billed the reseller's own price
-- per size (resellers.price_*_cents).
ALTER TABLE tenant_periods ADD COLUMN site_type text;

CREATE FUNCTION tenant_site_type(constants jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(btrim(constants -> 'ANYPRESS_TENANT_ROLES' ->> 'value'), '')
   WHERE coalesce((constants -> 'ANYPRESS_TENANT_ROLES' ->> 'isPrivate')::boolean, false) = false
$$;

-- As before, plus: a change of site type closes the period and opens a new one, so each part of the
-- month is billed at the price of the type the store had then.
CREATE OR REPLACE FUNCTION tenant_track_periods() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF was_live AND (NOT is_live OR OLD.size <> NEW.size OR OLD.product_id <> NEW.product_id
                   OR tenant_site_type(OLD.php_constants) IS DISTINCT FROM tenant_site_type(NEW.php_constants)) THEN
    UPDATE tenant_periods SET ended_at = now() WHERE tenant_id = OLD.id AND ended_at IS NULL;
    was_live := false;
  END IF;
  IF is_live AND NOT was_live THEN
    INSERT INTO tenant_periods (tenant_id, product_id, reseller_id, size, site_type)
    SELECT NEW.id, NEW.product_id, p.reseller_id, NEW.size, tenant_site_type(NEW.php_constants)
      FROM products p WHERE p.id = NEW.product_id;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION product_track_reseller() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH closed AS (
    UPDATE tenant_periods SET ended_at = now()
     WHERE product_id = NEW.id AND ended_at IS NULL
    RETURNING tenant_id, size, site_type
  )
  INSERT INTO tenant_periods (tenant_id, product_id, reseller_id, size, site_type)
  SELECT tenant_id, NEW.id, NEW.reseller_id, size, site_type FROM closed;
  RETURN NULL;
END $$;

-- Periods so far take the site type their store has now; a deleted store's periods stay NULL.
UPDATE tenant_periods tp SET site_type = tenant_site_type(t.php_constants) FROM tenants t WHERE t.id = tp.tenant_id;

-- Down Migration

CREATE OR REPLACE FUNCTION product_track_reseller() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION tenant_track_periods() RETURNS trigger LANGUAGE plpgsql AS $$
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

DROP FUNCTION tenant_site_type(jsonb);
ALTER TABLE tenant_periods DROP COLUMN site_type;

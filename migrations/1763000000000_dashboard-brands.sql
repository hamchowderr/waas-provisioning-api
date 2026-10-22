-- Up Migration

-- A storefront's or reseller's own look in the dashboard (src/branding.ts, docs/branding.md): the
-- name, logo, small icon, main color and support address its team sees instead of the platform's.
-- A storefront with none of its own falls back to its reseller's. Images are small, so they live here
-- and the API serves them at /branding/<id>/logo and /icon.
CREATE TABLE dashboard_brands (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid UNIQUE REFERENCES products (id) ON DELETE CASCADE,
  reseller_id   uuid UNIQUE REFERENCES resellers (id) ON DELETE CASCADE,
  name          text CHECK (char_length(name) BETWEEN 1 AND 60),
  color         text CHECK (color ~ '^#[0-9a-f]{6}$'),
  support_email text CHECK (char_length(support_email) <= 254),
  logo          bytea CHECK (octet_length(logo) <= 262144),
  logo_type     text,
  icon          bytea CHECK (octet_length(icon) <= 65536),
  icon_type     text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_brands_one_owner CHECK ((product_id IS NULL) <> (reseller_id IS NULL)),
  CONSTRAINT dashboard_brands_logo_type CHECK ((logo IS NULL) = (logo_type IS NULL)),
  CONSTRAINT dashboard_brands_icon_type CHECK ((icon IS NULL) = (icon_type IS NULL))
);

-- Down Migration

DROP TABLE dashboard_brands;

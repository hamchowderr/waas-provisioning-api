-- Up Migration

-- Plugin choices (docs/plugin-choices.md): wordpress.org plugins a storefront, or a reseller for all its
-- storefronts, adds to its stores ('add', pinned to one version and its zip's SHA-256) or switches off
-- ('off'). Applied to each version as it builds. A storefront's own choice of a slug wins over its reseller's.
CREATE TABLE plugin_choices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid REFERENCES products(id) ON DELETE CASCADE,
  reseller_id   uuid REFERENCES resellers(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  name          text NOT NULL,
  icon          text,
  action        text NOT NULL CHECK (action IN ('add', 'off')),
  version       text,
  sha256        text,
  -- Which site types (roles.json keys) it applies to; empty: all of them.
  site_types    text[] NOT NULL DEFAULT '{}',
  date_created  timestamptz NOT NULL DEFAULT now(),
  date_changed  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plugin_choices_one_owner CHECK ((product_id IS NULL) <> (reseller_id IS NULL)),
  CONSTRAINT plugin_choices_pinned CHECK (action = 'off' OR (version IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX plugin_choices_product_slug ON plugin_choices (product_id, slug) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX plugin_choices_reseller_slug ON plugin_choices (reseller_id, slug) WHERE reseller_id IS NOT NULL;

-- The choices a version was built with, and the plugin file each added one turned out to have.
ALTER TABLE versions ADD COLUMN plugin_choices jsonb;

-- Down Migration

ALTER TABLE versions DROP COLUMN plugin_choices;
DROP TABLE plugin_choices;

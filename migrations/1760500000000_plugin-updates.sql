-- Up Migration

-- A storefront held at one plugin release (waas-hw4): its update checks get that release whatever
-- the channel says. Set and cleared through the admin API.
CREATE TABLE plugin_pins (
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  version     text NOT NULL,
  pinned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, slug)
);

-- What each site last reported when it checked for an update of one of our plugins.
CREATE TABLE plugin_installs (
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  slug         text NOT NULL,
  site         text NOT NULL,
  version      text NOT NULL,
  channel      text NOT NULL,
  wp_version   text,
  php_version  text,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, slug, site)
);

-- Down Migration

DROP TABLE plugin_installs;
DROP TABLE plugin_pins;

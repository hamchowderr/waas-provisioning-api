-- Up Migration

-- Store template releases (templates-v* on GitHub) the API published by itself (src/templatereleases.ts): the
-- version built from each, and whether it became production.
CREATE TABLE template_releases (
  tag text PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  version_id uuid REFERENCES versions (id) ON DELETE SET NULL,
  version_name text,
  status smallint NOT NULL,
  error text,
  date_created timestamptz NOT NULL DEFAULT now(),
  date_changed timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE template_releases;

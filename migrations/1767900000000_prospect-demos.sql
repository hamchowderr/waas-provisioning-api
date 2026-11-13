-- Up Migration
-- Branded demos for businesses AnyPress may contact (src/prospectdemos.ts, docs/prospect-demos.md): each row is one
-- business, its route (what the demo shows them), the look and offer read from its website, and the private code its
-- demo link carries. Files (logo, photos) are in object storage under prospects/<code>/.
CREATE TABLE prospect_demos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  company       text NOT NULL,
  website       text,
  route         text NOT NULL,
  site_type     text NOT NULL,
  kit           text,
  label         text,
  city          text,
  priority      integer,
  notes         text,
  status        smallint NOT NULL DEFAULT 0,
  brand         jsonb,
  files         text[] NOT NULL DEFAULT '{}',
  error         text,
  credits_used  integer NOT NULL DEFAULT 0,
  date_created  timestamptz NOT NULL DEFAULT now(),
  date_gathered timestamptz
);
-- One row per website, so importing a list twice doesn't make two demos.
CREATE UNIQUE INDEX prospect_demos_website ON prospect_demos (lower(website)) WHERE website IS NOT NULL;

-- Down Migration
DROP TABLE prospect_demos;

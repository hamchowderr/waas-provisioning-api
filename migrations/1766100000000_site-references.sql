-- Up Migration

-- References a site is built from (src/references.ts, docs/references.md): a website link, a Shopify shop, a Figma
-- file or a document, read into one bundle of design tokens, page text, screenshots, images and products. `upload`
-- holds an uploaded document only until it has been read.
CREATE TABLE site_references (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('website', 'figma', 'document')),
  source        text NOT NULL CHECK (char_length(source) <= 2000),
  max_pages     smallint NOT NULL DEFAULT 5,
  status        smallint NOT NULL DEFAULT 0,
  bundle        jsonb,
  error         text,
  upload        bytea,
  upload_type   text,
  date_created  timestamptz NOT NULL DEFAULT now(),
  date_finished timestamptz
);
CREATE INDEX site_references_product ON site_references (product_id, date_created);

-- Down Migration

DROP TABLE site_references;

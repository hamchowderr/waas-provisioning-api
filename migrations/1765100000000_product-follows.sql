-- Up Migration

-- A storefront started from another one keeps following it (src/routes/versions.ts): when the one it follows
-- gets a new production version, a copy is built for it and becomes its production version once ready, and its
-- stores move with it. follows_product_id is always the storefront at the top, never one that follows another.
ALTER TABLE products ADD COLUMN follows_product_id uuid REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX products_follows_idx ON products (follows_product_id) WHERE follows_product_id IS NOT NULL;

-- A follower's copy waits as an ordinary version until it is built, then takes over as production.
ALTER TABLE versions ADD COLUMN promote_when_done boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE versions DROP COLUMN promote_when_done;
DROP INDEX products_follows_idx;
ALTER TABLE products DROP COLUMN follows_product_id;

-- Up Migration

-- Templates a product uploads and copies into versions (contract draft.5: available to product keys).
CREATE TABLE base_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name                text NOT NULL,
  comment             text NOT NULL,
  is_tenant_snapshot  boolean NOT NULL DEFAULT false,
  group_name          text,
  show_in_console     boolean NOT NULL DEFAULT false,
  uri                 text,
  date_created        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX base_snapshots_product ON base_snapshots (product_id);

-- A version snapshot copied from a template (instead of from another version's snapshot).
ALTER TABLE snapshots ADD COLUMN source_base_snapshot_id uuid;

-- Down Migration

ALTER TABLE snapshots DROP COLUMN source_base_snapshot_id;
DROP TABLE base_snapshots;

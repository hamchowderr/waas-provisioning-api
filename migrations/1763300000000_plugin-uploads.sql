-- Up Migration

-- Premium plugins sellers upload as zips (docs/plugin-choices.md). An upload is checked before a plugin
-- choice can use it; the zip stays in the bucket at plugins/uploads/<id>.zip.
CREATE TABLE plugin_uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid REFERENCES products(id) ON DELETE CASCADE,
  reseller_id   uuid REFERENCES resellers(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'rejected')),
  reason        text,
  slug          text,
  name          text,
  version       text,
  file          text,
  sha256        text,
  size_bytes    bigint,
  date_created  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plugin_uploads_one_owner CHECK ((product_id IS NULL) <> (reseller_id IS NULL))
);
CREATE INDEX plugin_uploads_product ON plugin_uploads (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX plugin_uploads_reseller ON plugin_uploads (reseller_id) WHERE reseller_id IS NOT NULL;

-- Where an added plugin comes from, and the licence constants (encrypted JSON) its stores define.
ALTER TABLE plugin_choices
  ADD COLUMN source text NOT NULL DEFAULT 'wporg' CHECK (source IN ('wporg', 'upload')),
  ADD COLUMN upload_id uuid REFERENCES plugin_uploads(id) ON DELETE RESTRICT,
  ADD COLUMN licence text,
  ADD CONSTRAINT plugin_choices_upload CHECK ((source = 'upload') = (upload_id IS NOT NULL));

-- Down Migration

ALTER TABLE plugin_choices DROP CONSTRAINT plugin_choices_upload, DROP COLUMN licence, DROP COLUMN upload_id, DROP COLUMN source;
DROP TABLE plugin_uploads;

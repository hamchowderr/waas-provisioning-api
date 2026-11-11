-- Up Migration

-- "Download my site" (docs/site-downloads.md): a copy of a whole store as a plain WordPress archive its owner can
-- restore on any host. No foreign key to tenants, like tenant_backups: the daily maintenance job deletes each copy
-- from storage and here once it is a week old, whether its store still exists or not.
CREATE TABLE site_downloads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL,
  status        smallint NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 3),
  size_bytes    bigint,
  file_name     text NOT NULL,
  date_created  timestamptz NOT NULL DEFAULT now(),
  date_done     timestamptz
);
CREATE INDEX site_downloads_tenant ON site_downloads (tenant_id, date_created DESC);

-- Down Migration

DROP TABLE site_downloads;

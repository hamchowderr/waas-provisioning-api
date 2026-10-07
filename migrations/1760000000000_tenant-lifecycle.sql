-- Up Migration

ALTER TABLE tenants
  ADD COLUMN is_suspended   boolean NOT NULL DEFAULT false,
  ADD COLUMN date_suspended timestamptz;

-- Backups outlive their tenant (no foreign key): kept for BACKUP_RETENTION_DAYS after the
-- tenant is deleted, then purged by the daily maintenance job.
CREATE TABLE tenant_backups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL,
  external_id        text NOT NULL,
  reason             text NOT NULL CHECK (reason IN ('manual', 'suspend')),
  size_bytes         bigint,
  status             smallint NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 3),
  date_created       timestamptz NOT NULL DEFAULT now(),
  tenant_deleted_at  timestamptz
);
CREATE INDEX tenant_backups_tenant ON tenant_backups (product_id, tenant_id);
CREATE INDEX tenant_backups_external ON tenant_backups (product_id, external_id);

-- Down Migration

DROP TABLE tenant_backups;
ALTER TABLE tenants DROP COLUMN is_suspended, DROP COLUMN date_suspended;

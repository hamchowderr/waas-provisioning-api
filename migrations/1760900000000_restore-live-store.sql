-- Up Migration

-- Rolling a live store back to one of its backups (POST /admin/tenants/{id}/restore) first backs up
-- what the store holds now, as a tenant_backups row with reason 'before-restore', so the rollback
-- itself can be undone. Like manual backups, these are never pruned by the nightly rotation.
ALTER TABLE tenant_backups DROP CONSTRAINT tenant_backups_reason_check;
ALTER TABLE tenant_backups ADD CONSTRAINT tenant_backups_reason_check CHECK (reason IN ('manual', 'suspend', 'scheduled', 'before-restore'));

-- Down Migration

DELETE FROM tenant_backups WHERE reason = 'before-restore';
ALTER TABLE tenant_backups DROP CONSTRAINT tenant_backups_reason_check;
ALTER TABLE tenant_backups ADD CONSTRAINT tenant_backups_reason_check CHECK (reason IN ('manual', 'suspend', 'scheduled'));

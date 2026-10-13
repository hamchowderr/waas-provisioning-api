-- Up Migration

-- Nightly backups of live stores (src/storebackups.ts) are tenant_backups rows with reason 'scheduled'.
ALTER TABLE tenant_backups DROP CONSTRAINT tenant_backups_reason_check;
ALTER TABLE tenant_backups ADD CONSTRAINT tenant_backups_reason_check CHECK (reason IN ('manual', 'suspend', 'scheduled'));
CREATE INDEX tenant_backups_scheduled ON tenant_backups (tenant_id, date_created) WHERE reason = 'scheduled';

-- Down Migration

DROP INDEX tenant_backups_scheduled;
DELETE FROM tenant_backups WHERE reason = 'scheduled';
ALTER TABLE tenant_backups DROP CONSTRAINT tenant_backups_reason_check;
ALTER TABLE tenant_backups ADD CONSTRAINT tenant_backups_reason_check CHECK (reason IN ('manual', 'suspend'));

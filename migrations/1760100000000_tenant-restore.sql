-- Up Migration

-- What a restore needs besides the store's files and database:
--   wp_options / php_constants: the tenant's values when the backup was taken (private constants
--     stay encrypted, as in tenants.php_constants);
--   tenant_record: set when the tenant is deleted: name, version, snapshot and its final domains.
ALTER TABLE tenant_backups
  ADD COLUMN wp_options    jsonb,
  ADD COLUMN php_constants jsonb,
  ADD COLUMN tenant_record jsonb;

-- Down Migration

ALTER TABLE tenant_backups DROP COLUMN wp_options, DROP COLUMN php_constants, DROP COLUMN tenant_record;

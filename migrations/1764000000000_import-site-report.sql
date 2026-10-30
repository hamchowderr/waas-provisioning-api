-- Up Migration

-- What the moved site runs, for the "what's on this site" report (src/sitereport.ts): its form, shop, CRM, booking,
-- support, affiliate and community plugins, how much data each holds, and whether a Fluent plugin can take it over.
ALTER TABLE tenant_imports ADD COLUMN site_report jsonb;

-- Down Migration

ALTER TABLE tenant_imports DROP COLUMN site_report;

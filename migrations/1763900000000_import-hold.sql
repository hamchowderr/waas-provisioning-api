-- Up Migration

-- A site moved in from another host is held until its owner says it is live (POST /v1/tenants/go-live): its
-- scheduled jobs don't run, it emails no one but the owner and it is not indexed (the agent's hold flag).
ALTER TABLE tenants ADD COLUMN on_hold boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN date_held timestamptz;

-- How the move went: why it failed, in words a site owner can act on; what the store found when it checked the
-- moved site (its home and login pages, with its plugins loaded); and warnings (another PHP or WordPress version,
-- a failed check).
ALTER TABLE tenant_imports ADD COLUMN failure_reason text;
ALTER TABLE tenant_imports ADD COLUMN site_check jsonb;
ALTER TABLE tenant_imports ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]';

-- Down Migration

ALTER TABLE tenant_imports DROP COLUMN warnings;
ALTER TABLE tenant_imports DROP COLUMN site_check;
ALTER TABLE tenant_imports DROP COLUMN failure_reason;
ALTER TABLE tenants DROP COLUMN date_held;
ALTER TABLE tenants DROP COLUMN on_hold;

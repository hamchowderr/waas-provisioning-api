-- Up Migration

-- When the "your website is ready" email last went to the store's owner, and to which address (src/jobs.ts
-- emailWebsiteReady): after a create with notifyOwner, or sent later from the dashboard. Null when never sent.
ALTER TABLE tenants ADD COLUMN owner_notified_at timestamptz;
ALTER TABLE tenants ADD COLUMN owner_notified_to text;

-- Down Migration

ALTER TABLE tenants DROP COLUMN owner_notified_to;
ALTER TABLE tenants DROP COLUMN owner_notified_at;

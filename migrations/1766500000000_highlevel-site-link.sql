-- Up Migration

-- A HighLevel site's link to its sub-account, as the site last asked for it (POST /apps/site/crm-link): when it last
-- asked, when it was last given the sub-account's token (null when the last answer gave none), and the sub-account's
-- name as HighLevel gave it then. Shown on the site's page in the dashboard.
ALTER TABLE tenants ADD COLUMN highlevel_checked_at timestamptz;
ALTER TABLE tenants ADD COLUMN highlevel_connected_at timestamptz;
ALTER TABLE tenants ADD COLUMN highlevel_location_name text;

-- Down Migration

ALTER TABLE tenants DROP COLUMN highlevel_location_name;
ALTER TABLE tenants DROP COLUMN highlevel_connected_at;
ALTER TABLE tenants DROP COLUMN highlevel_checked_at;

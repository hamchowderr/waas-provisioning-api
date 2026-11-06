-- Up Migration

-- The HighLevel sub-account (location) and agency (company) a site was made from by the AnyPress
-- app's Create site action (src/highlevel.ts). The app's other actions only reach a sub-account's own
-- sites, and its trigger only fires in the sub-account a site belongs to. Null for sites made elsewhere.
ALTER TABLE tenants
  ADD COLUMN highlevel_location_id text,
  ADD COLUMN highlevel_company_id text;
CREATE INDEX tenants_highlevel_location ON tenants (highlevel_location_id) WHERE highlevel_location_id IS NOT NULL;

-- Down Migration

DROP INDEX tenants_highlevel_location;
ALTER TABLE tenants DROP COLUMN highlevel_location_id, DROP COLUMN highlevel_company_id;

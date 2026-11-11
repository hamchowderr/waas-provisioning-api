-- Up Migration
-- The care package a store has on the shop and this month's care time (PUT /v1/tenants/care), shown in the dashboard.
-- NULL when the store has no care.
ALTER TABLE tenants ADD COLUMN care jsonb;

-- Down Migration
ALTER TABLE tenants DROP COLUMN care;

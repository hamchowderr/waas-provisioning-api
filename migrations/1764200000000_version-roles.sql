-- Up Migration

-- A version's site types (waas-client-data/roles.json), read once from its saved code and kept, because its
-- site is stopped once it is built (GET /v1/versions/production/roles). Null until first read.
ALTER TABLE versions ADD COLUMN roles jsonb;

-- Down Migration

ALTER TABLE versions DROP COLUMN roles;

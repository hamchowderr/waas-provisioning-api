-- Up Migration
-- Scopes per area (mcp/src/scopes.ts): stores, backups, domains, email, versions and site, each with
-- :read and :write. Grants made before then carry the two old scopes, where stores:read meant looking
-- at everything and stores:write changing everything. legacy_scope marks those rows, so they keep
-- exactly what they had, and a refresh passes the mark on. It defaults to true so rows written by an
-- older API still running during a deploy are read the old way too; the API writes false for new
-- grants itself.
--
-- platform_admin: approved on the dashboard by a platform admin, who may connect any storefront
-- without being on its team. Such a row has a user_id and product_id like a team member's.

ALTER TABLE oauth_requests ADD COLUMN legacy_scope boolean NOT NULL DEFAULT true;
ALTER TABLE oauth_codes ADD COLUMN legacy_scope boolean NOT NULL DEFAULT true;
ALTER TABLE oauth_tokens ADD COLUMN legacy_scope boolean NOT NULL DEFAULT true;
ALTER TABLE oauth_codes ADD COLUMN platform_admin boolean NOT NULL DEFAULT false;
ALTER TABLE oauth_tokens ADD COLUMN platform_admin boolean NOT NULL DEFAULT false;

-- Down Migration
-- Grants made since cannot be read the old way.
DELETE FROM oauth_tokens WHERE NOT legacy_scope OR platform_admin;
DELETE FROM oauth_codes WHERE NOT legacy_scope OR platform_admin;
DELETE FROM oauth_requests WHERE NOT legacy_scope;
ALTER TABLE oauth_tokens DROP COLUMN platform_admin;
ALTER TABLE oauth_codes DROP COLUMN platform_admin;
ALTER TABLE oauth_tokens DROP COLUMN legacy_scope;
ALTER TABLE oauth_codes DROP COLUMN legacy_scope;
ALTER TABLE oauth_requests DROP COLUMN legacy_scope;

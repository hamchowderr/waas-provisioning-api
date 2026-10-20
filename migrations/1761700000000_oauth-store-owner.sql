-- Up Migration
-- "Sign in with your website" (src/oauth.ts): a store owner connects an AI app to /mcp by pressing
-- Allow in their own wp-admin. Such a request, code or token belongs to that one store (tenant_id,
-- with its product in product_id) and only edits its site. A code or token has exactly one owner:
-- an API key, a person on a product's team, or a store.

ALTER TABLE oauth_requests ADD COLUMN tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE;

ALTER TABLE oauth_codes ADD COLUMN tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE;
ALTER TABLE oauth_codes DROP CONSTRAINT oauth_codes_owner;
ALTER TABLE oauth_codes ADD CONSTRAINT oauth_codes_owner CHECK (
  (api_key_id IS NOT NULL AND user_id IS NULL AND tenant_id IS NULL)
  OR (api_key_id IS NULL AND user_id IS NOT NULL AND tenant_id IS NULL AND product_id IS NOT NULL)
  OR (api_key_id IS NULL AND user_id IS NULL AND tenant_id IS NOT NULL AND product_id IS NOT NULL));

ALTER TABLE oauth_tokens ADD COLUMN tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE;
ALTER TABLE oauth_tokens DROP CONSTRAINT oauth_tokens_owner;
ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_owner CHECK (
  (api_key_id IS NOT NULL AND user_id IS NULL AND tenant_id IS NULL)
  OR (api_key_id IS NULL AND user_id IS NOT NULL AND tenant_id IS NULL AND product_id IS NOT NULL)
  OR (api_key_id IS NULL AND user_id IS NULL AND tenant_id IS NOT NULL AND product_id IS NOT NULL));

-- Down Migration
DELETE FROM oauth_tokens WHERE tenant_id IS NOT NULL;
DELETE FROM oauth_codes WHERE tenant_id IS NOT NULL;
ALTER TABLE oauth_tokens DROP CONSTRAINT oauth_tokens_owner;
ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_owner CHECK (
  (api_key_id IS NOT NULL AND user_id IS NULL) OR (api_key_id IS NULL AND user_id IS NOT NULL AND product_id IS NOT NULL));
ALTER TABLE oauth_tokens DROP COLUMN tenant_id;
ALTER TABLE oauth_codes DROP CONSTRAINT oauth_codes_owner;
ALTER TABLE oauth_codes ADD CONSTRAINT oauth_codes_owner CHECK (
  (api_key_id IS NOT NULL AND user_id IS NULL) OR (api_key_id IS NULL AND user_id IS NOT NULL AND product_id IS NOT NULL));
ALTER TABLE oauth_codes DROP COLUMN tenant_id;
ALTER TABLE oauth_requests DROP COLUMN tenant_id;

-- Up Migration
-- Connecting an AI app to /mcp by signing in as a person (src/oauth.ts), not only with an API key
-- and secret. Such a code or token belongs to the person and the product they picked, and works
-- while they are still on that product's team. Exactly one of api_key_id and user_id is set.

ALTER TABLE oauth_codes ALTER COLUMN api_key_id DROP NOT NULL;
ALTER TABLE oauth_codes ADD COLUMN user_id uuid REFERENCES auth."user" (id) ON DELETE CASCADE;
ALTER TABLE oauth_codes ADD COLUMN product_id uuid REFERENCES products (id) ON DELETE CASCADE;
ALTER TABLE oauth_codes ADD CONSTRAINT oauth_codes_owner CHECK (
  (api_key_id IS NOT NULL AND user_id IS NULL) OR (api_key_id IS NULL AND user_id IS NOT NULL AND product_id IS NOT NULL));

ALTER TABLE oauth_tokens ALTER COLUMN api_key_id DROP NOT NULL;
ALTER TABLE oauth_tokens ADD COLUMN user_id uuid REFERENCES auth."user" (id) ON DELETE CASCADE;
ALTER TABLE oauth_tokens ADD COLUMN product_id uuid REFERENCES products (id) ON DELETE CASCADE;
ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_owner CHECK (
  (api_key_id IS NOT NULL AND user_id IS NULL) OR (api_key_id IS NULL AND user_id IS NOT NULL AND product_id IS NOT NULL));

-- An approval waiting on the person to sign in on the dashboard (AUTH_URL/connect/<id>). Single use.
CREATE TABLE oauth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL,
  client_name text NOT NULL,
  redirect_uri text NOT NULL,
  state text,
  code_challenge text NOT NULL,
  scope text NOT NULL,
  resource text NOT NULL,
  issuer text NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Down Migration
DROP TABLE oauth_requests;
DELETE FROM oauth_tokens WHERE api_key_id IS NULL;
ALTER TABLE oauth_tokens DROP CONSTRAINT oauth_tokens_owner;
ALTER TABLE oauth_tokens DROP COLUMN product_id;
ALTER TABLE oauth_tokens DROP COLUMN user_id;
ALTER TABLE oauth_tokens ALTER COLUMN api_key_id SET NOT NULL;
DELETE FROM oauth_codes WHERE api_key_id IS NULL;
ALTER TABLE oauth_codes DROP CONSTRAINT oauth_codes_owner;
ALTER TABLE oauth_codes DROP COLUMN product_id;
ALTER TABLE oauth_codes DROP COLUMN user_id;
ALTER TABLE oauth_codes ALTER COLUMN api_key_id SET NOT NULL;

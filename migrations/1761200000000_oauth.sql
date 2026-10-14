-- Up Migration
-- OAuth for the MCP server at /mcp (src/oauth.ts), so Claude, ChatGPT and other MCP clients can
-- connect without a pasted secret. Approving a client means signing in with a product API key and
-- secret; every code and token belongs to that key, so revoking the key cuts the client off too.
-- Codes and tokens are random and stored as SHA-256 hashes.

-- Clients that registered themselves (RFC 7591). Clients identified by a metadata document URL
-- (Client ID Metadata Documents) aren't stored; their document is fetched when they authorize.
CREATE TABLE oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name text,
  redirect_uris text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  api_key_id uuid NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  scope text NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id text NOT NULL,
  api_key_id uuid NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  scope text NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_expires ON oauth_tokens (expires_at);

-- Down Migration
DROP TABLE oauth_tokens;
DROP TABLE oauth_codes;
DROP TABLE oauth_clients;

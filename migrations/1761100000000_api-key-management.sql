-- Up Migration
-- Self-service API keys (src/keys.ts). revoked_at may now be in the future: a rotated key keeps
-- working until then, so a storefront can switch to its new key without downtime. last_used_at is
-- the last successful sign-in, at most a minute stale, so an owner can tell which keys are in use.
ALTER TABLE api_keys ADD COLUMN last_used_at timestamptz;
CREATE INDEX api_keys_product ON api_keys (product_id, created_at);

-- Down Migration
DROP INDEX api_keys_product;
ALTER TABLE api_keys DROP COLUMN last_used_at;

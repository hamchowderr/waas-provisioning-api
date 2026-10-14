-- Up Migration
-- The request log (src/requestlog.ts): one row per product API call and per admin change, for the
-- dashboard. No bodies or secrets. Ids are not foreign keys, so a row outlives its store or key.
CREATE TABLE api_requests (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('v1', 'admin')),
  method text NOT NULL,
  path text NOT NULL,
  query text,
  status int NOT NULL,
  duration_ms int NOT NULL,
  product_id uuid,
  api_key_id uuid,
  tenant_id uuid,
  external_id text,
  ip text,
  user_agent text,
  error text
);
CREATE INDEX api_requests_at ON api_requests (at DESC, id DESC);
CREATE INDEX api_requests_tenant ON api_requests (tenant_id, at DESC) WHERE tenant_id IS NOT NULL;
CREATE INDEX api_requests_product ON api_requests (product_id, at DESC) WHERE product_id IS NOT NULL;

-- Down Migration
DROP TABLE api_requests;

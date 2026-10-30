-- Up Migration

-- A storefront hands its signed-in owner to the website assistant (src/oauth.ts, siteHandoff): a one-time
-- handoff, good for a couple of minutes, for one website and one assistant address. The assistant trades it,
-- with its own PKCE challenge, for a sign-in code.
CREATE TABLE site_handoffs (
  handoff_hash text PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL,
  redirect_uri text NOT NULL,
  expires_at   timestamptz NOT NULL
);

-- Down Migration

DROP TABLE site_handoffs;

-- Up Migration

-- Demos people build for themselves on WordPress Playground (src/demodrafts.ts). "Make this my site" saves the demo's
-- choices and content here (pages, styles, header and footer, menus, business details; never code or users), and its
-- photos in object storage. A store created with the draft's id (POST /v1/tenants demoDraftId, after checkout) is built
-- as usual and then gets the draft's content. Each draft is used once and removed after expires_at.
CREATE TABLE demo_drafts (
  id text PRIMARY KEY,
  site_type text NOT NULL,
  kit text,
  -- The storefront whose demo page made it (a seller's or reseller's), when not AnyPress's own.
  product_id uuid REFERENCES products (id) ON DELETE CASCADE,
  content jsonb NOT NULL,
  images text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  tenant_id uuid REFERENCES tenants (id) ON DELETE SET NULL,
  used_at timestamptz,
  applied_at timestamptz,
  apply_error text
);
CREATE INDEX demo_drafts_created_idx ON demo_drafts (created_at);
CREATE INDEX demo_drafts_expires_idx ON demo_drafts (expires_at);
CREATE UNIQUE INDEX demo_drafts_tenant_idx ON demo_drafts (tenant_id) WHERE tenant_id IS NOT NULL;

-- Down Migration

DROP TABLE demo_drafts;

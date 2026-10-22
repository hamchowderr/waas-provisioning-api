-- Up Migration

-- A seller's or reseller's own address for the dashboard, e.g. dashboard.janedesigns.com
-- (src/dashboarddomains.ts, docs/branding.md). One per storefront. The dashboard's host (Vercel) serves
-- it once its DNS points there; records holds what is still missing. A domain the host couldn't drop
-- yet stays as 'removing' until the nightly maintenance does.
CREATE TABLE dashboard_domains (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid UNIQUE REFERENCES products (id) ON DELETE SET NULL,
  domain       text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'removing')),
  records      jsonb NOT NULL DEFAULT '[]',
  error        text,
  checked_at   timestamptz,
  date_created timestamptz NOT NULL DEFAULT now(),
  CHECK (product_id IS NOT NULL OR status = 'removing')
);

-- Down Migration

DROP TABLE dashboard_domains;

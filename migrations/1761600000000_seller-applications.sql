-- Up Migration
-- Applications to sell websites on the platform (src/applications.ts, docs/accounts.md): sent from the
-- marketing site's form, reviewed by the platform admin on the dashboard. Approving one makes the
-- product (product_id), invites the applicant as its owner and, when they asked, builds its
-- ready-made storefront.
CREATE TABLE seller_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  business text NOT NULL,
  website text,
  -- Who they sell websites to, in their words.
  clients text NOT NULL,
  -- How many websites they expect to sell in their first year: '1-2', '3-9', '10-24' or '25+'.
  expected_sites text NOT NULL,
  -- Set when they have no WordPress site of their own and want a ready-made storefront.
  wants_storefront boolean NOT NULL,
  storefront_subdomain text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  product_id uuid REFERENCES products (id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX seller_applications_status_idx ON seller_applications (status, created_at DESC);
-- One application waiting per email address.
CREATE UNIQUE INDEX seller_applications_pending_email_idx ON seller_applications (lower(email)) WHERE status = 'pending';

-- Down Migration
DROP TABLE seller_applications;

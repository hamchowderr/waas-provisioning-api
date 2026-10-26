-- Up Migration

-- The Client account type is gone (Clients page, POST /admin/clients). Its storefronts, sites and
-- team invitations stay as ordinary storefronts; only the record of how they were set up goes.
DROP TABLE clients;

-- Down Migration

CREATE TABLE clients (
  product_id     uuid PRIMARY KEY REFERENCES products (id) ON DELETE CASCADE,
  email          text NOT NULL,
  site_name      text NOT NULL,
  site_size      text NOT NULL DEFAULT 'small',
  tenant_id      uuid REFERENCES tenants (id) ON DELETE SET NULL,
  site_error     text,
  invited_at     timestamptz,
  invite_emailed boolean NOT NULL DEFAULT false,
  date_created   timestamptz NOT NULL DEFAULT now()
);

-- Up Migration

-- Clients the platform admin set up in one step (POST /admin/clients, src/clients.ts): each has its
-- own storefront (product), started from another storefront's version and template. Its site is made
-- once that version has built (tenant_id), and then the client is emailed an invitation as the
-- storefront's owner (invited_at). site_error says why the site could not be made.
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

-- Down Migration

DROP TABLE clients;

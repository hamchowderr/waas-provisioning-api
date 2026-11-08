-- Up Migration

-- Domains bought through the API for a store (src/domainsales.ts, docs/domains.md). The buyer pays a Stripe
-- invoice first; once it is paid the domain is registered at the registrar (Name.com), its DNS is pointed at the
-- stores and it becomes the store's main address. Renewals are invoiced 30 days before the domain expires.
-- status: awaiting_payment, registering, active, cancelled (invoice not paid), failed (paid but not registered:
-- refund by hand), expired.
CREATE TABLE bought_domains (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tenant_id          uuid REFERENCES tenants(id) ON DELETE SET NULL,
  domain_name        text NOT NULL,
  status             text NOT NULL CHECK (status IN ('awaiting_payment', 'registering', 'active', 'cancelled', 'failed', 'expired')),
  registrar          text NOT NULL DEFAULT 'namecom',
  cost_cents         integer NOT NULL,
  price_cents        integer NOT NULL,
  renewal_cost_cents integer NOT NULL,
  renewal_price_cents integer NOT NULL,
  contact            jsonb NOT NULL,
  stripe_customer_id text,
  stripe_invoice_id  text,
  hosted_invoice_url text,
  auto_renew         boolean NOT NULL DEFAULT true,
  renewal_invoice_id text,
  renewal_invoice_url text,
  expires_at         timestamptz,
  error              text,
  date_created       timestamptz NOT NULL DEFAULT now(),
  date_updated       timestamptz NOT NULL DEFAULT now()
);
-- One live order or registration per domain name; cancelled and failed orders don't hold the name.
CREATE UNIQUE INDEX bought_domains_live_name ON bought_domains (domain_name) WHERE status IN ('awaiting_payment', 'registering', 'active');
CREATE INDEX bought_domains_tenant ON bought_domains (tenant_id);
CREATE INDEX bought_domains_open ON bought_domains (status) WHERE status IN ('awaiting_payment', 'registering');

-- Down Migration

DROP TABLE bought_domains;

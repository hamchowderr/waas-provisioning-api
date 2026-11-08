-- Up Migration

-- Domains paid for at a storefront's own checkout (docs/domains.md): the shop takes the buyer's money, then asks the API
-- to register the domain, so there is no Stripe invoice. paid_by is 'invoice' (the buyer pays our Stripe invoice) or
-- 'storefront'. reference is the shop's order, so a repeat registers nothing more. A reseller's storefront pays for
-- these on its monthly bill: one bought_domain_charges row per registration and renewal.
ALTER TABLE bought_domains ADD COLUMN paid_by text NOT NULL DEFAULT 'invoice' CHECK (paid_by IN ('invoice', 'storefront'));
ALTER TABLE bought_domains ADD COLUMN reference text;
CREATE UNIQUE INDEX bought_domains_reference ON bought_domains (product_id, reference) WHERE reference IS NOT NULL;

CREATE TABLE bought_domain_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bought_domain_id uuid NOT NULL REFERENCES bought_domains(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('registration', 'renewal')),
  amount_cents     integer NOT NULL,
  -- The shop's order (registration) or renewal order: one charge each.
  reference        text NOT NULL,
  date_created     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bought_domain_id, reference)
);
CREATE INDEX bought_domain_charges_month ON bought_domain_charges (product_id, date_created);

-- Down Migration

DROP TABLE bought_domain_charges;
DROP INDEX bought_domains_reference;
ALTER TABLE bought_domains DROP COLUMN reference;
ALTER TABLE bought_domains DROP COLUMN paid_by;

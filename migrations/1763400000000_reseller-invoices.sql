-- Up Migration

-- Automatic monthly invoices for resellers (docs/resellers.md). On the 1st the API sends each
-- reseller's bill for the month before as a Stripe invoice on its Stripe customer, made from
-- billing_email the first time. auto_invoice false leaves that reseller to be billed by hand.
ALTER TABLE resellers
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN auto_invoice boolean NOT NULL DEFAULT true;

-- One invoice per reseller and month. status: sending while the Stripe invoice is being made,
-- nothing_due for a month with no charge, open once Stripe has it (charging the card on file or
-- emailed to pay), paid, void or uncollectible as Stripe reports, failed when sending stopped (error).
-- attempts numbers each try, so a retry's Stripe idempotency keys never return the last try's answers.
CREATE TABLE reseller_invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id        uuid NOT NULL REFERENCES resellers (id) ON DELETE CASCADE,
  month              text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  total_cents        integer NOT NULL,
  status             text NOT NULL CHECK (status IN ('sending', 'nothing_due', 'open', 'paid', 'void', 'uncollectible', 'failed')),
  stripe_invoice_id  text,
  hosted_invoice_url text,
  charge_automatically boolean,
  attempts           integer NOT NULL DEFAULT 1,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reseller_id, month)
);

-- Down Migration

DROP TABLE reseller_invoices;
ALTER TABLE resellers DROP COLUMN auto_invoice, DROP COLUMN stripe_customer_id;

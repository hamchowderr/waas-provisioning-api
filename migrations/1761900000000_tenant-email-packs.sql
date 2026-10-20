-- Up Migration

-- Email packs a store bought on top of its plan's monthly emails (POST /v1/tenants/email-packs). Pack
-- emails never expire: the store's plan mu-plugin uses them once the plan's emails for a month are
-- gone. The store is told the total bought; it counts what it used itself. `reference` is the shop's
-- idempotency key (an order id): a repeat with the same reference adds nothing.
CREATE TABLE tenant_email_packs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  emails        int NOT NULL CHECK (emails > 0),
  reference     text NOT NULL,
  date_created  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference)
);

-- Down Migration

DROP TABLE tenant_email_packs;

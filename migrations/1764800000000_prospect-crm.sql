-- Up Migration

-- Prospects a storefront's sellers sent from the prospect finder into a CRM (src/prospectcrm.ts): one row per business
-- and CRM, so a business is sent once and the finder can say it's already there. FluentCRM rows wait for the
-- storefront.crm-prospects job; `contact` is what to send, cleared once it's sent.
CREATE TABLE prospect_crm (
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  place_id     text NOT NULL,
  target       text NOT NULL CHECK (target IN ('fluentcrm', 'highlevel')),
  status       smallint NOT NULL,
  contact      jsonb,
  error        text,
  date_created timestamptz NOT NULL DEFAULT now(),
  date_changed timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, place_id, target)
);
CREATE INDEX prospect_crm_pending ON prospect_crm (product_id) WHERE status = 0;

-- Where a storefront's prospects go in HighLevel: its workflow's Inbound Webhook address, encrypted (it lets anyone
-- who has it add contacts to the seller's sub-account).
CREATE TABLE prospect_crm_settings (
  product_id        uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  highlevel_webhook text,
  date_changed      timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE prospect_crm_settings;
DROP TABLE prospect_crm;

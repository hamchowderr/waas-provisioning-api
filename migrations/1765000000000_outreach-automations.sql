-- Up Migration

-- Sales Kit outreach plans a seller added to their storefront's FluentCRM as a draft automation (src/outreachautomation.ts):
-- one per storefront and customer group. `automation` is what to make, cleared once it's made; funnel_id is
-- FluentCRM's id for it.
CREATE TABLE prospect_automations (
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_title  text NOT NULL,
  status       smallint NOT NULL,
  automation   jsonb,
  funnel_id    integer,
  error        text,
  date_created timestamptz NOT NULL DEFAULT now(),
  date_changed timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, group_title)
);

-- Down Migration

DROP TABLE prospect_automations;

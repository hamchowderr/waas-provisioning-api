-- Up Migration

-- The website assistant's messages per store and calendar month (UTC), counted by the API (src/assistant-usage.ts)
-- against the store size's assistantMessagesPerMonth (src/plans.ts).
CREATE TABLE assistant_usage (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month     date NOT NULL,
  messages  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);

-- Down Migration

DROP TABLE assistant_usage;

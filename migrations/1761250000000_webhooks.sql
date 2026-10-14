-- Up Migration
-- Outgoing webhooks (src/webhooks.ts, docs/webhooks.md): a product's endpoints, the events sent to
-- them, and one delivery per event and endpoint. Events and deliveries older than
-- WEBHOOK_LOG_DAYS (default 30) are deleted by the daily maintenance job.
CREATE TABLE webhook_endpoints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url           text NOT NULL,
  description   text,
  -- The event types sent here; empty is every event.
  event_types   text[] NOT NULL DEFAULT '{}',
  -- The signing secret (whsec_…), encrypted under SECRETS_KEY (src/secrets.ts).
  secret        text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  -- The API key that registered it; NULL when added from the admin API.
  api_key_id    uuid,
  date_created  timestamptz NOT NULL DEFAULT now(),
  date_changed  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_product ON webhook_endpoints (product_id);

-- Ids are not foreign keys, so an event outlives its store.
CREATE TABLE webhook_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type        text NOT NULL,
  tenant_id   uuid,
  version_id  uuid,
  -- The exact JSON body sent, so a retry is signed over the same bytes.
  body        text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_at ON webhook_events (at);

CREATE TABLE webhook_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  endpoint_id       uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts          int NOT NULL DEFAULT 0,
  -- The last attempt: the HTTP status the endpoint answered (NULL when it never answered), the
  -- start of its answer or the connection error.
  response_status   int,
  response_body     text,
  error             text,
  duration_ms       int,
  last_attempt_at   timestamptz,
  date_created      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, date_created DESC);
CREATE INDEX webhook_deliveries_created ON webhook_deliveries (date_created DESC);

-- Down Migration
DROP TABLE webhook_deliveries;
DROP TABLE webhook_events;
DROP TABLE webhook_endpoints;

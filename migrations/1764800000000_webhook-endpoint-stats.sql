-- Up Migration

-- The endpoint list (GET /admin/webhooks, /account/webhooks) shows each endpoint's pending count
-- and last attempt. Without these it read every delivery an endpoint had, which made the
-- All storefronts view slow enough to time out.
CREATE INDEX webhook_deliveries_last_attempt ON webhook_deliveries (endpoint_id, last_attempt_at DESC NULLS LAST);
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries (endpoint_id) WHERE status = 'pending';

-- Down Migration

DROP INDEX webhook_deliveries_pending;
DROP INDEX webhook_deliveries_last_attempt;

-- Up Migration

-- The AnyPress app for HighLevel (src/highlevel.ts). A workflow trigger of the app is a webhook
-- endpoint of kind 'highlevel': its url is the trigger's targetUrl, and it is sent the flat site
-- fields the trigger's workflow reads, with the sub-account's HighLevel token. One endpoint per
-- trigger; these don't count toward a storefront's endpoints.
ALTER TABLE webhook_endpoints
  ADD COLUMN kind text NOT NULL DEFAULT 'webhook' CHECK (kind IN ('webhook', 'highlevel')),
  ADD COLUMN highlevel_trigger_id text,
  ADD COLUMN highlevel_location_id text,
  ADD COLUMN highlevel_company_id text;
CREATE UNIQUE INDEX webhook_endpoints_highlevel_trigger ON webhook_endpoints (highlevel_trigger_id) WHERE kind = 'highlevel';

-- HighLevel's OAuth tokens for the app, from its install (one per agency or sub-account) and the
-- sub-account tokens made from an agency's. Tokens are encrypted under SECRETS_KEY.
CREATE TABLE highlevel_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_type      text NOT NULL CHECK (user_type IN ('Company', 'Location')),
  company_id     text,
  location_id    text,
  access_token   text NOT NULL,
  refresh_token  text,
  expires_at     timestamptz NOT NULL,
  date_created   timestamptz NOT NULL DEFAULT now(),
  date_changed   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX highlevel_tokens_company ON highlevel_tokens (company_id) WHERE user_type = 'Company';
CREATE UNIQUE INDEX highlevel_tokens_location ON highlevel_tokens (location_id) WHERE user_type = 'Location';

-- Down Migration

DROP TABLE highlevel_tokens;
DROP INDEX webhook_endpoints_highlevel_trigger;
ALTER TABLE webhook_endpoints DROP COLUMN kind, DROP COLUMN highlevel_trigger_id, DROP COLUMN highlevel_location_id, DROP COLUMN highlevel_company_id;

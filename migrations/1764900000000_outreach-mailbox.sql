-- Up Migration

-- The seller's own mailbox that prospect emails from the storefront's FluentCRM go out through (src/outreach.ts), never
-- the store relay. `mailbox` is everything but the password; the password is kept, encrypted, only until the
-- storefront.outreach-mailbox job has handed it to the store. mailbox_status: 0 checking, 1 connected, 2 failed;
-- a null mailbox with status 0 is being removed.
ALTER TABLE prospect_crm_settings
  ADD COLUMN mailbox         jsonb,
  ADD COLUMN mailbox_pass    text,
  ADD COLUMN mailbox_status  smallint,
  ADD COLUMN mailbox_error   text,
  ADD COLUMN mailbox_changed timestamptz;

-- Down Migration

ALTER TABLE prospect_crm_settings
  DROP COLUMN mailbox, DROP COLUMN mailbox_pass, DROP COLUMN mailbox_status, DROP COLUMN mailbox_error, DROP COLUMN mailbox_changed;

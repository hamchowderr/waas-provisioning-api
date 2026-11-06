-- Up Migration

-- The dashboard's bell (src/notifications.ts): what happened to a storefront's stores and versions, and to
-- the platform (new applications, failed restore tests: product_id null, for the platform admin only).
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products (id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  -- No foreign keys: a deleted store's notification stays.
  tenant_id uuid,
  version_id uuid,
  application_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_product_at_idx ON notifications (product_id, at DESC);
CREATE INDEX notifications_at_idx ON notifications (at DESC);

-- Each person's bell is read up to this time.
CREATE TABLE notification_reads (
  user_id uuid PRIMARY KEY REFERENCES auth."user" (id) ON DELETE CASCADE,
  read_until timestamptz NOT NULL
);

-- Down Migration

DROP TABLE notification_reads;
DROP TABLE notifications;

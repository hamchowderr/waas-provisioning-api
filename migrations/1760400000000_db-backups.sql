-- Up Migration

-- One row per backup of this database to object storage (src/dbbackup.ts). /health and the admin
-- API read the newest. The object itself may since have been pruned by retention (pruned_at).
CREATE TABLE db_backups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  object_key     text,
  size_bytes     bigint,
  error_message  text,
  pruned_at      timestamptz
);
CREATE INDEX db_backups_started ON db_backups (started_at DESC);

-- Down Migration

DROP TABLE db_backups;

-- Up Migration

-- The nightly restore test (src/restoretests.ts): one store's latest nightly backup restored into a
-- throwaway store, checked, and deleted. One row per test.
CREATE TABLE restore_tests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  backup_id    uuid NOT NULL,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed')),
  error        text,
  -- What the restored copy held: { name, home, tables, posts }.
  details      jsonb,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX restore_tests_started ON restore_tests (started_at);
CREATE INDEX restore_tests_tenant ON restore_tests (tenant_id, started_at);

-- Down Migration

DROP TABLE restore_tests;

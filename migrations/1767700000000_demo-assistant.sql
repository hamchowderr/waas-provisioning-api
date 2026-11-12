-- Up Migration
-- The website assistant inside a demo on anypress.io/try (src/demo-assistant.ts): one row per demo that asked for it,
-- with its sign-in (only its hash) and how many of its few messages it has used. Removed a day after it ends.
CREATE TABLE demo_assistants (
  token_hash text PRIMARY KEY,
  site_type text NOT NULL,
  messages integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX demo_assistants_created_at ON demo_assistants (created_at);

-- Down Migration
DROP TABLE demo_assistants;

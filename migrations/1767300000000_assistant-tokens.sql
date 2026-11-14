-- Up Migration

-- The website assistant's model tokens per store and calendar month (UTC), next to its message count, so the
-- assistant's real cost per store can be read. agent/ sends them after each model step (src/assistant-usage.ts).
ALTER TABLE assistant_usage
  ADD COLUMN input_tokens       bigint NOT NULL DEFAULT 0,
  ADD COLUMN output_tokens      bigint NOT NULL DEFAULT 0,
  ADD COLUMN cache_read_tokens  bigint NOT NULL DEFAULT 0,
  ADD COLUMN cache_write_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN model_steps        integer NOT NULL DEFAULT 0;

-- Down Migration

ALTER TABLE assistant_usage
  DROP COLUMN input_tokens,
  DROP COLUMN output_tokens,
  DROP COLUMN cache_read_tokens,
  DROP COLUMN cache_write_tokens,
  DROP COLUMN model_steps;

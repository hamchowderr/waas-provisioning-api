-- Up Migration

-- A job that failed its last retry. The worker marks the record Failed and completes the pg-boss
-- job (so the tenant's queue key isn't blocked); this row keeps why, for the admin API and retries.
CREATE TABLE job_failures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL,
  job_type       text NOT NULL,
  -- The job's data, re-sent on retry. Secrets inside stay encrypted (src/secrets.ts).
  job_data       jsonb NOT NULL,
  tenant_id      uuid,
  version_id     uuid,
  error_message  text NOT NULL,
  attempts       int NOT NULL,
  failed_at      timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'failed' CHECK (status IN ('failed', 'retried')),
  retried_at     timestamptz,
  retry_job_id   uuid
);
CREATE INDEX job_failures_open ON job_failures (failed_at DESC) WHERE status = 'failed';
CREATE INDEX job_failures_tenant ON job_failures (tenant_id);

-- Down Migration

DROP TABLE job_failures;

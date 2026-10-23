-- Up Migration

-- A failure can be dismissed: kept for the record but no longer listed as failed or counted, for one
-- whose store or version is gone or that later runs already made good.
ALTER TABLE job_failures DROP CONSTRAINT job_failures_status_check;
ALTER TABLE job_failures ADD CONSTRAINT job_failures_status_check CHECK (status IN ('failed', 'retried', 'dismissed'));
ALTER TABLE job_failures ADD COLUMN dismissed_at timestamptz;

-- Down Migration

UPDATE job_failures SET status = 'failed' WHERE status = 'dismissed';
ALTER TABLE job_failures DROP COLUMN dismissed_at;
ALTER TABLE job_failures DROP CONSTRAINT job_failures_status_check;
ALTER TABLE job_failures ADD CONSTRAINT job_failures_status_check CHECK (status IN ('failed', 'retried'));

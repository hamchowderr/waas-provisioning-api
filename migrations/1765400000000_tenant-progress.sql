-- Up Migration

-- What a store's running job is doing now (src/progress.ts): its step, the step's place in the job's plan and
-- when each started, for the dashboard's progress bar. Null when no job runs; kept with failedAt when one stopped.
ALTER TABLE tenants ADD COLUMN progress jsonb;

-- Down Migration

ALTER TABLE tenants DROP COLUMN progress;

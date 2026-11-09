-- Up Migration

-- Each Coolify Service's uuid, by "<environment id>/<name>", saved when the API creates the Service, so a
-- lookup reads that one Service and never Coolify's full list (every store's compose file, many megabytes).
-- uuid NULL: a create was started and its uuid not saved yet (the job stopped halfway); the next lookup
-- lists once to find it. The row with key '' marks that every existing Service was saved once.
CREATE TABLE coolify_service_ids (
  key text PRIMARY KEY,
  uuid text,
  date_changed timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE coolify_service_ids;

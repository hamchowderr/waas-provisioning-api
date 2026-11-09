-- Up Migration

-- Query statistics (pg_stat_statements): which queries take the most time, for tuning. The view only
-- fills once the server loads the library (shared_preload_libraries, docs/self-hosting.md); without it,
-- or where this database user may not add extensions, nothing changes and the API starts as before.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
  RAISE NOTICE 'pg_stat_statements not added: %', SQLERRM;
END
$$;

-- Down Migration

DROP EXTENSION IF EXISTS pg_stat_statements;

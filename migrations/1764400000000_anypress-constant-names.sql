-- Up Migration

-- The plugins read their wp-config constants under ANYPRESS_ names since AnyPress Host 2.11.1 and AnyPress Client
-- 2.13.1. Stored phpConstants under the old WAAS_ and WPCS_ names move to them (a name already there wins), and each
-- live store or storefront that had one is listed in constant_renames, so the API pushes its constants once
-- (src/constantnames.ts).
CREATE TABLE constant_renames (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE FUNCTION pg_temp.anypress_constant_names(c jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(name, value), '{}'::jsonb) FROM (
    SELECT DISTINCT ON (name) name, value FROM (
      SELECT CASE WHEN k ~ '^(WAAS|WPCS)_' THEN 'ANYPRESS_' || regexp_replace(k, '^(WAAS|WPCS)_', '') ELSE k END AS name,
             v AS value,
             CASE WHEN k ~ '^ANYPRESS_' THEN 0 WHEN k ~ '^WAAS_' THEN 1 ELSE 2 END AS rank
      FROM jsonb_each(c) AS e(k, v)
    ) renamed ORDER BY name, rank
  ) chosen
$$;

WITH moved AS (
  UPDATE tenants SET php_constants = pg_temp.anypress_constant_names(php_constants)
  WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(php_constants) AS k WHERE k ~ '^(WAAS|WPCS)_')
  RETURNING id
)
INSERT INTO constant_renames (tenant_id) SELECT id FROM moved;

UPDATE tenant_backups SET php_constants = pg_temp.anypress_constant_names(php_constants)
WHERE php_constants IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_object_keys(php_constants) AS k WHERE k ~ '^(WAAS|WPCS)_');

-- Down Migration

DROP TABLE constant_renames;

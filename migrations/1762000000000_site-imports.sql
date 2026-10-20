-- Up Migration

-- Sites moved in from another host (src/imports.ts). Such a store keeps its own plugins and themes:
-- creating, restoring, rolling back and moving it to another version never replace them with the
-- version's code. It has no snapshot: it is built from the archive its owner uploaded.
ALTER TABLE tenants ADD COLUMN own_code boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ALTER COLUMN snapshot_id DROP NOT NULL;

-- One per store being moved in. The AnyPress Export plugin on the old site holds the import code,
-- which carries the token: with it, it gets an upload link, starts the move and follows it. Only the
-- token's SHA-256 is kept. An import never started is removed with its store once it expires.
CREATE TABLE tenant_imports (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  started_at   timestamptz,
  -- What the export reported about the old site: its address, WordPress and PHP versions, size.
  source       jsonb,
  date_created timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE tenant_imports;
DELETE FROM tenants WHERE snapshot_id IS NULL;
ALTER TABLE tenants ALTER COLUMN snapshot_id SET NOT NULL;
ALTER TABLE tenants DROP COLUMN own_code;

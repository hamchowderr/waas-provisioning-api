-- Up Migration

-- The last AnyPress Host release the API pushed to each ready-made storefront (src/hostupdates.ts): the version,
-- whether it went in, and why not. A move, restore or rollback puts the template's own copy back, so it clears the row.
CREATE TABLE host_updates (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  version       text NOT NULL,
  from_version  text,
  status        smallint NOT NULL,
  error         text,
  date_changed  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE host_updates;

-- Up Migration

-- A tenant is one store. status: 0 Pending, 1 Done, 2 Failed, 3 Removing.
CREATE TABLE tenants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id           uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  external_id          text NOT NULL,
  name                 text NOT NULL,
  version_id           uuid NOT NULL REFERENCES versions(id),
  -- Copied at creation: the snapshot can be deleted later.
  snapshot_id          uuid NOT NULL,
  snapshot_name        text NOT NULL,
  snapshot_group_name  text,
  wp_options           jsonb NOT NULL DEFAULT '{}',
  -- { NAME: { value, isPrivate } }; private values are AES-GCM encrypted (src/secrets.ts).
  php_constants        jsonb NOT NULL DEFAULT '{}',
  status               smallint NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 3),
  date_created         timestamptz NOT NULL DEFAULT now(),
  date_changed         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, external_id)
);

-- Domain names are unique across all products: a domain can point at one store only.
CREATE TABLE tenant_domains (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain_name  text NOT NULL UNIQUE,
  is_main      boolean NOT NULL DEFAULT false,
  is_base      boolean NOT NULL DEFAULT false,
  date_created timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenant_domains_one_main ON tenant_domains (tenant_id) WHERE is_main;

-- Down Migration

DROP TABLE tenant_domains;
DROP TABLE tenants;

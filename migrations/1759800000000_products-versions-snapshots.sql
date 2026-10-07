-- Up Migration

-- A product is one storefront (WaaS Host install). Its API keys, versions,
-- snapshots and tenants belong to it.
CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The key is the Basic-auth username. Only a scrypt hash of the secret is stored.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  secret_hash  text NOT NULL,
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

-- status: 0 Pending, 1 Done, 2 Failed, 3 Removing (the contract's statusCode).
CREATE TABLE versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name               text NOT NULL,
  domain             text NOT NULL UNIQUE,
  wordpress_version  text NOT NULL,
  php_version        text NOT NULL,
  is_production      boolean NOT NULL DEFAULT false,
  status             smallint NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 3),
  date_created       timestamptz NOT NULL DEFAULT now(),
  date_changed       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX versions_one_production ON versions (product_id) WHERE is_production;

CREATE TABLE snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version_id          uuid NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  name                text NOT NULL,
  group_name          text,
  is_custom_snapshot  boolean NOT NULL DEFAULT false,
  is_tenant_snapshot  boolean NOT NULL DEFAULT false,
  source_snapshot_id  uuid,
  status              smallint NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 3),
  date_created        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX snapshots_product ON snapshots (product_id, version_id);

-- Down Migration

DROP TABLE snapshots;
DROP TABLE versions;
DROP TABLE api_keys;
DROP TABLE products;

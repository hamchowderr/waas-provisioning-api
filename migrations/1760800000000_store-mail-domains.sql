-- Up Migration

-- A store's own sending domain on toSend (src/maildomains.ts). 'pending' until toSend sees its DNS
-- records, then 'verified' and the store sends from it; 'removing' while the store moves back to
-- the platform's address. A deleted store leaves tenant_id NULL so its toSend domain is cleaned up.
CREATE TABLE tenant_mail_domains (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid UNIQUE REFERENCES tenants(id) ON DELETE SET NULL,
  domain_name       text NOT NULL UNIQUE,
  tosend_domain_id  text NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'removing')),
  date_created      timestamptz NOT NULL DEFAULT now(),
  date_verified     timestamptz
);

-- Down Migration

DROP TABLE tenant_mail_domains;

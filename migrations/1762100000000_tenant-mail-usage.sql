-- Up Migration

-- Every address a store has sent from (src/mailcount.ts): its own mailbox at the platform's sending
-- domain (<label>@anypress.io), or no-reply@ its own verified domain. toSend's messages carry no key
-- or account, so the From address is how the platform tells stores apart. last_used is NULL while the
-- store still sends from the address, else when it stopped; a month counts every address in use
-- during it. The shared STORE_MAIL_FROM is never recorded: it says nothing about which store sent.
CREATE TABLE tenant_mail_senders (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  address     text NOT NULL,
  first_used  timestamptz NOT NULL DEFAULT now(),
  last_used   timestamptz,
  PRIMARY KEY (tenant_id, address)
);
CREATE INDEX tenant_mail_senders_address ON tenant_mail_senders (address);

-- Each store's emails in a calendar month (UTC, 'YYYY-MM'), as the platform counted them on toSend
-- (the hourly mail-count job). The store is told the count whenever it changes; its plan mu-plugin
-- uses it when it is higher than the store's own count.
CREATE TABLE tenant_mail_usage (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month       text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  sent        int NOT NULL CHECK (sent >= 0),
  checked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month)
);

-- Down Migration

DROP TABLE tenant_mail_usage;
DROP TABLE tenant_mail_senders;

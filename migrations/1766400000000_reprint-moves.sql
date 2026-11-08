-- Up Migration

-- Sites moved in by copying them from their host with WordPress's Reprint (src/imports.ts), besides the AnyPress
-- Export plugin's upload. Each waiting store has a key: its public half is the Migration Token the owner pastes into the
-- Reprint plugin on the old site, and the store copies the site with the private half, kept encrypted (SECRETS_KEY).
-- reprint_site is the old site's address once a copy was started from it; the store can be copied again from it
-- until it goes live (reprint_copies counts the copies).
ALTER TABLE tenant_imports ADD COLUMN reprint_key text;
ALTER TABLE tenant_imports ADD COLUMN reprint_site text;
ALTER TABLE tenant_imports ADD COLUMN reprint_copies integer NOT NULL DEFAULT 0;

-- Down Migration

ALTER TABLE tenant_imports DROP COLUMN reprint_copies;
ALTER TABLE tenant_imports DROP COLUMN reprint_site;
ALTER TABLE tenant_imports DROP COLUMN reprint_key;

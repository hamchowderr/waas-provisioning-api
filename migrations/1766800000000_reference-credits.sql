-- Up Migration

-- Firecrawl credits each reference read spent (src/references.ts), counted against the storefront's monthly
-- REFERENCE_CREDITS_PER_MONTH, failed reads included. max_pages now goes up to REFERENCE_MAX_PAGES (500).
ALTER TABLE site_references ADD COLUMN credits_used integer NOT NULL DEFAULT 0;

-- Down Migration

ALTER TABLE site_references DROP COLUMN credits_used;

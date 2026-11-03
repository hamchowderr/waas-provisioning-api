-- Up Migration

-- Prospect finder searches per storefront and calendar month (UTC), counted by the API (src/prospects.ts) against
-- PROSPECT_SEARCHES_PER_MONTH.
CREATE TABLE prospect_searches (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  month      date NOT NULL,
  searches   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, month)
);

-- Down Migration

DROP TABLE prospect_searches;

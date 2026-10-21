-- Up Migration

-- Approving an application as a reseller (docs/resellers.md) makes a reseller account with the
-- applicant's storefront inside it; this is that account. NULL for a seller approval.
ALTER TABLE seller_applications ADD COLUMN reseller_id uuid REFERENCES resellers(id) ON DELETE SET NULL;

-- Down Migration

ALTER TABLE seller_applications DROP COLUMN reseller_id;

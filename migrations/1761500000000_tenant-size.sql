-- Up Migration

-- Each store's size (src/plans.ts): its CPU, memory and Apache workers, and its storage and monthly
-- email quotas. Set with POST and PUT /v1/tenants. Existing stores are small, which is what they ran
-- as before sizes.
ALTER TABLE tenants ADD COLUMN size text NOT NULL DEFAULT 'small' CHECK (size IN ('small', 'medium', 'large'));

-- Down Migration

ALTER TABLE tenants DROP COLUMN size;

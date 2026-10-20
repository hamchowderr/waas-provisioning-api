-- Up Migration

-- Reseller teams (docs/resellers.md): an organization can belong to a reseller instead of one
-- product. Its members see and manage every storefront the reseller has, and choose which one the
-- dashboard shows. A storefront's own organization is unchanged. Exactly one of the two is set;
-- deleting the reseller deletes its organization, as deleting a product deletes its own.
ALTER TABLE auth."organization"
  ALTER COLUMN "productId" DROP NOT NULL,
  ADD COLUMN "resellerId" uuid UNIQUE REFERENCES public.resellers (id) ON DELETE CASCADE,
  ADD CONSTRAINT organization_one_owner CHECK (("productId" IS NULL) <> ("resellerId" IS NULL));

-- Down Migration

DELETE FROM auth."organization" WHERE "resellerId" IS NOT NULL;
ALTER TABLE auth."organization" DROP CONSTRAINT organization_one_owner, DROP COLUMN "resellerId", ALTER COLUMN "productId" SET NOT NULL;

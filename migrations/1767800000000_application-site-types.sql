-- Up Migration
-- What a seller applicant sells and to whom (src/applications.ts): the site types they make (NULL when they aren't
-- sure yet, which keeps them all), anything else they make, the kinds of customers they serve (none when no group fits)
-- and anyone else. Their ready-made storefront opens with only those plans and Who we help pages.
ALTER TABLE seller_applications
  ADD COLUMN site_types text[],
  ADD COLUMN site_types_other text,
  ADD COLUMN audiences text[] NOT NULL DEFAULT '{}',
  ADD COLUMN audiences_other text;

-- Down Migration
ALTER TABLE seller_applications DROP COLUMN site_types, DROP COLUMN site_types_other, DROP COLUMN audiences, DROP COLUMN audiences_other;

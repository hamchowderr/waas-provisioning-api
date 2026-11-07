-- Up Migration

-- Whether the applicant said they run a HighLevel agency (the /sell form). Shown to the admin who
-- reviews the application; HighLevel agencies make sites from their sub-accounts with the AnyPress app.
ALTER TABLE seller_applications ADD COLUMN highlevel_agency boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE seller_applications DROP COLUMN highlevel_agency;

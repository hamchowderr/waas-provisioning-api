-- Up Migration
-- Storage packs bought for a store each month (its shop subscription's quantity): each adds STORAGE_PACK_GB (src/plans.ts).
ALTER TABLE tenants ADD COLUMN storage_packs integer NOT NULL DEFAULT 0 CHECK (storage_packs >= 0 AND storage_packs <= 20);

-- Down Migration
ALTER TABLE tenants DROP COLUMN storage_packs;

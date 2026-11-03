-- Up Migration

-- AnyPress Host 2.11.1 reached the storefronts moved onto a version with it, but their active_plugins still named the
-- old waas-host folder, so it stayed off and the push counted them as done. The store agent now fixes that list
-- (STORE_SETUP 15), so every storefront is pushed once more.
DELETE FROM host_updates;

-- Down Migration

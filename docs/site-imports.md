# Moving a site in

For whoever runs the API. A WordPress site running on another host can be moved into a new store. The store keeps the site's own plugins and themes instead of getting its version's code, so the site looks and works the way it did.

## How it goes

1. **A store waits for the site.** `POST /v1/tenants` with `"uploadCustomSnapshot": true` (the dashboard's *Move a site in*, or the connector's `import_site`) creates the tenant Pending, with no snapshot and `own_code = true`, and a `tenant_imports` row. The answer has an `importCode` (`AP1.` + base64url of `{"u": <API address>, "t": <token>}`). Only the token's sha256 is stored. The code works for 7 days, until the move starts; `POST /v1/tenants/import-code` gives a new one (the old one stops working). The tenant shows `waitingForSite: true`, and every change to it except deleting is refused with 409 until the move is done.
2. **The owner runs the AnyPress Export plugin** on the old site (`GET /imports/plugin.zip` downloads the latest stable release; source in waas-plugins `packages/anypress-export`). Under Tools → Move to AnyPress they paste the code, or run `wp anypress-export send <code>`. The plugin works in short steps that survive timeouts: it dumps the database, packs `database.sql`, `waas.json` and `wp-content/` into one gzipped tar in the uploads folder, uploads it, and starts the move. The old site is never changed.
3. **The plugin's calls** take the code in the JSON body and no API key (the token is the credential), and are not request-logged:
   - `POST /imports/upload` answers a 12-hour upload link (`s3://$S3_BUCKET/imports/<store id>`), the most the archive may hold (the store size's storage, at most 5 GB, one PUT's limit) and the store's name, size and address.
   - `POST /imports/start` checks the uploaded size, records what the plugin says about the old site (`tenant_imports.source`: home, WordPress and PHP versions, table prefix, size) and queues `tenant.create`.
   - `POST /imports/status` answers `waiting`, `moving`, `done` (with the store's `url`) or `failed`.
4. **The store is built from the archive.** `tenant.create` makes the store as usual, then the agent's `restore` with `import: true`: it unpacks the archive, removes what must not come along (host drop-ins such as `object-cache.php` and `advanced-cache.php`, backup plugins' folders, the export plugin, and managed hosts' must-use plugins, see `IMPORT_DROP` in `agent.php`), loads the database, renames its tables to the store's prefix (fixing the prefixed option and user meta keys), then runs `update-db` and `configure` (the store's address, its options and constants, the owner's user). Version code is not copied in. The upload is deleted once the store is Done.
5. **Afterwards** the store is an ordinary store that keeps its own code: moving it to another version, rolling it back, restoring it and restoring it after deletion never replace its plugins and themes (`keepsOwnCode: true`). Its updates are the site owner's, as on any WordPress.

## Limits

- Multisite networks are refused by the plugin.
- The archive must fit the store's storage (5, 10 or 25 GB by size) and 5 GB in all. A larger site needs a larger size, or its media moved separately.
- The old host needs PHP 7.4+, zlib and cURL, and room in its uploads folder for the archive.
- Store email, domains, backups and the cron task are the store's, as for any store. The old site's address keeps working where it is until its DNS is moved.

## Housekeeping

The maintenance job deletes stores whose import code expired before the move started, and anything uploaded for them. They never ran, so nothing on the store host is touched.

## Releasing the plugin

The plugin is released like our others: tag `anypress-export-v<x.y.z>` on main in waas-plugins. `GET /imports/plugin.zip` follows the stable channel.

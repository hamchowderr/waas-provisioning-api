# Database backups (off-site)

The API's own Postgres (`waas-api-db`: products, API keys, versions, tenants, domains, backups records, the pg-boss job queue) is the platform's state. Coolify backs it up daily to the VPS disk only, so losing the VPS would lose it and its backups together. The API therefore also backs it up off-site, to the R2 bucket it already uses for store archives.

## What runs

| | |
|---|---|
| When | Daily at 02:30 UTC (pg-boss schedule on the `db-backup` queue; `DB_BACKUP_SCHEDULE` to change). One retry 10 minutes later if it fails. Also on startup when no backup succeeded in the last 26 hours (first deploy, or the API was down at 02:30). |
| What | `pg_dump --format=custom --compress=6` of the whole database (all schemas, `pgboss` included), run from the API container (`postgresql16-client` in the image). |
| Encryption | AES-256-GCM in the API before upload, under a key derived from `SECRETS_KEY` (HKDF-SHA256, info `waas-db-backup-v1`). R2 also encrypts at rest on its side. |
| Where | `s3://$S3_BUCKET/db-backups/YYYY/MM/DD/waas-YYYYMMDDTHHMMSSZ.dump.enc` (`DB_BACKUP_PREFIX` to change the prefix). Store archives use other prefixes, so the store lifecycle rule on `uploads/` does not touch these. |
| Retention | After each successful backup: keep the newest backup of each of the last 14 days that have one and of each of the last 8 ISO weeks; delete the rest (`DB_BACKUP_KEEP_DAILY`, `DB_BACKUP_KEEP_WEEKLY`). Objects under the prefix that don't match the name pattern are never deleted. A second backup on the same day replaces that day's earlier one. |
| Status | Each attempt is a row in `db_backups`. `GET /health` shows `dbBackup: {status, lastAttemptAt, lastSuccessAt, sizeBytes, stale}`; `GET /admin/db-backups` adds every attempt with its object key and error. `stale` turns true when the last success is over 26 hours old. Neither ever makes `/health` answer 503. |
| On/off | On whenever `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are all set (whatever `PROVISIONER` is). `DB_BACKUP=off` turns it off. The startup log line says `database backups off` when they are. |

### Why not Coolify's own S3 backups

Coolify 4.3.23 can send its scheduled database backups to an S3-compatible destination, and R2 works as one. It was not chosen as the off-site copy because:

- it needs the owner to paste an R2 key pair into Coolify by hand (the API can't read the existing one, and should not);
- it uploads the dump unencrypted (R2's server-side encryption only);
- its status is visible only in Coolify, not in `/health` or the dashboard;
- retention is a count or an age, not daily plus weekly.

It is still a fine second copy. To add it (optional, in your Coolify dashboard):

1. In Cloudflare: R2 → Manage API tokens → Create API token, permission **Object Read & Write**, bucket `waas-stores` only. Copy the access key ID and secret.
2. In Coolify: **S3 Storages** (left menu) → **+ Add**. Name `r2-waas`, Endpoint `https://<account id>.r2.cloudflarestorage.com`, Bucket `waas-stores`, Region `auto`, Access Key and Secret Key from step 1. **Validate Connection**, then save.
3. Projects → `WaaS API` → `production` → `waas-api-db` → **Backups** → the existing daily schedule (`0 3 * * *`).
4. Turn on **Save to S3**, pick `r2-waas`, set S3 retention (e.g. 14 backups), **Save**.
5. **Backup Now** once and check the execution shows the S3 upload as successful.

Coolify writes its objects under its own path (`data/coolify/backups/...`), apart from `db-backups/`.

## Keep these somewhere other than the VPS

A backup is useless without them. Coolify holds the only copy of each, so if the VPS goes, they go too:

- `SECRETS_KEY`: decrypts the backups **and** the store passwords and private constants inside them. Copy it from the `waas-api` application's environment into the password manager.
- The R2 access key pair (or Cloudflare dashboard access to make a new one).
- `ADMIN_TOKEN` can be regenerated; API keys survive in the database (hashed).

## Restore

Everything below runs on any machine with Node 22, a checkout of this repository (`npm ci`) and `pg_restore` 16 or newer. Export the settings first; never paste them into files that get committed:

```sh
export SECRETS_KEY=...          # the API's SECRETS_KEY
export S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com S3_BUCKET=waas-stores S3_REGION=auto
export S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
```

1. **Pick a backup.** `npm run db-backup -- list` prints every backup key and size. The newest is usually right; `latest` picks it.
2. **Download and decrypt.** `npm run db-backup -- fetch latest waas.dump` (or a key instead of `latest`). It writes a plain `pg_dump` archive (mode 600); a wrong `SECRETS_KEY` or a damaged object fails here, before anything is touched. Check it reads: `pg_restore --list waas.dump | head`.
3. **Stop the API**, so nothing writes while you restore: Coolify → `waas-api` → Stop.
4. **Get an empty database.**
   - New VPS or new Coolify database: create Postgres 16 (`waas-api-db`), database `waas`, and point `DATABASE_URL` in `waas-api` at it.
   - Existing `waas-api-db`: drop and recreate the `waas` database from its Terminal in Coolify: `psql -U <user> -d postgres -c 'DROP DATABASE waas' -c 'CREATE DATABASE waas'`. This deletes everything in it; take a fresh Coolify backup first if the database is still readable.
5. **Restore.** From a machine that can reach the database (the database's Terminal in Coolify after copying the file in, or a temporary public port):
   ```sh
   PGPASSWORD=... pg_restore --no-owner --exit-on-error --dbname=postgres://<user>@<host>:5432/waas waas.dump
   ```
   `--no-owner` makes the connecting user own everything, which is what the API expects.
6. **Check row counts** against what you expect (or against the old database if it still answers):
   ```sql
   SELECT (SELECT count(*) FROM products) products, (SELECT count(*) FROM api_keys) api_keys,
          (SELECT count(*) FROM versions) versions, (SELECT count(*) FROM tenants) tenants,
          (SELECT count(*) FROM tenant_domains) domains, (SELECT count(*) FROM pgboss.job) jobs;
   ```
7. **Start the API** with the same `SECRETS_KEY`. Migrations run at startup and are no-ops on a current dump. `GET /health` should answer 200; jobs that were queued at backup time run again (they are idempotent). The `db_backups` row of the backup being taken at dump time shows as `failed: interrupted` after the next backup; that is expected.

Work done after the backup (tenants created, domains changed) is not in it. Stores themselves live in Coolify and R2 and are not touched by a database restore; reconcile any store created after the backup by hand.

### Tested

2026-10-07, locally: Postgres 16.15, RustFS as the S3 server. `db-backup run` twice → `list` (same-day retention left one object) → `fetch latest` → `pg_restore --no-owner --exit-on-error` into a new database → row counts identical in all 12 tables, `pgboss.job` and `pgmigrations` included. `test/dbbackup.test.ts` repeats the dump → encrypt → upload → download → decrypt → restore → count check on every CI run.

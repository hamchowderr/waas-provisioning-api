# Store backups (nightly)

Every live store gets a full backup (its files under `wp-content` and its MariaDB database) every night, on top of the manual and suspend backups the contract already has. Each store keeps its own backups; nothing is shared between stores.

## What runs

| | |
|---|---|
| When | Nightly at 09:00 UTC (02:00 Pacific, 05:00 Eastern), pg-boss schedule on the `store-backups` queue (`STORE_BACKUP_SCHEDULE` to change). Also on startup when no scheduled backup was queued in the last 26 hours (first deploy, or the API was down at 09:00). A store that already has a scheduled backup from the last 20 hours is skipped, so a re-run never doubles up. |
| Which stores | Tenants that are Done and not suspended. A suspended store doesn't change and got its own backup when it was suspended. A store that is Pending (being changed) or Failed is skipped that night. |
| How | One `tenant_backups` row per store with reason `scheduled`, and a `tenant.backup` job on the `store-backup` queue. That is the same job a manual backup runs (`Provisioner.backupStore`): on Coolify the store's agent zips `database.sql` and `wp-content` and uploads it to `s3://$S3_BUCKET/backups/<backup id>.zip` (not encrypted by the API, like manual backups; R2 encrypts at rest). The jobs run one store at a time on their own queue, so a night's backups never hold up store creates or changes on the `provision` queue. |
| Failures | One retry 10 minutes later. A backup that still fails is marked Failed, recorded in `job_failures` (shown in the dashboard's Jobs page like any failed job) and does not stop the other stores. The store itself is never touched. |
| Retention | Before each night's run, per store: keep the newest Done scheduled backup of each of the last 7 days that have one and of each of the last 4 ISO weeks (`STORE_BACKUP_KEEP_DAILY`, `STORE_BACKUP_KEEP_WEEKLY`); delete the rest from the bucket and the table. Scheduled backups that never finished are deleted once older than the daily window. Manual and suspend backups are never pruned by this. |
| Deleted stores | Deleting a store stamps all its backups, scheduled ones included, and they are then kept `BACKUP_RETENTION_DAYS` (90) like any deleted tenant's backups. Restoring the store puts them back into the nightly rotation. |
| Status | `GET /v1/tenants/backups` and `GET /admin/backups` list them with reason `scheduled`; the dashboard's Backups page shows them. `GET /admin/overview` counts them with the other backups. |
| On/off | On by default, with any provisioner. `STORE_BACKUP=off` turns it off (and removes the schedule); the startup log line then says `store backups off`. |

## Size and cost

A backup is about the size of the store's uploads plus its database, compressed. A fresh FluentCart store is a few MB; a store with a large media library can be hundreds of MB. With the defaults each store keeps at most 11 scheduled backups (7 daily + up to 4 weekly). At 100 stores of 100 MB that is about 110 GB in R2, roughly $1.65 a month at R2's $0.015/GB, with no egress charges.

The work happens in each store's own agent container (256 MB memory limit), one store at a time, so it adds no more load than a manual backup does.

## Restore

- **A deleted store:** `POST /v1/tenants/restore` brings it back from its newest Done backup (or a chosen `backupId`), scheduled ones included. The storefront plugin does this on its own when a cancelled subscription comes back.
- **A live store:** there is no API call yet to roll a live store back to one of its backups in place. Until there is, the backup can be downloaded from the bucket (`backups/<backup id>.zip`, holding `database.sql` and `wp-content/`) and restored by hand from the store's agent container in Coolify.

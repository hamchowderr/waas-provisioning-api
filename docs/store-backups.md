# Store backups (nightly)

For whoever runs the API. Every live store gets a full backup (its files under `wp-content` and its MariaDB database) every night, on top of the backups taken by hand (`POST /v1/tenants/backups`) and when a store is suspended. Each store keeps its own backups; nothing is shared between stores.

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

## Restore test (nightly)

A backup is only worth something if it restores, so every night the API proves one does.

| | |
|---|---|
| When | Nightly at 11:00 UTC, two hours after the backups, pg-boss schedule on the `restore-test` queue (`RESTORE_TEST_SCHEDULE` to change). Also on startup when no test started in the last 26 hours (first deploy, or the API was down at 11:00). |
| Which store | One per night: the live store (Done, not suspended) with a Done scheduled backup from the last 48 hours that was tested longest ago (never-tested stores first), so every store gets its turn. Its newest scheduled backup is the one tested. |
| How | `Provisioner.testRestore`. On Coolify: a throwaway store Service `store-restore-test-<test id>` on the store's version and size, on the domain `restore-test-<test id>.invalid` (never resolves), with no mail relay settings, no site key and no `wp-cron` task, so it can't email anyone or run scheduled jobs. The agent suspends it first (every request gets the "unavailable" page), then restores the backup into it exactly as a restore does, then its `verify` operation checks that WordPress opens the restored database and reports the site title, home URL, table count and post count. The test store is deleted afterwards, pass or fail. The real store and its backup are never touched. |
| Result | One `restore_tests` row per test: `running`, then `passed` (with `details`: name, home, tables, posts) or `failed` (with `error`). A test still `running` after 3 hours (the API restarted mid-test) is marked failed on the next run and its test store deleted. A test is not retried: a failure is the finding, and the next night tests again. |
| Alerts | A failed test is emailed to `JOB_ALERT_EMAILS` (else `APPLICATION_NOTIFY_EMAILS`) through the sign-in email settings. `/health` reports `restoreTest: { ok, status, lastPassedAt }`; `ok` is false when the last test failed, or none passed in 50 hours while there are live stores. Like `jobs`, it never makes `/health` itself fail. A keyword monitor on `"restoreTest":{"ok":true` alerts on it. |
| Cost | One extra store's containers for the length of the test (minutes for a typical store), one store at a time, and the backup's download from the bucket. |
| On/off | On by default, with any provisioner. `RESTORE_TEST=off` turns it off (and removes the schedule); `/health` then reports `status: "off"`. |

## Size and cost

A backup is about the size of the store's uploads plus its database, compressed. A fresh FluentCart store is a few MB; a store with a large media library can be hundreds of MB. With the defaults each store keeps at most 11 scheduled backups (7 daily + up to 4 weekly). At 100 stores of 100 MB that is about 110 GB in R2, roughly $1.65 a month at R2's $0.015/GB, with no egress charges.

The work happens in each store's own agent container (256 MB memory limit), one store at a time, so it adds no more load than a manual backup does.

## Restore

- **A deleted store:** `POST /v1/tenants/restore` brings it back from its newest Done backup (or a chosen `backupId`), scheduled ones included. The storefront plugin does this on its own when a cancelled subscription comes back.
- **A live store:** `POST /admin/tenants/{id}/restore` with `{"backupId": "…"}` (the dashboard's Restore button on a store's backups) rolls it back in place to any of its Done backups, scheduled ones included. It first backs up what the store holds now as a backup with reason `before-restore` (skip with `"takeBackup": false`), so a rollback to the wrong night can be undone by restoring that one; these are never pruned. Then the store's agent replaces `wp-content` and the database with the backup's, keeping the store's current main domain, and puts back the code of the version the store runs now, upgrades the database to that WordPress if the backup is older, and writes the tenant's current `wpOptions` again. Domains, PHP constants, mail settings, the cron task and suspension are not in the backup and stay as they are. The tenant is Pending while it runs (the store is briefly inconsistent while files are swapped). If the first backup fails, the store is left untouched and Done; if the restore itself still fails after the queue's retries, the tenant is Failed and the Jobs page can retry it.

# Notifications

The dashboard's bell shows what happened to your stores and template versions, newest first, so you
don't have to watch the Jobs page.

## What makes a notification

| Event | Reads as |
|---|---|
| `tenant.ready` | "Acme is ready" |
| `tenant.live` | "Acme is live" |
| `tenant.failed` | "A job on Acme failed" |
| `tenant.backup_failed` | "A backup of Acme failed" |
| `tenant.restored`, `tenant.rolled_back` | The store was restored or rolled back |
| `tenant.suspended`, `tenant.resumed`, `tenant.deleted` | The store went offline, came back, or was deleted |
| `version.ready`, `version.failed` | A template version finished building, or failed |

Smaller changes (settings updates, domain changes, moves to a new version during a rollout) don't
make one; they still go out as [webhooks](webhooks.md). The platform admin also sees new seller
applications and failed nightly restore tests.

Everyone on a storefront's team sees that storefront's notifications. Each person has their own
unread count, cleared when they open the bell. Notifications are kept for 30 days.

## API

The dashboard reads them from `GET /account/notifications` (a signed-in person) or
`GET /admin/notifications?userId=` (the platform admin), and marks them read with
`POST …/notifications/read`. See `openapi/admin/admin-api.yaml`.

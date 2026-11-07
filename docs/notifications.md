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

## Phone and computer alerts

The important ones can also pop up on a phone or computer when the dashboard is closed: a store is
ready, a store job or backup failed, a template version failed, and for the platform admin a new
seller application or a failed restore test. Each person turns alerts on for each device with
**Turn on alerts** in the bell; the browser asks for permission once. On an iPhone or iPad, add the
dashboard to the home screen first (Share, then Add to Home Screen): Apple only allows alerts for
web apps opened from there.

Alerts need a pair of push keys on the API (`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, see
[self-hosting](self-hosting.md)). Without them the button doesn't show.

## API

The dashboard reads them from `GET /account/notifications` (a signed-in person) or
`GET /admin/notifications?userId=` (the platform admin), and marks them read with
`POST …/notifications/read`. Alerts use `GET …/notifications/push` (whether they're on, and the public
key), `POST …/notifications/push` (save this device's subscription) and `POST …/notifications/push/remove`. See `openapi/admin/admin-api.yaml`.

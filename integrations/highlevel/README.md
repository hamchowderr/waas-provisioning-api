# AnyPress for HighLevel

A HighLevel Marketplace app, so an agency's workflows create a WordPress site for each sub-account's client, manage it, and start when a site is ready. Unlike the n8n, Make and Zapier apps there is no package to publish: the app is set up in HighLevel's developer portal (marketplace.gohighlevel.com, My Apps) and every call it makes lands on the API's own routes, in [`src/highlevel.ts`](../../src/highlevel.ts). This page is that setup. `API` below is the API's public address, such as `https://api.anypress.io`.

HighLevel refuses addresses that mention it, so the routes are under `/v1/apps` and `/apps`.

## The app

| Setting | Value |
|---|---|
| Name | AnyPress |
| Target user | Sub-account. Agencies and sub-accounts can both install it; bulk install on, so an agency installs it on all its sub-accounts at once |
| Scopes | `workflows.readonly` (the app's actions and trigger), `oauth.readonly` and `oauth.write` (sub-account tokens from an agency's install) |
| Redirect URL | `API/apps/oauth/callback` |
| Client ID and secret | Set them on the API as `HIGHLEVEL_CLIENT_ID` and `HIGHLEVEL_CLIENT_SECRET` (both or neither). `HIGHLEVEL_API_URL` changes HighLevel's address, for tests |

## Signing in: External Authentication

API key / Basic auth, so the install asks for an AnyPress key and HighLevel sends it with every action and trigger call.

| Field key | Label | Type | Required |
|---|---|---|---|
| `api_key` | AnyPress API key | text | yes |
| `api_secret` | AnyPress API secret | password | yes |
| `storefront` | Storefront ID (partner keys only) | text | no |

- **Authentication request:** `GET API/v1/apps/account` with headers `X-AnyPress-Key: {{userData.api_key}}`, `X-AnyPress-Secret: {{userData.api_secret}}` and `X-AnyPress-Storefront: {{userData.storefront}}`. It answers `{"id", "name", "type": "storefront" | "partner"}`, or 403 for a wrong key.
- **Account info:** use the authentication response; ID `id`, Name `name`.
- Every action and the trigger below send the same three headers.

A storefront's own key works on that storefront. A partner key works on every storefront in the reseller account: the Storefront field of an action, the install's Storefront ID, or `?productId=` says which, in that order.

## Actions

Action and trigger keys start with `anypress_`: HighLevel keys are unique across its whole Marketplace. The API doesn't read them.

Each is an API action: `POST` to the URL with the headers above. HighLevel sends `{"data": {...fields}, "extras": {"locationId", "contactId", "workflowId"}, "meta": {...}}`. Each answers the site as flat fields, so paste the sample below as the action's Response Data and pick the outputs from it.

| Action key | Name | URL | Fields (key, required) |
|---|---|---|---|
| `anypress_create_site` | Create site | `API/v1/apps/actions/create-site` | `name` (yes): Site name, up to 30 characters. `externalId`: Your reference; empty uses the contact's id, so a workflow that runs twice for a contact makes one site. `email` (yes): Client email, which makes their WordPress login. Every site needs one. `username`, `role` (administrator, editor, author, contributor), `size` (small, medium, large), `groupName`: starting site group, `customDomainName`, `notifyOwner` (yes or no, default no): email the client when the site is ready, with a link to set their password, `storefront` |
| `anypress_get_site` | Get site | `API/v1/apps/actions/get-site` | `externalId` or `siteId`, `storefront` |
| `anypress_suspend_site` | Suspend site | `API/v1/apps/actions/suspend-site` | `externalId` or `siteId`, `storefront` |
| `anypress_resume_site` | Resume site | `API/v1/apps/actions/resume-site` | `externalId` or `siteId`, `storefront` |
| `anypress_delete_site` | Delete site | `API/v1/apps/actions/delete-site` | `externalId` or `siteId`, `storefront`. Answers the site as it was, with `deleted: true` |

`storefront` is a Select loaded from an External API: `GET API/v1/apps/storefronts` with the headers above answers `{"options": [{"label", "value"}]}`.

Response sample:

```json
{
  "siteId": "90b97b83-b320-4006-aaa8-dacb0639325c",
  "externalId": "contact42",
  "name": "Rose and Fern",
  "url": "https://rose-and-fern.anypress.site",
  "domainName": "rose-and-fern.anypress.site",
  "statusName": "Pending",
  "isSuspended": false,
  "size": "small",
  "dateCreated": "2026-10-25T17:00:00Z"
}
```

A new site answers `Pending` and is ready a few minutes later: start the welcome step from the trigger, not right after Create site.

## Trigger

| Setting | Value |
|---|---|
| Key | `anypress_site_event` |
| Name | Site event |
| Subscription URL | `API/v1/apps/triggers`, with the headers above |
| Filter | `event`, Select, constants: Site ready `tenant.ready`, Site failed `tenant.failed`, Site suspended `tenant.suspended`, Site resumed `tenant.resumed`, Site deleted `tenant.deleted`, Domains changed `tenant.domains_changed`, Backup completed `tenant.backup_completed`, Backup failed `tenant.backup_failed` |

When a workflow adds, changes or removes the trigger, HighLevel posts it to the subscription URL; the API keeps one webhook endpoint per trigger, for the events its filter picks (every site event without one). When one happens, the API posts the site's flat fields to the trigger's `targetUrl` with the sub-account's HighLevel token: its own install's, or one made from the agency's install. The token is only ever sent to HighLevel's own address. These endpoints show in the storefront's webhooks as "HighLevel workflow" and don't count toward its 10.

Sample data (the trigger's custom variables come from it):

```json
{
  "event": "tenant.ready",
  "siteId": "90b97b83-b320-4006-aaa8-dacb0639325c",
  "externalId": "contact42",
  "name": "Rose and Fern",
  "url": "https://rose-and-fern.anypress.site",
  "domainName": "rose-and-fern.anypress.site",
  "statusName": "Done",
  "isSuspended": false,
  "size": "small",
  "timestamp": "2026-10-25T17:04:00Z"
}
```

`externalId` is the contact's id when Create site made it up, so the workflow can tell which client the site is for.

## Cost and reach

HighLevel bills marketplace actions and triggers per run (LC Premium Triggers & Actions), to the sub-account. A private app installs in up to five agencies; a public listing needs HighLevel's review.

## Tests

`test/highlevel.test.ts` runs the actions, the trigger and the install against a fake HighLevel.

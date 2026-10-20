# OpenAPI files and plugin requirements

For contributors: how the API's OpenAPI files are organised, and what the WordPress plugins rely on beyond what the HTTP calls show. If you only want to call the API, read the reference your server publishes at `/docs` instead.

| File | What it describes |
|---|---|
| `openapi/waas-provisioning-api.yaml` | Stores, domains, versions, snapshots and templates. Version 1.1.0. The main file: edit this one for those calls |
| `openapi/store-mail.yaml` | A store's sending domain and Domain Connect links |
| `openapi/api-keys.yaml` | `/v1/keys` |
| `openapi/webhooks.yaml` | `/v1/webhooks` and the webhook events |
| `openapi/plugin-updates.yaml` | `/v1/plugins/{slug}/update` |
| `openapi/admin/admin-api.yaml` | `/admin/*`, for the dashboard. Not published at `/docs` |

`src/publicspec.ts` joins the first five into the reference served at `/docs` and `/openapi.json`, and strips notes meant for contributors. `npm run sdk:generate` builds the TypeScript SDK's types from them.

## Versioning

Every public call is under `/v1`, and v1 stays backwards compatible: storefront plugins already installed on live sites call it and can't be changed from here. Within v1:

- **Allowed:** new calls, new optional request fields and query parameters, new response fields, new webhook events, new values where the docs say the list can grow.
- **Not allowed:** removing or renaming a call, field or parameter; making an optional field required; changing a field's type or meaning; changing a status code a caller relies on.
- **Replacing something:** add the new call or field, mark the old one `deprecated: true` in the OpenAPI file, and keep it working. It is only removed in a new major version.
- **A change that can't be made this way** goes in `/v2`, served next to `/v1`.

`test/contract.test.ts` checks every response against these files, so a change that breaks existing callers fails CI. `info.version` in the main file follows semver: bump the minor for an addition, the patch for a docs fix.

## Phases

Every operation in the main file carries `x-phase: 1` or `x-phase: 2`.

- **Phase 1 (22 operations):** stores, store domains, versions and snapshots: everything the storefront plugin calls. Five of them were added for AnyPress (tag `TenantLifecycle`): suspend, resume, restore a deleted store, list backups, and back up a store. The storefront suspends and backs up a store when its subscription is cancelled or expires, deletes it after a grace period, and resumes it if the subscription comes back first. If the subscription comes back after the deletion, the storefront restores the store from its newest backup (kept 90 days after deletion), or creates a fresh store when there is none.
- **Phase 2 (11 operations):** the reseller feature: subscriptions, products, templates (base snapshots) and usage, used with reseller (partner) keys. Phase 1 calls then take `productId`. Built so far: `listSubscriptions`, `listProducts`, `createProduct`, `deleteProduct`, `subscriptionUsage` and `productUsage` with a partner key, `productId` on every Phase 1 call with a partner key ([docs/resellers.md](resellers.md)), and the three template operations, which also work with a storefront's own key: a storefront's templates are created through the API and copied into a version with `createVersion`, which is how snapshot groups reach the storefront. A partner key's templates are shared by all its storefronts.

## What the storefront plugin relies on

Every network call in release 2.2.7 of both plugins was traced from its call site to what it sends and every field it reads. These requirements come from that trace:

- `GET /v1/snapshots` accepts `onlyProductionVersion=true`.
- `POST /v1/tenants` makes up an `externalId` when none is sent (release 2.2.7 never sends one). It answers a repeat of the same create (a retry whose answer was lost) with the store it already made, and refuses an `externalId` already used by a different store, even when requests race.
- A wrong key or secret gets **403**, not 401.
- Store domains are bare hostnames. The plugin adds `https://` itself.
- A store's `domainName` equals the creation-time `customDomain ?? baseDomain` exactly (same case, no trailing dot).
- `customDomain` is null or absent when there is none, never an empty string.
- `statusCode` is a JSON integer and `isProduction` a JSON boolean (the plugin compares with `===`).
- The API accepts `Content-Type: application/json` on GET and DELETE requests without a body, query values that aren't URL-encoded, and `[]` as an empty PUT body. Any 2xx counts as success.

## What the client plugin relies on inside each store

Not visible over HTTP, but the WaaS Client plugin depends on them:

- The environment variable `WPCS_IS_TENANT=true`, visible to PHP.
- Each `phpConstants` entry written as a `define()`: `WPCS_TENANT_ROLES` (comma-separated role slugs), `WPCS_PUBLIC_KEY` (base64 of the PEM public key), `WPCS_TENANT_NO_ADMINISTRATOR_PLUGIN_CAPS` (`"true"`).
- `wpOptions` applied, and the WordPress user created with the requested role.
- WaaS Client active in the version's shared code.
- `roles.json` served publicly at `https://{production version domain}/wp-content/plugins/waas-client-data/roles.json`.
- `/wp-json/waas-client/v1/single_login/verify` reachable without signing in.
- The store's home page answers `HEAD https://{domain}` with **200 and no redirect**, or the storefront never marks it Ready.

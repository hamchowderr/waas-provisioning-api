# The contract

For contributors: how the API's OpenAPI contract is organised, and what the WordPress plugins depend on beyond what HTTP shows.

| File | What it is |
|---|---|
| `openapi/waas-provisioning-api.yaml` | **The contract.** Version 1.0.0-draft.6. Edit this. |

## Phases

- **Phase 1 (22 operations):** tenants, tenant domains, versions, snapshots. Everything the storefront plugin calls. Five are not in WPCS v1 (tag `TenantLifecycle`): suspend, resume, restore a deleted tenant, list backups and back up a tenant. The storefront suspends and backs up a store when its subscription is cancelled or expires, deletes it after a grace period, and resumes it if the subscription comes back first. If the subscription comes back after the deletion, it restores the store from its newest backup (kept 90 days after deletion), or creates a fresh store when there is none.
- **Phase 2 (11 operations):** the reseller feature. Subscriptions, products, base snapshots (templates) and usage, used with reseller (partner) keys. Phase 1 calls then take `productId`. The three base-snapshot operations already work with product keys (draft.5): a product's templates are created through the API and copied into a version with `createVersion`, which is how snapshot groups reach the storefront.

Every operation carries `x-phase: 1` or `x-phase: 2`.

## Requirements from the plugin code

Every network call in release 2.2.7 of both plugins was traced from its call site to what it sends and every field it reads. These requirements come from that trace, not from the WPCS docs:

- `GET /v1/snapshots` accepts `onlyProductionVersion=true`.
- `POST /v1/tenants` generates `externalId` when it is omitted (release 2.2.7 never sends one), answers a repeat of the same create (a retry whose answer was lost) with the store it already made, and 409 to an `externalId` already used by a different store, even when requests race.
- Invalid credentials return **403**, not 401.
- Store domains are bare hostnames; the plugin adds `https://` itself.
- A tenant's `domainName` equals the creation-time `customDomain ?? baseDomain` exactly (same case, no trailing dot).
- `customDomain` is null or absent when there is none, never an empty string.
- `statusCode` is a JSON integer and `isProduction` a JSON boolean (the plugin compares with `===`).
- Accept `Content-Type: application/json` on bodiless GET/DELETE, unencoded query values, and `[]` as an empty PUT body. Any 2xx is success.

## Provisioning requirements (inside each store)

Not visible in HTTP, but the Client plugin depends on them:

- Environment variable `WPCS_IS_TENANT=true`, visible to PHP.
- Each `phpConstants` entry written as `define()`: `WPCS_TENANT_ROLES` (comma-separated role slugs), `WPCS_PUBLIC_KEY` (base64 of the PEM public key), `WPCS_TENANT_NO_ADMINISTRATOR_PLUGIN_CAPS` (`"true"`).
- `wpOptions` applied; the WordPress user created with the requested role.
- WaaS Client active in the shared Version code.
- `roles.json` served publicly at `https://{production version domain}/wp-content/plugins/waas-client-data/roles.json`.
- `/wp-json/waas-client/v1/single_login/verify` reachable anonymously.
- The store's home page answers `HEAD https://{domain}` with **200 and no redirect**, or the storefront never marks it Ready.



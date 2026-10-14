# WaaS Provisioning API

The API that creates and runs WordPress websites for a "website as a service" business. A storefront (a WordPress shop running the [WaaS Host plugin](https://github.com/hamchowderr/waas-plugins)) sells a subscription; this API builds the customer's website, gives it a domain and a login, backs it up, and suspends, restores or deletes it as the subscription changes.

It speaks the WPCS v1 API (same paths, parameters and field names), so plugins written for WPCS work with it. It is the backend of [AnyPress](https://anypress.io) and is open source under GPL-3.0.

| Repository | What it is |
|---|---|
| **waas-provisioning-api** (this one) | The API |
| [waas-plugins](https://github.com/hamchowderr/waas-plugins) | WordPress plugins for the storefront and for every customer website |
| [waas-dashboard](https://github.com/hamchowderr/waas-dashboard) | Admin dashboard for everything the API runs |

## What it does

- **Websites (tenants):** create, change options and constants, suspend (503 page), resume, back up, restore, move to a newer template, delete. A deleted website's backups are kept 90 days so it can come back.
- **Templates (versions and snapshots):** websites are copies of a template version; upload a template, make a version production, and new websites use it.
- **Domains:** every website gets a name under your domain (`shop.example.com`) and can add its owner's own domain, with HTTPS certificates issued automatically.
- **Backups:** every live website nightly (files and database) and the API's own database nightly, encrypted, to S3-compatible storage.
- **Email:** websites send through one SMTP relay (toSend by default), and a website can send from its owner's own domain.
- **Plugin updates:** serves signed updates for the storefront plugins.

## How it works

TypeScript on [Hono](https://hono.dev), with [pg-boss](https://github.com/timgit/pg-boss) as the job queue, both on one Postgres database. Requests are checked, recorded and queued; background jobs do the work and set each record to Done or Failed.

The work on the servers websites run on goes through a `Provisioner` (`src/provisioner/provisioner.ts`). There are two:

- `coolify`: each website is a [Coolify](https://coolify.io) Service with its own WordPress, MariaDB and agent containers. Store-side work runs as WP-CLI commands in the agent. How: [docs/coolify.md](docs/coolify.md).
- `fake` (default): in memory, succeeds at once. For trying the API and for tests.

## Quick start

Run the API and its database with Docker, using the fake provisioner. Setting `ADMIN_TOKEN` turns on the admin API, which the dashboard needs:

```sh
export ADMIN_TOKEN=$(openssl rand -base64 32)
docker compose up --build -d
docker compose exec api npm run create-key -- --product-name "Example storefront"
curl -u <key>:<secret> http://localhost:4111/v1/versions
```

`create-key` prints a key and secret once. Each key belongs to one storefront. Requests use Basic auth with the key as username and the secret as password.

Without Docker, with Node 22 or newer and your own Postgres 16 or newer:

```sh
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/waas
export SECRETS_KEY=$(openssl rand -base64 32)   # keep it: losing it makes stored secrets unreadable
npm run create-key -- --product-name "Example storefront"
npm run dev
```

Migrations run at startup.

## Running it for real

[docs/self-hosting.md](docs/self-hosting.md) walks through a production setup: one server with Coolify, DNS, object storage, email, the storefront and the dashboard, then adding servers. It ends with every setting the API reads.

More detail on single topics:

| | |
|---|---|
| [docs/store-backups.md](docs/store-backups.md) | Nightly website backups, retention, restoring |
| [docs/db-backups.md](docs/db-backups.md) | The API's own database backups and how to restore them |
| [docs/store-email.md](docs/store-email.md) | Website email, per-website keys, customers' own sending domains |
| [docs/domain-connect.md](docs/domain-connect.md) | One-click DNS records for customers' domains (Domain Connect) |
| [docs/coolify.md](docs/coolify.md) | How websites run on Coolify |

`GET /health` (no auth) answers 200 when Postgres and the job queue respond, 503 otherwise. Point an uptime monitor at it.

## Admin API

`/admin/*` serves the admin dashboard ([waas-dashboard](https://github.com/hamchowderr/waas-dashboard)). It is not part of the WPCS contract; `openapi/admin/admin-api.yaml` describes it. It sees every product and authenticates with `Authorization: Bearer <ADMIN_TOKEN>`. Product keys, a missing header or a wrong token all get 403, and so does every request when `ADMIN_TOKEN` is not set. The token is compared in constant time and never logged.

| Endpoint | What it returns |
|---|---|
| `GET /admin/overview` | Health, tenant/version/backup counts by status, suspended tenants, job counts (queued, running, failed), products with tenant counts |
| `GET /admin/tenants` | Tenants across products; filters `productId`, `status`, `suspended`, `versionId`, `q` (external id, name or domain); `page`, `pageSize` (max 200) |
| `GET /admin/tenants/{id}` | One tenant: domains, backups, the last 20 jobs and failures; `wpOptions` and `phpConstants` by name only |
| `PUT /admin/tenants/{id}/domains/main` `{"domainName": "…"}` | Makes a domain the store's main address, adding it if new (like `addTenantDomain` with `setAsMainDomain`, any product); the old main domain stays as a redirect |
| `GET`, `PUT` `{"domainName": "…"}`, `DELETE /admin/tenants/{id}/mail-domain` | The store's own sending domain with the DNS records to add; the store sends from it once toSend verifies it, and DELETE moves it back to the platform's address ([docs/store-email.md](docs/store-email.md)) |
| `GET /admin/tenants/{id}/domain-connect?domainName=…&service=website\|email` | A one-click link to add the domain's DNS records at its DNS host, when the host supports Domain Connect ([docs/domain-connect.md](docs/domain-connect.md)) |
| `POST /admin/tenants/{id}/restore` `{"backupId": "…", "takeBackup": true}` | Rolls a live store back to one of its Done backups in place, keeping its domains, version, constants and suspension; backs up what it holds now first (reason `before-restore`) unless `takeBackup` is false |
| `GET /admin/backups` | Backups including deleted tenants', with `expiresAt`; filters `productId`, `tenantId`, `externalId`, `status`, `tenantDeleted` |
| `GET /admin/db-backups` | The database-backup status from `/health`, plus each attempt with its object key, size and error |
| `GET /admin/requests` | The request log: every `/v1` call (failed sign-ins included) and admin change, with status, timing, store, key id, IP and user agent; never bodies or secrets. Kept `REQUEST_LOG_DAYS` (30) |
| `GET /admin/jobs?state=queued\|running\|failed` | One tab of jobs plus counts for all three |
| `GET /admin/products` | Products (storefronts) with tenant and version counts and the production version, and `maxTenants` |
| `PUT /admin/products/{productId}` `{"maxTenants": 5}` | The most tenants the product may have (`null`: no limit). At the limit, `createTenant` and `restoreTenant` answer 400. Lowering it deletes nothing. |
| `GET`/`POST /admin/products/{productId}/versions`, `DELETE …/versions/{id}`, `PUT …/versions/{id}/production` | A product's versions: same requests, rules and responses as `listVersions`, `createVersion`, `deleteVersion` and `setProductionVersion` |
| `GET`/`POST`/`DELETE /admin/products/{productId}/basesnapshots` | A product's templates: same as the base-snapshot operations; `DELETE` takes `?id=` |
| `POST /admin/jobs/failures/{id}/retry` | Re-queues a failed job and puts its record back to Pending (Removing for a delete); only while the record is still Failed; idempotent |

A job that fails its last retry is recorded in `job_failures` (type, tenant or version, error, attempts) before the worker completes it. Job data is never returned: it can hold encrypted secrets.

## Plugin updates

The WordPress plugins in [waas-plugins](https://github.com/hamchowderr/waas-plugins) (waas-host, waas-payments) get their updates from this API, never from GitHub or wordpress.org. It is outside the WPCS contract; [`openapi/plugin-updates.yaml`](openapi/plugin-updates.yaml) describes it.

- `GET /v1/plugins/{slug}/update?version=&channel=stable|beta&site=&wp=&php=`, with the storefront's own API key (Basic auth, as for `/v1`). `slug` is `wpcs-waas-host`, `wpcs-waas-client` or `waas-payments`. It answers the release the channel points at (or the product's pin), with `sha256`, the ed25519 `signature` and a `package` URL that works for 10 minutes. 404 when nothing is released on the channel; 503 when updates aren't configured or the bucket can't be read.
- Every check records the slug, site, version, channel, WordPress and PHP version in `plugin_installs` (also on 404 and 503).
- The API only reads the releases bucket and never signs. waas-plugins' release workflow uploads `releases/<slug>/<version>/<slug>.zip`, its `manifest.json`, and `releases/<slug>/channels/<channel>.json` (a copy of the manifest the channel points at). The plugin checks the sha256 and the signature of `waas-release-v1\n<slug>\n<version>\n<sha256>` against the public keys built into it, so a wrong manifest here can't make a site install something its key didn't sign. If you run your own API, the plugins need your own release key: see the [self-hosting guide](docs/self-hosting.md#plugin-updates).
- Stores don't update themselves: waas-client comes with the template version, and a store moves to a newer one through `moveTenantToAVersion`.

| Admin endpoint | What it does |
|---|---|
| `GET /admin/plugins` | Installs (each site's last reported version) and pins; filters `productId`, `slug` |
| `PUT /admin/products/{productId}/plugins/{slug}/pin` `{"version": "2.3.0"}` | Holds that product's sites at a release that exists in the bucket; it never downgrades a site |
| `DELETE /admin/products/{productId}/plugins/{slug}/pin` | Back to the channel |

Settings: `RELEASES_S3_BUCKET` turns it on. `RELEASES_S3_ENDPOINT`, `RELEASES_S3_ACCESS_KEY_ID`, `RELEASES_S3_SECRET_ACCESS_KEY` and `RELEASES_S3_REGION` default to the `S3_*` values; the key needs read access to the releases bucket only. Manifests are cached in memory for a minute.

## Store templates

`templates/` holds the build scripts for the base snapshots (templates) new stores are created from. [`templates/starter-fluentcart`](templates/starter-fluentcart/README.md) is the starter store: WordPress, WaaS Client, FluentCart and Twenty Twenty-Five. `build.sh` makes the archive, `publish.sh` uploads it through the API and creates a version from it.

## The contract

`openapi/waas-provisioning-api.yaml` is the source of truth for the WPCS-compatible API; the admin and plugin-update endpoints have their own files under `openapi/`. What the plugins depend on, and the contract's history: [docs/contract.md](docs/contract.md).

A public Postman mock of the contract is at `https://2b5454f2-760b-4b86-8589-344ffae396d4.mock.pstmn.io`, useful for testing a plugin without running the API.

## SDKs

Clients for the `/v1` API live in [`sdk/`](sdk), and CI tests both against this API:

- [TypeScript](sdk/typescript/README.md), with types generated from the contract
- [PHP](sdk/php/README.md)

## MCP server

[`mcp/`](mcp) lets an AI agent (Claude, ChatGPT or any MCP client) create and manage stores. The API serves it at `/mcp`, with OAuth sign-in for Claude and ChatGPT connectors or Basic auth with your API key; it also runs locally over stdio, and it comes with a store panel (MCP App) and an Agent Skill. See [mcp/README.md](mcp/README.md).

## Development

### Tests

```sh
npm run typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/waas_test npm test
```

The tests wipe and migrate the database in `TEST_DATABASE_URL` (default shown above), so point it at a throwaway database. `test/contract.test.ts` runs every implemented Phase 1 operation (phases: [docs/contract.md](docs/contract.md#phases)) and validates each response against the OpenAPI schemas; it also checks that the contract still has exactly 22 Phase 1 operations.

### Validate the contract

```sh
npx @redocly/cli lint openapi/waas-provisioning-api.yaml
```

Expected: valid, with two warnings (a localhost server entry, and one unused schema kept from WPCS).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

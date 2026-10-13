# WaaS Provisioning API

Provisioning API for the WaaS platform. It replaces the shut-down WPCS cloud and keeps the WPCS v1 contract (same paths, parameters and field names), so the WaaS Host and Client plugins in [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) keep working.

Contract first: the OpenAPI spec is the source of truth. The API is plain TypeScript: [Hono](https://hono.dev) for HTTP and [pg-boss](https://github.com/timgit/pg-boss) for the job queue, both on one Postgres database. Nothing in it is agentic and it never calls an LLM. The payment-processor audits are a separate Mastra service (waas-api-2hl.6); this API only queues work for it.

All 22 Phase 1 operations are implemented: versions (list, create, delete, set production), snapshots (list, download), tenants (list, create, update options and constants, delete, move to a version), tenant domains (list, add, remove, set main, availability, and the deprecated add) and tenant lifecycle (suspend, resume, restore a deleted tenant, list backups, back up). Store-side work runs on the fake provisioner until a host driver exists (waas-api-2hl.7).

## How it works

- `GET /health` (no auth, outside the WPCS contract) answers 200 `{ok, database, queue, dbBackup}` when Postgres and the job queue respond within 3 seconds, and 503 otherwise. It is meant for uptime monitoring. `dbBackup` is the last off-site database backup (`status`, `lastAttemptAt`, `lastSuccessAt`, `sizeBytes`, `stale`); it never causes a 503.
- The API backs up its own database daily to the S3 bucket (`db-backups/`), encrypted, with 14 daily and 8 weekly kept. Setup, status and the restore runbook: [docs/db-backups.md](docs/db-backups.md).
- Every live store is backed up nightly (files and database, reason `scheduled`), one store at a time, keeping 7 daily and 4 weekly per store: [docs/store-backups.md](docs/store-backups.md).
- Every request authenticates with Basic auth: the API key as username, the secret as password. Each key belongs to one product (one storefront). Only a scrypt hash of each secret is stored. Any bad credential gets 403.
- Writes are asynchronous. The request validates, records the change with `statusCode` 0 (Pending) or 3 (Removing), queues a job in the same transaction, and returns. The job moves the record to 1 (Done), or 2 (Failed) after 3 retries, or deletes it.
- Jobs for the same version, or the same tenant, run one at a time in arrival order (pg-boss `key_strict_fifo` queue), so a delete waits for the build before it.
- All work on the machines stores run on goes through the `Provisioner` interface (`src/provisioner/provisioner.ts`). The store host is not chosen yet (`docs/hosting.md`, waas-api-2hl.4), so the only implementation is an in-memory fake that succeeds at once. Its upload URLs and snapshot downloads are placeholders.
- Request bodies are checked against the contract's schemas. Fields the contract doesn't define are dropped, not rejected.
- Values a store needs back in plain form (the first user's password, `phpConstants` marked `isPrivate`) can't be hashed, so they are encrypted with AES-256-GCM under `SECRETS_KEY` wherever they are stored, including queue jobs.
- Domain names are bare lowercase hostnames and belong to one store only; version domains count as taken. Every domain change re-applies the tenant's full domain list in one job, with the tenant Pending until it finishes.
- Suspend takes a backup first unless `takeBackup` is false; suspend and resume are idempotent. Backups have no foreign key to their tenant: they stay listable after the tenant is deleted and a daily job (pg-boss schedule on the `maintenance` queue) deletes them `BACKUP_RETENTION_DAYS` after the deletion. Each backup records the tenant's `wpOptions` and `phpConstants` when it was taken, and deleting a tenant stamps its name, version and domains on its backups, so restore can bring it back with the same id, `externalId` and domains (on its old version, or production if that version is gone).
- A tenant created without `externalId` gets its own id as `externalId`. A `tenantId` that isn't a UUID is looked up as an external ID (storefront plugin 2.2.7 sends it that way).

## Admin API

`/admin/*` serves the admin dashboard (epic waas-api-plu). It is not part of the WPCS contract; `openapi/admin/admin-api.yaml` describes it. It sees every product and authenticates with `Authorization: Bearer <ADMIN_TOKEN>`. Product keys, a missing header or a wrong token all get 403, and so does every request when `ADMIN_TOKEN` is not set. The token is compared in constant time and never logged.

| Endpoint | What it returns |
|---|---|
| `GET /admin/overview` | Health, tenant/version/backup counts by status, suspended tenants, job counts (queued, running, failed), products with tenant counts |
| `GET /admin/tenants` | Tenants across products; filters `productId`, `status`, `suspended`, `versionId`, `q` (external id, name or domain); `page`, `pageSize` (max 200) |
| `GET /admin/tenants/{id}` | One tenant: domains, backups, the last 20 jobs and failures; `wpOptions` and `phpConstants` by name only |
| `PUT /admin/tenants/{id}/domains/main` `{"domainName": "…"}` | Makes a domain the store's main address, adding it if new (like `addTenantDomain` with `setAsMainDomain`, any product); the old main domain stays as a redirect |
| `GET /admin/backups` | Backups including deleted tenants', with `expiresAt`; filters `productId`, `tenantId`, `externalId`, `status`, `tenantDeleted` |
| `GET /admin/db-backups` | The database-backup status from `/health`, plus each attempt with its object key, size and error |
| `GET /admin/jobs?state=queued\|running\|failed` | One tab of jobs plus counts for all three |
| `GET /admin/products` | Products (storefronts) with tenant and version counts and the production version, and `maxTenants` |
| `PUT /admin/products/{productId}` `{"maxTenants": 5}` | The most tenants the product may have (`null`: no limit). At the limit, `createTenant` and `restoreTenant` answer 400. Lowering it deletes nothing. Migration `1760600000000` sets 5 on the test storefronts' product (the one whose key id starts `eacd7333`) |
| `GET`/`POST /admin/products/{productId}/versions`, `DELETE …/versions/{id}`, `PUT …/versions/{id}/production` | A product's versions: same requests, rules and responses as `listVersions`, `createVersion`, `deleteVersion` and `setProductionVersion` |
| `GET`/`POST`/`DELETE /admin/products/{productId}/basesnapshots` | A product's templates: same as the base-snapshot operations (draft.5); `DELETE` takes `?id=` |
| `POST /admin/jobs/failures/{id}/retry` | Re-queues a failed job and puts its record back to Pending (Removing for a delete); only while the record is still Failed; idempotent |

A job that fails its last retry is recorded in `job_failures` (type, tenant or version, error, attempts) before the worker completes it. Job data is never returned: it can hold encrypted secrets.

## Plugin updates

Our WordPress plugins (waas-host, waas-payments) get their updates from this API, never from GitHub or wordpress.org (waas-hw4). It is outside the WPCS contract; [`openapi/plugin-updates.yaml`](openapi/plugin-updates.yaml) describes it.

- `GET /v1/plugins/{slug}/update?version=&channel=stable|beta&site=&wp=&php=`, with the storefront's own API key (Basic auth, as for `/v1`). `slug` is `wpcs-waas-host`, `wpcs-waas-client` or `waas-payments`. It answers the release the channel points at (or the product's pin), with `sha256`, the ed25519 `signature` and a `package` URL that works for 10 minutes. 404 when nothing is released on the channel; 503 when updates aren't configured or the bucket can't be read.
- Every check records the slug, site, version, channel, WordPress and PHP version in `plugin_installs` (also on 404 and 503).
- The API only reads the releases bucket and never signs. waas-plugins' release workflow uploads `releases/<slug>/<version>/<slug>.zip`, its `manifest.json`, and `releases/<slug>/channels/<channel>.json` (a copy of the manifest the channel points at). The plugin checks the sha256 and the signature of `waas-release-v1\n<slug>\n<version>\n<sha256>` against the public keys built into it, so a wrong manifest here can't make a site install something we didn't sign.
- Stores don't update themselves: waas-client comes with the template version, and a store moves to a newer one through `moveTenantToAVersion`.

| Admin endpoint | What it does |
|---|---|
| `GET /admin/plugins` | Installs (each site's last reported version) and pins; filters `productId`, `slug` |
| `PUT /admin/products/{productId}/plugins/{slug}/pin` `{"version": "2.3.0"}` | Holds that product's sites at a release that exists in the bucket; it never downgrades a site |
| `DELETE /admin/products/{productId}/plugins/{slug}/pin` | Back to the channel |

Settings: `RELEASES_S3_BUCKET` turns it on (`waas-releases`). `RELEASES_S3_ENDPOINT`, `RELEASES_S3_ACCESS_KEY_ID`, `RELEASES_S3_SECRET_ACCESS_KEY` and `RELEASES_S3_REGION` default to the `S3_*` values; the key needs read access to the releases bucket only. Manifests are cached in memory for a minute.

## Run locally

With Docker:

```sh
docker compose up --build
docker compose exec api npm run create-key -- --product-name "Example storefront"
curl -u <key>:<secret> http://localhost:4111/v1/versions
```

`create-key` prints the key and secret once; the secret cannot be shown again. `--product <uuid>` adds a key to an existing product.

Without Docker, against your own Postgres (16 or newer):

```sh
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/waas
export SECRETS_KEY=$(openssl rand -base64 32)   # keep it: losing it makes stored secrets unreadable
npm run create-key -- --product-name "Example storefront"
npm run dev
```

Migrations run at startup. Settings: `DATABASE_URL` (required), `SECRETS_KEY` (required, 32 bytes base64; docker-compose sets a development value), `PORT` (default 4111), `STORES_DOMAIN` (default `stores.waas.example`; stores get `t-<id>.<STORES_DOMAIN>`), `VERSIONS_DOMAIN` (default `versions.waas.example`), `BACKUP_RETENTION_DAYS` (default 90; how long a deleted tenant's backups are kept), `ADMIN_TOKEN` (optional; enables `/admin/*`, generate with `openssl rand -base64 32`). Database backups run when the `S3_*` settings below are set (`DB_BACKUP=off` to stop them; `DB_BACKUP_SCHEDULE`, `DB_BACKUP_PREFIX`, `DB_BACKUP_KEEP_DAILY`, `DB_BACKUP_KEEP_WEEKLY`: see [docs/db-backups.md](docs/db-backups.md)); `npm run db-backup -- run|list|fetch` takes, lists and downloads them. Nightly store backups are on unless `STORE_BACKUP=off` (`STORE_BACKUP_SCHEDULE`, `STORE_BACKUP_KEEP_DAILY`, `STORE_BACKUP_KEEP_WEEKLY`: see [docs/store-backups.md](docs/store-backups.md)).

`PROVISIONER` picks who does the store-side work: `fake` (default; in memory, for local runs and tests) or `coolify` (each store is a Coolify Service; see [ADR 0001](docs/adr/0001-coolify-provisioner.md)). `coolify` also needs `COOLIFY_URL`, `COOLIFY_TOKEN` (read, read:sensitive, write and deploy; not root. Without read:sensitive Coolify hides the store agent's output, so every store create fails), `COOLIFY_SERVER_UUID`, `COOLIFY_PROJECT_UUID` (the `WaaS Stores` project), and an S3-compatible bucket: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` (default `auto`). A suspended store answers 503 with a shared "website unavailable" page crediting AnyPress; `STORE_BRAND_NAME` and `STORE_BRAND_URL` (optional link) change the name, taking effect on the next suspend. Stores live on anypress.io: a customer's store is `<website name>.anypress.io` (the storefront plugin's root domain setting), with an internal base name `t-<id8>.stores.anypress.io` (`STORES_DOMAIN=stores.anypress.io`) and version sites on `VERSIONS_DOMAIN=versions.anypress.io`. `PLATFORM_DOMAIN=anypress.io` keeps the apex and reserved names (`www`, `api`, `app`, `stores`, … in `src/tenants.ts`) from ever being given to a store. Steps and DNS records: ADR 0001, "Switching to an owned domain". Stores send email through one SMTP relay (toSend by default) once `STORE_SMTP_PASSWORD` and `STORE_MAIL_FROM` are set, each with its own toSend key when `TOSEND_ADMIN_KEY` is set: [docs/store-email.md](docs/store-email.md).

## Deployment

The API runs on Otaku's Hostinger VPS through Coolify (https://coolify.otakusolutions.io), at **https://waas-api.otakusolutions.io**. It still uses the fake provisioner, so it serves test data only. No API keys have been created yet.

| | |
|---|---|
| Coolify project | `WaaS API` (`4agsx9szalenyncprdbrffma`), environment `production` |
| Application | `waas-api` (`pxht6lp0peqr4ucgijutnkks`): this repo, branch `main`, built from `Dockerfile`, port 4111, health check `GET /health`, through the Coolify GitHub App |
| Database | `waas-api-db` (`iyrj7t91motv1kno8zmeg6pn`): Postgres 16, not public, reached by the app at host `iyrj7t91motv1kno8zmeg6pn` on Coolify's internal network. Coolify backs it up daily at 03:00 UTC and keeps the last 14 backups on the VPS. The API sends its own encrypted backup to R2 daily at 02:30 UTC ([docs/db-backups.md](docs/db-backups.md)). |
| DNS | A record `waas-api.otakusolutions.io` → `191.101.15.236`; Coolify's Traefik serves HTTPS with a Let's Encrypt certificate |

Environment variables (values only in Coolify, under the application's Environment Variables): `DATABASE_URL`, `SECRETS_KEY`, `ADMIN_TOKEN`, `STORES_DOMAIN` and `VERSIONS_DOMAIN` (`stores.invalid` and `versions.invalid` while the fake provisioner runs; `stores.anypress.io` and `versions.anypress.io` once `PROVISIONER=coolify`), `PLATFORM_DOMAIN` (`anypress.io`).

`ADMIN_TOKEN` turns on `/admin/*`. It was generated straight into Coolify and its value exists only there. The dashboard gets it by copying it from the `waas-api` application's environment. To rotate it, generate a new one (`openssl rand -base64 32`), set it in both places and redeploy both.

`SECRETS_KEY` is the only copy of the key that encrypts stored store passwords and private constants. It lives in Coolify's environment and nowhere else. If it is lost or changed, those values can no longer be decrypted. Never rotate it without a migration that re-encrypts them.

Redeploying: every push to `main` deploys automatically. To redeploy by hand, use Deploy on the application in Coolify, or `POST /api/v1/deploy?uuid=pxht6lp0peqr4ucgijutnkks`. Migrations run at startup.

To create a key in production, open the application's Terminal in Coolify and run `npm run create-key -- --product-name "<storefront>"`.

Open items:

- Keep a copy of `SECRETS_KEY` off the VPS (password manager). The off-site database backups are encrypted under a key derived from it, and the data inside needs it too.

## Store templates

`templates/` holds the build scripts for the base snapshots (templates) new stores are created from. [`templates/starter-fluentcart`](templates/starter-fluentcart/README.md) is the starter store: WordPress, WaaS Client, FluentCart and Twenty Twenty-Five. `build.sh` makes the archive, `publish.sh` uploads it through the API and creates a version from it.

## Test

```sh
npm run typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/waas_test npm test
```

The tests wipe and migrate the database in `TEST_DATABASE_URL` (default shown above), so point it at a throwaway database. `test/contract.test.ts` runs every implemented Phase 1 operation and validates each response against the OpenAPI schemas; it also checks that the contract still has exactly 22 Phase 1 operations.

## Work tracking (beads)

Work is tracked in [beads](https://github.com/steveyegge/beads) (prefix `waas-api`). The issues live in the private DoltHub database [`chowderr/waas_api`](https://www.dolthub.com/repositories/chowderr/waas_api), not in git: `bd dolt pull` to get others' changes, `bd dolt push` after yours. `.beads/issues.jsonl` is a local export and is git-ignored.

On a fresh clone, with a DoltHub credential in dolt (`dolt creds ls`; in Claude Code cloud sessions the SessionStart hook in `.claude/settings.json` imports it from `DOLT_CREDS_JWK`): `bd init --prefix waas-api --skip-agents --skip-hooks --remote chowderr/waas_api`, then `bd dolt pull`.

The plugin fork is tracked separately in [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) (prefix `waas`).

## Contract

| File | What it is |
|---|---|
| `openapi/waas-provisioning-api.yaml` | **The contract.** Version 1.0.0-draft.6. Edit this. |
| `openapi/reference/wpcs-v1-corrected.json` | The original WPCS v1 spec, recovered from the archived docs.wpcs.io bundle (Wayback capture 2024-09-08) with 27 corrections. Reference only. |

### Phases

- **Phase 1 (22 operations):** tenants, tenant domains, versions, snapshots. Everything the storefront plugin calls. Five are not in WPCS v1 (tag `TenantLifecycle`): suspend, resume, restore a deleted tenant, list backups and back up a tenant. The storefront suspends and backs up a store when its subscription is cancelled or expires, deletes it after a grace period, and resumes it if the subscription comes back first. If the subscription comes back after the deletion, it restores the store from its newest backup (kept 90 days after deletion), or creates a fresh store when there is none.
- **Phase 2 (11 operations):** the reseller feature. Subscriptions, products, base snapshots (templates) and usage, used with reseller (partner) keys. Phase 1 calls then take `productId`. The three base-snapshot operations already work with product keys (draft.5): a product's templates are created through the API and copied into a version with `createVersion`, which is how snapshot groups reach the storefront.

Every operation carries `x-phase: 1` or `x-phase: 2`.

### Requirements from the plugin code

Every network call in release 2.2.7 of both plugins was traced from its call site to what it sends and every field it reads. These requirements come from that trace, not from the WPCS docs:

- `GET /v1/snapshots` accepts `onlyProductionVersion=true`.
- `POST /v1/tenants` generates `externalId` when it is omitted (release 2.2.7 never sends one), and answers 400 to an `externalId` already in use, even when two requests race.
- Invalid credentials return **403**, not 401.
- Store domains are bare hostnames; the plugin adds `https://` itself.
- A tenant's `domainName` equals the creation-time `customDomain ?? baseDomain` exactly (same case, no trailing dot).
- `customDomain` is null or absent when there is none, never an empty string.
- `statusCode` is a JSON integer and `isProduction` a JSON boolean (the plugin compares with `===`).
- Accept `Content-Type: application/json` on bodiless GET/DELETE, unencoded query values, and `[]` as an empty PUT body. Any 2xx is success.

### Provisioning requirements (inside each store)

Not visible in HTTP, but the Client plugin depends on them:

- Environment variable `WPCS_IS_TENANT=true`, visible to PHP.
- Each `phpConstants` entry written as `define()`: `WPCS_TENANT_ROLES` (comma-separated role slugs), `WPCS_PUBLIC_KEY` (base64 of the PEM public key), `WPCS_TENANT_NO_ADMINISTRATOR_PLUGIN_CAPS` (`"true"`).
- `wpOptions` applied; the WordPress user created with the requested role.
- WaaS Client active in the shared Version code.
- `roles.json` served publicly at `https://{production version domain}/wp-content/plugins/waas-client-data/roles.json`.
- `/wp-json/waas-client/v1/single_login/verify` reachable anonymously.
- The store's home page answers `HEAD https://{domain}` with **200 and no redirect**, or the storefront never marks it Ready.

## Postman

Workspace **Peptide WaaS** holds:
- the same spec
- a collection generated from it (**WaaS Provisioning API**), with tests and named examples on all 22 Phase 1 requests, the five `TenantLifecycle` requests included
- a public mock: `https://2b5454f2-760b-4b86-8589-344ffae396d4.mock.pstmn.io`
- two environments, **Mock** and **Local**

Keep the spec here and in Postman identical. The Postman connector rejects the full spec (about 100 KB, HTTP 413), so paste it into the Postman spec by hand after changing it here.

Each request sends `x-mock-response-name`, which picks the example the mock returns. Example names are `<request name>: <example>` (for example `List versions: 403 Invalid API key or secret`). They must be unique across the collection, because the mock looks names up across the whole collection.

An example added through the Postman API needs its request attached (`requestObject`), or the mock can't find it.

Run the Phase 1 tests against the mock:

```sh
npx newman run <exported collection>.json -e <exported Mock environment>.json
```

Expected: 22 requests, 87 assertions, 0 failures. Run the collection in order: List tenant backups sets the `backupId` that Restore deleted tenant uses.

## Validate

```sh
npx @redocly/cli lint openapi/waas-provisioning-api.yaml
```

Expected: valid, with three warnings (no license, a localhost server entry, one unused schema kept from WPCS).

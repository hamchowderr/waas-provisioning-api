# WaaS Provisioning API

Provisioning API for the WaaS platform. It replaces the shut-down WPCS cloud and keeps the WPCS v1 contract (same paths, parameters and field names), so the WaaS Host and Client plugins in [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) keep working.

Contract first: the OpenAPI spec is the source of truth. The API is plain TypeScript: [Hono](https://hono.dev) for HTTP and [pg-boss](https://github.com/timgit/pg-boss) for the job queue, both on one Postgres database. Nothing in it is agentic and it never calls an LLM. The payment-processor audits are a separate Mastra service (waas-api-2hl.6); this API only queues work for it.

All 22 Phase 1 operations are implemented: versions (list, create, delete, set production), snapshots (list, download), tenants (list, create, update options and constants, delete, move to a version), tenant domains (list, add, remove, set main, availability, and the deprecated add) and tenant lifecycle (suspend, resume, restore a deleted tenant, list backups, back up). Store-side work runs on the fake provisioner until a host driver exists (waas-api-2hl.7).

## How it works

- `GET /health` (no auth, outside the WPCS contract) answers 200 `{ok, database, queue}` when Postgres and the job queue respond within 3 seconds, and 503 otherwise. It is meant for uptime monitoring.
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
| `GET /admin/backups` | Backups including deleted tenants', with `expiresAt`; filters `productId`, `tenantId`, `externalId`, `status`, `tenantDeleted` |
| `GET /admin/jobs?state=queued\|running\|failed` | One tab of jobs plus counts for all three |
| `POST /admin/jobs/failures/{id}/retry` | Re-queues a failed job and puts its record back to Pending (Removing for a delete); only while the record is still Failed; idempotent |

A job that fails its last retry is recorded in `job_failures` (type, tenant or version, error, attempts) before the worker completes it. Job data is never returned: it can hold encrypted secrets.

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

Migrations run at startup. Settings: `DATABASE_URL` (required), `SECRETS_KEY` (required, 32 bytes base64; docker-compose sets a development value), `PORT` (default 4111), `STORES_DOMAIN` (default `stores.waas.example`; stores get `t-<id>.<STORES_DOMAIN>`), `VERSIONS_DOMAIN` (default `versions.waas.example`), `BACKUP_RETENTION_DAYS` (default 90; how long a deleted tenant's backups are kept), `ADMIN_TOKEN` (optional; enables `/admin/*`, generate with `openssl rand -base64 32`).

## Deployment

The API runs on Otaku's Hostinger VPS through Coolify (https://coolify.otakusolutions.io), at **https://waas-api.otakusolutions.io**. It still uses the fake provisioner, so it serves test data only. No API keys have been created yet.

| | |
|---|---|
| Coolify project | `WaaS API` (`4agsx9szalenyncprdbrffma`), environment `production` |
| Application | `waas-api` (`pxht6lp0peqr4ucgijutnkks`): this repo, branch `main`, built from `Dockerfile`, port 4111, health check `GET /health`, through the Coolify GitHub App |
| Database | `waas-api-db` (`iyrj7t91motv1kno8zmeg6pn`): Postgres 16, not public, reached by the app at host `iyrj7t91motv1kno8zmeg6pn` on Coolify's internal network. Coolify backs it up daily at 03:00 UTC and keeps the last 14 backups on the VPS (not off-site). |
| DNS | A record `waas-api.otakusolutions.io` → `191.101.15.236`; Coolify's Traefik serves HTTPS with a Let's Encrypt certificate |

Environment variables (values only in Coolify, under the application's Environment Variables): `DATABASE_URL`, `SECRETS_KEY`, `STORES_DOMAIN` and `VERSIONS_DOMAIN` (`stores.invalid` and `versions.invalid` until a store host is chosen). `ADMIN_TOKEN` is not set yet, so `/admin/*` answers 403 to everything.

`SECRETS_KEY` is the only copy of the key that encrypts stored store passwords and private constants. It lives in Coolify's environment and nowhere else. If it is lost or changed, those values can no longer be decrypted. Never rotate it without a migration that re-encrypts them.

Redeploying: every push to `main` deploys automatically. To redeploy by hand, use Deploy on the application in Coolify, or `POST /api/v1/deploy?uuid=pxht6lp0peqr4ucgijutnkks`. Migrations run at startup.

To create a key in production, open the application's Terminal in Coolify and run `npm run create-key -- --product-name "<storefront>"`.

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
| `openapi/waas-provisioning-api.yaml` | **The contract.** Version 1.0.0-draft.5. Edit this. |
| `openapi/reference/wpcs-v1-corrected.json` | The original WPCS v1 spec, recovered from the archived docs.wpcs.io bundle (Wayback capture 2024-09-08) with 27 corrections. Reference only. |

### Phases

- **Phase 1 (22 operations):** tenants, tenant domains, versions, snapshots. Everything the storefront plugin calls. Five are not in WPCS v1 (tag `TenantLifecycle`): suspend, resume, restore a deleted tenant, list backups and back up a tenant. The storefront suspends and backs up a store when its subscription is cancelled or expires, deletes it after a grace period, and resumes it if the subscription comes back first. If the subscription comes back after the deletion, it restores the store from its newest backup (kept 90 days after deletion), or creates a fresh store when there is none.
- **Phase 2 (11 operations):** the reseller feature. Subscriptions, products, base snapshots (templates) and usage, used with reseller (partner) keys. Phase 1 calls then take `productId`. The three base-snapshot operations already work with product keys (draft.5): a product's templates are created through the API and copied into a version with `createVersion`, which is how snapshot groups reach the storefront.

Every operation carries `x-phase: 1` or `x-phase: 2`.

### Requirements from the plugin code

Every network call in release 2.2.7 of both plugins was traced from its call site to what it sends and every field it reads. These requirements come from that trace, not from the WPCS docs:

- `GET /v1/snapshots` accepts `onlyProductionVersion=true`.
- `POST /v1/tenants` generates `externalId` when it is omitted (the plugin never sends one).
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
- a collection generated from it (**WaaS Provisioning API**), with tests on all 17 Phase 1 requests and named examples
  (the five `TenantLifecycle` requests from draft.3/draft.4 are not in the collection yet; their spec examples are named `<request name>: <example>` for the import)
- a public mock: `https://2b5454f2-760b-4b86-8589-344ffae396d4.mock.pstmn.io`
- two environments, **Mock** and **Local (Mastra)**

Keep the spec here and in Postman identical.

Each request sends `x-mock-response-name`, which picks the example the mock returns. Example names are `<request name>: <example>` (for example `List versions: 403 Invalid API key or secret`). They must be unique across the collection, because the mock looks names up across the whole collection.

An example added through the Postman API needs its request attached (`requestObject`), or the mock can't find it.

Run the Phase 1 tests against the mock:

```sh
npx newman run <exported collection>.json -e <exported Mock environment>.json
```

Expected: 17 requests, 57 assertions, 0 failures.

## Validate

```sh
npx @redocly/cli lint openapi/waas-provisioning-api.yaml
```

Expected: valid, with three warnings (no license, a localhost server entry, one unused schema kept from WPCS).

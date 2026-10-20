# WaaS Provisioning API

An open-source API that creates and runs WordPress stores for a "website as a service" business. Your storefront, or your own code, asks for a store; the API builds it, gives it a domain and a login, backs it up, and suspends, restores or deletes it when you ask.

It is written for agencies that sell websites and for anyone who wants to host the platform themselves. It is the backend of [AnyPress](https://anypress.io) and is licensed under GPL-3.0.

| Repository | What it is |
|---|---|
| **waas-provisioning-api** (this one) | The API, plus SDKs for TypeScript and PHP |
| [waas-plugins](https://github.com/hamchowderr/waas-plugins) | WordPress plugins for the storefront (WaaS Host) and for every store (WaaS Client) |
| [waas-dashboard](https://github.com/hamchowderr/waas-dashboard) | The dashboard for everything the API runs |

## Contents

- [Words used in these docs](#words-used-in-these-docs)
- [Quick start](#quick-start)
- [API reference](#api-reference)
- [SDKs](#sdks)
- [Running it for real](#running-it-for-real)
- [What it does](#what-it-does) and [how it works](#how-it-works)
- Reference: [API keys](#api-keys), [admin API](#admin-api), [plugin updates](#plugin-updates), [store templates](#store-templates), [OpenAPI files](#openapi-files), [MCP server](#mcp-server)
- [Development](#development)

## Words used in these docs

| Word | Meaning |
|---|---|
| **Store** | One customer's WordPress website. The API calls a store a **tenant**: `/v1/tenants`, `tenantId`. |
| **Storefront** | The WordPress shop that sells stores, usually an agency's site running the WaaS Host plugin. The API calls a storefront a **product**: every API key, store, version and webhook belongs to one product. |
| **API key and secret** | How a storefront signs in. The **key** (a UUID, also called the key id) is the Basic auth username and the **secret** is the password. The secret is shown once, when the key is made. |
| **externalId** | Your own id for a store, such as an order or subscription id. Every store call accepts `externalId` or `tenantId`. |
| **Version** | The WordPress setup new stores are copied from: WordPress and PHP versions plus the plugins and themes. One version per product is the **production** version, and new stores use it. |
| **Snapshot** | The content a store starts with (database and `wp-content`), kept in a version. |
| **Template** | An uploaded archive a version can start from. The API calls a template a **base snapshot**: `/v1/basesnapshots`. |
| **Status** | Every change runs in the background. `statusCode` is `0` Pending, `1` Done, `2` Failed or `3` Removing. Poll it, or get a [webhook](docs/webhooks.md). |
| **Admin API** | `/admin/*`, for whoever runs the API. It sees every product. Agencies use the `/v1` API instead. |

## Quick start

This runs the API on your computer with Docker. It uses the **fake provisioner**, which builds nothing and answers every change with Done at once, so you can try the API without servers.

```sh
git clone https://github.com/hamchowderr/waas-provisioning-api && cd waas-provisioning-api
docker compose up --build -d
docker compose exec api npm run create-key -- --product-name "Example storefront"
```

`create-key` makes a product (a storefront) and prints its API key and secret once. Put them in your shell:

```sh
export API=http://localhost:4111 KEY=<key> SECRET=<secret>
```

A store is copied from a version, so make a version first and set it as production. `useCustomUpload` means you will upload the site archive yourself; the fake provisioner does not need one.

```sh
curl -u "$KEY:$SECRET" -H 'Content-Type: application/json' \
  -d '{"name": "starter", "phpVersion": "8.3", "wordPressVersion": "6.8", "useCustomUpload": true}' \
  "$API/v1/versions"
# The answer has the version's "id". Use it here:
curl -u "$KEY:$SECRET" -X PUT -H 'Content-Type: application/json' \
  -d '{"versionId": "<version id>"}' "$API/v1/versions/production"
```

Now ask for a store, then check on it:

```sh
curl -u "$KEY:$SECRET" -H 'Content-Type: application/json' \
  -d '{"name": "Acme Shop", "externalId": "order-1042"}' "$API/v1/tenants"
curl -u "$KEY:$SECRET" "$API/v1/tenants?externalId=order-1042"
```

The store is ready when `statusCode` is `1` (Done). `domainName` is its address.

Stores come in three sizes, `small` (the default), `medium` and `large`, with more CPU, storage and email a month as they grow ([docs/coolify.md](docs/coolify.md#resource-limits)). Send `size` when creating a store, or `PUT /v1/tenants` with a new one.

When something is wrong, the API answers with an HTTP error and a message. A wrong key or secret gets 403:

```sh
curl -u "$KEY:wrong" "$API/v1/tenants"
# {"statusCode":403,"message":"Invalid API key or secret"}
```

To use the dashboard too, set `ADMIN_TOKEN` before `docker compose up`. It turns on the admin API:

```sh
export ADMIN_TOKEN=$(openssl rand -base64 32)
```

Without Docker, use Node 22 or newer and your own Postgres 16 or newer:

```sh
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/waas
export SECRETS_KEY=$(openssl rand -base64 32)   # keep it: without it, stored secrets can't be read
npm run create-key -- --product-name "Example storefront"
npm run dev
```

The database migrations run when the API starts.

## API reference

Every server publishes its own reference, with no sign-in needed:

- `GET /docs`: a page you can browse, and try calls from with your API key and secret.
- `GET /openapi.json`: the same reference as an OpenAPI 3 document, for Postman, code generators and the like.

On the quick start server these are http://localhost:4111/docs and http://localhost:4111/openapi.json. They cover every `/v1` call the server answers: stores, domains, sending domains, versions, snapshots, templates, API keys, webhooks and plugin updates. The admin API is not in them.

## SDKs

Clients for the `/v1` API, tested against this API on every change:

| Language | Package | Docs |
|---|---|---|
| TypeScript and JavaScript | `npm install waas-provisioning-sdk` | [sdk/typescript](sdk/typescript/README.md) |
| PHP 8.1+ | `composer require otakusolutions/waas-provisioning-sdk` | [sdk/php](sdk/php/README.md) |

## Running it for real

[docs/self-hosting.md](docs/self-hosting.md) walks through a production setup: one server with Coolify, DNS, object storage, email, the storefront and the dashboard, then more servers. It ends with every setting the API reads.

| Guide | What it covers |
|---|---|
| [docs/self-hosting.md](docs/self-hosting.md) | Running the whole platform, from one server up |
| [docs/coolify.md](docs/coolify.md) | How stores run on Coolify |
| [docs/accounts.md](docs/accounts.md) | Letting agencies sign in to the dashboard: organizations, roles, invitations |
| [docs/clients.md](docs/clients.md) | Clients: give someone a site in one step (their own storefront, site and invitation) |
| [docs/resellers.md](docs/resellers.md) | Reseller accounts: storefronts grouped under one partner, store limits, usage, the monthly wholesale bill, partner keys, the storefronts and shared templates a partner key makes, and the reseller's team |
| [docs/webhooks.md](docs/webhooks.md) | Signed webhooks when a store or version changes, and how to check them |
| [docs/store-backups.md](docs/store-backups.md) | Nightly store backups, how long they are kept, restoring |
| [docs/db-backups.md](docs/db-backups.md) | Backups of the API's own database, and restoring them |
| [docs/store-email.md](docs/store-email.md) | Store email, a sending key per store, stores sending from their own domain |
| [docs/domain-connect.md](docs/domain-connect.md) | One-click DNS setup for customers' domains (Domain Connect) |

`GET /health` (no sign-in) answers 200 when Postgres and the job queue respond, and 503 otherwise. Point an uptime monitor at it.

## What it does

- **Stores:** create, change WordPress options and PHP constants, suspend (a 503 page), resume, back up, restore, move to a newer version, delete. A deleted store's backups are kept 90 days, so it can come back.
- **Versions and templates:** stores are copies of a version. Upload a template, build a version from it, make that version production, and new stores use it.
- **Domains:** every store gets a name under your domain (`shop.example.com`) and can add its owner's own domain. HTTPS certificates are issued automatically.
- **Backups:** every live store nightly (files and database), and the API's own database nightly, encrypted, to S3-compatible storage.
- **Email:** stores send through one SMTP relay (toSend by default), and a store can send from its owner's own domain.
- **Webhooks:** a signed request to your server when a store or version finishes a change.
- **Plugin updates:** signed updates for the storefront plugins.

## How it works

TypeScript on [Hono](https://hono.dev), with [pg-boss](https://github.com/timgit/pg-boss) as the job queue, both on one Postgres database. Each request is checked, recorded and queued. Background jobs do the work and set each record to Done or Failed.

The work on the servers stores run on goes through a `Provisioner` (`src/provisioner/provisioner.ts`). There are two:

- `coolify`: each store is a [Coolify](https://coolify.io) Service with its own WordPress, MariaDB and agent containers. Work inside a store runs as WP-CLI commands in the agent. See [docs/coolify.md](docs/coolify.md).
- `fake` (the default): in memory, and every change succeeds at once. For trying the API and for tests.

## API keys

A storefront signs in with an API key and secret. Only a scrypt hash of the secret is stored. The secret is shown in the answer that creates the key and never again, and the request log never records bodies.

The first key comes from `npm run create-key` or from the dashboard. After that, a storefront signed in with any of its keys manages its own keys ([`openapi/api-keys.yaml`](openapi/api-keys.yaml)):

| Endpoint | What it does |
|---|---|
| `GET /v1/keys` | Working keys, and those revoked in the last 30 days: `state` (`active`, `expiring`, `revoked`), `lastUsedAt`, and `isCurrent` for the key in use. Never secrets |
| `POST /v1/keys` `{"label": "…"}` | A new key with its secret. At most 20 working keys |
| `POST /v1/keys/{id}/rotate` `{"graceHours": 24}` | A new key with the same label. The old one keeps working for `graceHours` (default 24, 0 to 720), so whatever uses it can switch over |
| `DELETE /v1/keys/{id}` | Revokes a key now. The last active key can't be revoked, so a storefront can't lock itself out |

## Admin API

`/admin/*` serves the [dashboard](https://github.com/hamchowderr/waas-dashboard) and is described in [`openapi/admin/admin-api.yaml`](openapi/admin/admin-api.yaml). It sees every product and signs in with `Authorization: Bearer <ADMIN_TOKEN>`. Product keys, a missing header and a wrong token all get 403, and so does every request when `ADMIN_TOKEN` is not set. The token is compared in constant time and never logged.

| Endpoint | What it returns or does |
|---|---|
| `GET /admin/overview` | Health, store, version and backup counts by status, suspended stores, job counts (queued, running, failed), and products with their store counts |
| `GET /admin/tenants` | Stores across products. Filters: `productId`, `status`, `suspended`, `versionId`, `q` (external id, name or domain); `page`, `pageSize` (max 200) |
| `GET /admin/tenants/{id}` | One store: domains, backups, the last 20 jobs and failures. `wpOptions` and `phpConstants` by name only |
| `PUT /admin/tenants/{id}/domains/main` `{"domainName": "…"}` | Makes a domain the store's main address, adding it if new. The old main domain stays as a redirect |
| `GET`, `PUT` `{"domainName": "…"}`, `DELETE /admin/tenants/{id}/mail-domain` | The store's own sending domain, with the DNS records to add. The store sends from it once toSend verifies it. `DELETE` moves it back to the platform's address ([docs/store-email.md](docs/store-email.md)) |
| `GET /admin/tenants/{id}/domain-connect?domainName=…&service=website\|email` | A one-click link that adds the domain's DNS records at its DNS host, when the host supports Domain Connect ([docs/domain-connect.md](docs/domain-connect.md)) |
| `POST /admin/tenants/{id}/restore` `{"backupId": "…", "takeBackup": true}` | Rolls a live store back to one of its Done backups in place, keeping its domains, version, constants and suspension. It backs up what the store holds now first (reason `before-restore`) unless `takeBackup` is false |
| `GET /admin/backups` | Backups, deleted stores' included, with `expiresAt`. Filters: `productId`, `tenantId`, `externalId`, `status`, `tenantDeleted` |
| `GET /admin/db-backups` | The database backup status from `/health`, plus each attempt with its object key, size and error |
| `GET`, `POST /admin/webhooks`; `PUT`, `DELETE /admin/webhooks/{id}`; `GET /admin/webhooks/deliveries` | Every product's webhook endpoints and their deliveries. Test an endpoint, rotate its secret, or send a delivery again ([docs/webhooks.md](docs/webhooks.md)) |
| `GET /admin/requests` | The request log: every `/v1` call (failed sign-ins included) and admin change, with status, timing, store, key id and label, IP and user agent. Never bodies or secrets. Filters: product, store, source, outcome, method, path and time (`from`, `to`). Kept `REQUEST_LOG_DAYS` (30) days |
| `GET /admin/jobs?state=queued\|running\|failed` | One tab of jobs, plus counts for all three |
| `GET /admin/products` | Products (storefronts) with store and version counts, the production version, and `maxTenants` |
| `POST /admin/products` `{"name": "Acme Agency", "maxTenants": 10, "keyLabel": "…"}` | A new product and its first API key. The secret is in this answer only |
| `GET`, `POST /admin/products/{productId}/keys`; `POST …/keys/{id}/rotate`; `DELETE …/keys/{id}` | A product's API keys. Same as `/v1/keys`, except the last active key can be revoked |
| `GET`, `POST /admin/products/{productId}/storefront` `{"name": "Acme Agency", "email": "owner@acme.example", "subdomain": "acme"}` | The product's ready-made storefront: a WordPress site with WaaS Host, built from [`templates/agency-storefront`](templates/agency-storefront) and already connected with a new key of the product. One per product; needs `STOREFRONT_PRODUCT_ID`. `GET` answers `null` when there is none |
| `GET /admin/applications?status=pending\|approved\|declined`; `GET …/{id}`; `POST …/{id}/approve` `{"maxTenants": 3, "storefront": true}`; `POST …/{id}/decline` | Applications to sell, sent by the public `POST /applications` form. Approving makes the product, invites the applicant as its owner and builds their storefront if they asked ([docs/accounts.md](docs/accounts.md#applications-to-sell)) |
| `GET`, `POST /admin/clients` `{"name": "Example Bakery", "email": "owner@bakery.example", "size": "small"}` | Clients set up in one step: their own storefront started from the shop's template, their site once it has built, and an emailed invitation ([docs/clients.md](docs/clients.md)) |
| `GET`, `POST /admin/resellers` `{"name": "Acme Partners", "productIds": ["…"]}`; `GET`, `PUT`, `DELETE …/{id}`; `PUT`, `DELETE …/{id}/products/{productId}`; `GET …/{id}/usage?from=…&to=…`; `GET …/{id}/bill?month=YYYY-MM`; `GET`, `POST …/{id}/keys`, `POST …/{id}/keys/{keyId}/rotate`, `DELETE …/{id}/keys/{keyId}`; `GET`, `PUT …/{id}/organization`, `POST …/{id}/invitations`, `DELETE …/{id}/invitations/{invitationId}`, `PATCH`, `DELETE …/{id}/members/{memberId}` | Reseller accounts: storefronts grouped under one partner, with limits across them, store-days per size, the monthly wholesale bill, partner keys and the reseller's team, who sign in and reach all its storefronts ([docs/resellers.md](docs/resellers.md)) |
| `PUT /admin/products/{productId}` `{"maxTenants": 5}` | The most stores the product may have (`null`: no limit). At the limit, creating or restoring a store answers 400. Lowering it deletes nothing |
| `GET`, `POST /admin/products/{productId}/versions`; `DELETE …/versions/{id}`; `PUT …/versions/{id}/production` | A product's versions. Same requests, rules and answers as the `/v1/versions` calls |
| `GET`, `POST`, `DELETE /admin/products/{productId}/basesnapshots` | A product's templates. Same as `/v1/basesnapshots`; `DELETE` takes `?id=` |
| `POST /admin/jobs/failures/{id}/retry` | Queues a failed job again and puts its record back to Pending (Removing for a delete). Only while the record is still Failed. Safe to repeat |

A job that fails its last retry is recorded in `job_failures` (type, store or version, error, attempts) before the worker completes it. Job data is never returned, because it can hold encrypted secrets.

## Plugin updates

The WordPress plugins in [waas-plugins](https://github.com/hamchowderr/waas-plugins) get their updates from this API, never from GitHub or wordpress.org. [`openapi/plugin-updates.yaml`](openapi/plugin-updates.yaml) describes it.

- `GET /v1/plugins/{slug}/update?version=&channel=stable|beta&site=&wp=&php=` signs in with the storefront's own API key, like any `/v1` call. `slug` is one of `wpcs-waas-host`, `wpcs-waas-client` or `waas-payments` (the plugins' folder names). It answers the release the channel points at, or the product's pinned release, with `sha256`, the ed25519 `signature`, and a `package` URL that works for 10 minutes. It answers 404 when nothing is released on the channel, and 503 when updates aren't set up or the bucket can't be read.
- Every check records the slug, site, version, channel, WordPress version and PHP version in `plugin_installs` (also on 404 and 503).
- The API only reads the releases bucket and never signs. The waas-plugins release workflow uploads `releases/<slug>/<version>/<slug>.zip`, its `manifest.json`, and `releases/<slug>/channels/<channel>.json` (a copy of the manifest the channel points at). The plugin checks the sha256 and the signature of `waas-release-v1\n<slug>\n<version>\n<sha256>` against public keys built into it, so a wrong manifest here can't make a site install something the key didn't sign. If you run your own API, the plugins need your own release key: see [Plugin updates](docs/self-hosting.md#plugin-updates) in the self-hosting guide.
- Stores don't update themselves. WaaS Client comes with the version, and a store moves to a newer version through `POST /v1/tenants/version`.

| Admin endpoint | What it does |
|---|---|
| `GET /admin/plugins` | Installs (each site's last reported version) and pins. Filters: `productId`, `slug` |
| `PUT /admin/products/{productId}/plugins/{slug}/pin` `{"version": "2.3.0"}` | Holds that product's sites at a release that exists in the bucket. It never downgrades a site |
| `DELETE /admin/products/{productId}/plugins/{slug}/pin` | Back to the channel |

Settings: `RELEASES_S3_BUCKET` turns it on. `RELEASES_S3_ENDPOINT`, `RELEASES_S3_ACCESS_KEY_ID`, `RELEASES_S3_SECRET_ACCESS_KEY` and `RELEASES_S3_REGION` default to the `S3_*` values. The key needs read access to the releases bucket only. Manifests are cached in memory for a minute.

## Store templates

`templates/` holds the build scripts for the templates new stores start from. [`templates/starter-fluentcart`](templates/starter-fluentcart/README.md) is the starter store: WordPress, WaaS Client, FluentCart and Twenty Twenty-Five. `build.sh` makes the archive, and `publish.sh` uploads it through the API and creates a version from it.

## OpenAPI files

`openapi/waas-provisioning-api.yaml` describes the store, domain, version and snapshot calls. The admin, plugin update, store mail, API key and webhook calls each have their own file under `openapi/`. The reference at `/docs` and the TypeScript SDK's types are built from these files. For contributors, [docs/contract.md](docs/contract.md) explains how they are organised and what the WordPress plugins rely on.

## MCP server

[`mcp/`](mcp) lets an AI agent (Claude, ChatGPT or any MCP client) create and manage stores, and edit a store's pages, sections, styles, header, footer and menus ([docs/site-editing.md](docs/site-editing.md)). The API serves it at `/mcp`, with OAuth sign-in for Claude and ChatGPT connectors, or Basic auth with your API key. It also runs locally over stdio, and comes with store screens (MCP Apps) and an Agent Skill it serves over MCP too (Skills extension). Its twenty tools are grouped by area, most with an `action`. See [mcp/README.md](mcp/README.md).

## Development

```sh
npm run typecheck
npm run sdk:check
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/waas_test npm test
```

The tests wipe and migrate the database in `TEST_DATABASE_URL` (default shown above), so point it at a throwaway database. `test/contract.test.ts` calls every implemented store, domain, version and snapshot operation and checks each answer against the OpenAPI schemas. `npm run sdk:check` fails when the TypeScript SDK's generated types are out of date; `npm run sdk:generate` rebuilds them.

To lint the main OpenAPI file:

```sh
npx @redocly/cli lint openapi/waas-provisioning-api.yaml
```

Expect it to pass with two warnings: a localhost server entry, and one unused schema kept for older clients.

Releasing the SDKs is covered in [docs/publishing.md](docs/publishing.md).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

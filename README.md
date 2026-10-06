# WaaS Provisioning API

Provisioning API for the WaaS platform. It replaces the shut-down WPCS cloud and keeps the WPCS v1 contract (same paths, parameters and field names), so the WaaS Host and Client plugins in [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) keep working.

Contract first: the OpenAPI spec is the source of truth. The API itself (a Mastra service) is not built yet.

## Work tracking (beads)

Work is tracked in [beads](https://github.com/steveyegge/beads) (prefix `waas-api`). The issue database syncs through a private DoltHub database, [`chowderr/waas_api`](https://www.dolthub.com/repositories/chowderr/waas_api): `bd dolt push` after changes, `bd dolt pull` to get others'. `.beads/issues.jsonl` is a local export (kept fresh by `export.auto`) and is not committed. On a fresh clone, with DoltHub credentials in `~/.dolt/creds`: `bd init --prefix waas-api --skip-agents --skip-hooks --remote chowderr/waas_api`, then `bd dolt pull`.

The plugin fork is tracked separately in [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) (prefix `waas`).

## Contract

| File | What it is |
|---|---|
| `openapi/waas-provisioning-api.yaml` | **The contract.** Version 1.0.0-draft.2. Edit this. |
| `openapi/reference/wpcs-v1-corrected.json` | The original WPCS v1 spec, recovered from the archived docs.wpcs.io bundle (Wayback capture 2024-09-08) with 27 corrections. Reference only. |

### Phases

- **Phase 1 (17 operations):** tenants, tenant domains, versions, snapshots. Everything the storefront plugin calls.
- **Phase 2 (11 operations):** the reseller feature. Subscriptions, products, base snapshots (templates) and usage, used with reseller (partner) keys. Phase 1 calls then take `productId`.

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

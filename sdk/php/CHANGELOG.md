# Changelog

All notable changes to `otakusolutions/waas-provisioning-sdk` are listed here. Versions follow [Semantic Versioning](https://semver.org). Until 1.0.0, a minor version (0.x.0) may change the API.

## Unreleased

- `addTenantEmailPack()`: emails on top of a store's monthly plan (`POST /v1/tenants/email-packs`).
- `goLiveTenant()`: makes a site moved in live (`POST /v1/tenants/go-live`); tenants have `onHold`.
- `getTenantImport()`: how a move in went, with `siteReport`, what's on the moved site (`GET /v1/tenants/import`).

## 0.1.0

First published release.

- `Client` with methods for stores (tenants), domains, sending domains, versions, snapshots, templates and webhooks, plus `domainConnect()` and `waitForTenant()`.
- `WaasApiException` for any non-2xx answer, `TenantFailedException` when a store fails while you wait for it.
- `Webhook::verify()` to check signed webhook requests.
- `CurlTransport` (default) and `WordPressTransport`, or your own `Http\Transport`.
- Needs PHP 8.1 or newer.

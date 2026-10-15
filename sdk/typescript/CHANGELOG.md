# Changelog

All notable changes to `waas-provisioning-sdk` are listed here. Versions follow [Semantic Versioning](https://semver.org). Until 1.0.0, a minor version (0.x.0) may change the API.

## 0.1.0

First published release.

- `WaasClient` with `tenants`, `domains`, `mailDomain`, `versions`, `snapshots`, `templates` and `webhooks`, plus `domainConnect()` and `waitForTenant()`.
- `WaasApiError` for any non-2xx answer, `TenantFailedError` when a store fails while you wait for it.
- `verifyWebhook()` to check signed webhook requests.
- Request and response types generated from the API's OpenAPI files.
- Needs Node 20 or newer (or Deno, Bun, or an edge runtime with `fetch` and Web Crypto).

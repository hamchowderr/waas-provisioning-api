# waas-provisioning-sdk

A typed TypeScript client for the WaaS provisioning API: tenants (stores), their domains, backups and lifecycle, versions, snapshots, templates, store sending domains and Domain Connect links. Request and response types are generated from the API's OpenAPI contract in [`openapi/`](../../openapi), so they always match the server in this repo.

Runs anywhere with `fetch`: Node 18+, Deno, Bun and edge runtimes. No runtime dependencies.

> Your API secret has full control of your stores. Use this client on a server, never in a browser.

## Install

```sh
npm install waas-provisioning-sdk
```

## Use

```ts
import { WaasClient, WaasApiError } from 'waas-provisioning-sdk';

const waas = new WaasClient({
  baseUrl: 'https://api.example.com',
  apiKey: process.env.WAAS_API_KEY!,
  apiSecret: process.env.WAAS_API_SECRET!,
});

// Writes return as soon as the work is scheduled. waitForTenant polls until the store is ready.
await waas.tenants.create({ name: 'Acme', externalId: 'order-1042', customDomainName: 'shop.acme.com' });
const store = await waas.waitForTenant({ externalId: 'order-1042' });
console.log(store.domainName);

try {
  await waas.tenants.suspend({ externalId: 'order-1042' });
} catch (error) {
  if (error instanceof WaasApiError) console.error(error.status, error.apiMessage);
}
```

Every tenant call takes a `TenantRef`: `{ externalId }` (your own id, such as an order or subscription id) or `{ tenantId }`.

| Area | Methods |
|---|---|
| `tenants` | `list`, `get`, `create`, `update`, `delete`, `moveToVersion`, `suspend`, `resume`, `restore`, `listBackups`, `createBackup` |
| `domains` | `list`, `add`, `remove`, `setMain`, `checkAvailability` |
| `mailDomain` | `get`, `set`, `remove` |
| `versions` | `list`, `create`, `delete`, `setProduction` |
| `snapshots` | `list`, `download` |
| `templates` | `list`, `create`, `delete` |
| client | `domainConnect(ref, domainName, 'website' \| 'email')`, `waitForTenant(ref, { intervalMs, timeoutMs, signal })` |

The generated `components`, `operations` and `paths` types are exported too, for anything the client doesn't wrap.

## Develop

From the repository root:

- `npm run sdk:generate` regenerates `src/generated/` after a change to `openapi/*.yaml`.
- `npm run sdk:check` fails when the generated types are out of date (CI runs it).
- `test/sdk.test.ts` runs the client against the API itself.

Build the package with `npm run build` in this folder.

## License

GPL-3.0-or-later

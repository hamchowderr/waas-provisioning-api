# waas-provisioning-sdk

A typed TypeScript client for the [WaaS Provisioning API](https://github.com/hamchowderr/waas-provisioning-api), the API that creates and runs WordPress stores. Use it from your own server code to create stores, manage their domains and backups, and receive webhooks.

- Works anywhere with `fetch` and Web Crypto: Node 20+, Deno, Bun and edge runtimes.
- No runtime dependencies. ES module only.
- Request and response types are generated from the API's OpenAPI files, so they match the server.

> Your API secret has full control of your stores. Use this client on a server, never in a browser.

## Install

```sh
npm install waas-provisioning-sdk
```

## Quick start

You need three things from whoever runs the API (or from your own server, if you host it):

- the API's address, such as `https://api.example.com`
- an API key and its secret
- a production version on your storefront, so new stores have something to be copied from ([how](https://github.com/hamchowderr/waas-provisioning-api/blob/main/README.md#quick-start))

Save this as `quickstart.mjs`:

```js
import { WaasClient, WaasApiError, TenantFailedError } from 'waas-provisioning-sdk';

const waas = new WaasClient({
  baseUrl: process.env.WAAS_API_URL, // e.g. https://api.example.com (no /v1)
  apiKey: process.env.WAAS_API_KEY,
  apiSecret: process.env.WAAS_API_SECRET,
});

try {
  // Ask for a new store. The call returns once the work is queued.
  await waas.tenants.create({ name: 'Acme Shop', externalId: 'order-1042' });

  // Poll until the store is ready (or failed).
  const store = await waas.waitForTenant({ externalId: 'order-1042' });
  console.log(`Ready at https://${store.domainName}`);
} catch (error) {
  if (error instanceof WaasApiError) {
    // The API said no. 403 means a wrong key or secret; 400 means bad input.
    console.error(`HTTP ${error.status}: ${error.apiMessage}`);
  } else if (error instanceof TenantFailedError) {
    console.error(`Store ${error.tenant.externalId} failed to build`);
  } else {
    throw error;
  }
}
```

Run it:

```sh
WAAS_API_URL=https://api.example.com WAAS_API_KEY=<key> WAAS_API_SECRET=<secret> node quickstart.mjs
```

Running it again is safe: a second create with the same `externalId` answers with the store already made.

## Words used here

- A **store** is one customer's WordPress website. The API calls it a **tenant**, so the methods are `tenants.*`.
- Your **storefront** is the shop that sells stores. The API calls it a **product**. Your API key belongs to one product and only sees its stores.
- The **API key** (a UUID, also called the key id) and its **secret** are the Basic auth username and password.
- Every change runs in the background. A store's `statusCode` is `0` Pending, `1` Done, `2` Failed or `3` Removing (the `StatusCode` constant).

The full list is in the [main README](https://github.com/hamchowderr/waas-provisioning-api/blob/main/README.md#words-used-in-these-docs).

## Reference

### The client

```ts
const waas = new WaasClient({ baseUrl, apiKey, apiSecret, fetch });
```

| Option | |
|---|---|
| `baseUrl` | The API's address, without `/v1`. A trailing slash is fine |
| `apiKey`, `apiSecret` | Your API key and secret |
| `fetch` | Optional. A `fetch` to use instead of the global one, for proxies or tests |

### Picking a store

Every store method takes a `TenantRef` first: `{ externalId: 'order-1042' }` (your own id, such as an order or subscription id) or `{ tenantId: '<uuid>' }` (the API's id).

### Methods

Each method returns the API's JSON answer, typed. Writes return as soon as the work is queued; call `waitForTenant` or use webhooks to know when it is done.

| Group | Method | What it does |
|---|---|---|
| `tenants` | `list(ref?)` | Your stores, or just the one `ref` picks (an empty list when there is none) |
| | `get(ref)` | One store, or `null` |
| | `create(params)` | Queues a new store. `name` is required; also `externalId`, `customDomainName`, `groupName`, `versionId`, `wordPressUserName`, `wordPressUserEmail`, `wordPressUserRole`, `wordPressUserPassword`, `wpOptions`, `phpConstants` |
| | `update(ref, { wpOptions, phpConstants })` | Sets WordPress options and PHP constants |
| | `delete(ref)` | Queues the deletion. Backups are kept, so `restore` can bring it back |
| | `moveToVersion(ref, versionId)` | Moves the store to another version |
| | `suspend(ref, { takeBackup })` | Takes the store offline (a 503 page). Backs it up first unless `takeBackup` is `false` |
| | `resume(ref)` | Brings a suspended store back |
| | `addEmailPack(ref, { emails, reference })` | Adds emails on top of the store's monthly plan (they never expire). A repeat with the same `reference` adds nothing. Answers with the total bought |
| | `restore(ref, { backupId })` | Brings back a deleted store, or rolls a live one back, from a backup (the newest finished one when `backupId` is left out) |
| | `listBackups(ref)`, `createBackup(ref)` | The store's backups; take one now |
| `domains` | `list(ref)` | The store's domains |
| | `add(ref, { domainName, setAsMainDomain })` | Adds a domain, and makes it the main one if asked |
| | `remove(ref, { domainName } \| { domainId })` | Removes a domain |
| | `setMain(ref, { domainName })` | Makes a domain the store's main address |
| | `checkAvailability(domain)` | Whether a domain is free to use |
| `mailDomain` | `get(ref)`, `set(ref, domainName)`, `remove(ref)` | The store's own sending domain for email, with the DNS records to add. `get` returns `null` when the store sends from the platform's address |
| `versions` | `list({ versionId, versionName })`, `create(params)`, `delete(versionId)`, `setProduction(versionId)` | Versions of your storefront. New stores use the production version unless they name another |
| `snapshots` | `list(query)`, `download(snapshotId)` | Snapshots, and one snapshot's zip as a `Blob` |
| `templates` | `list(query)`, `create(params)`, `delete(id)` | Templates (base snapshots). `create` answers with a URL to upload the zip to |
| `webhooks` | `list()`, `create(params)`, `get(id)`, `update(id, params)`, `delete(id)` | Your webhook endpoints. `create` answers with the `secret`, shown only once |
| | `rotateSecret(id)`, `test(id)` | A new secret (the old one stops at once); send a `webhook.test` event |
| | `deliveries(id, query)`, `retryDelivery(deliveryId)` | Deliveries to an endpoint; send one again |
| client | `domainConnect(ref, domainName, 'website' \| 'email')` | A one-click link that adds the store's DNS records at the domain's DNS host, when the host supports [Domain Connect](https://github.com/hamchowderr/waas-provisioning-api/blob/main/docs/domain-connect.md) |
| | `waitForTenant(ref, { intervalMs, timeoutMs, signal })` | Polls until the store is Done (returns it) or Failed (throws `TenantFailedError`). Defaults: every 5 seconds, for up to 15 minutes |

The full list of fields for each call is in the API reference your server publishes at `/docs` (and as OpenAPI at `/openapi.json`).

### Errors

| Error | When | Useful fields |
|---|---|---|
| `WaasApiError` | The API answered with a non-2xx status | `status`, `apiMessage` (the API's explanation, or `null`), `operationId` |
| `TenantFailedError` | `waitForTenant` saw the store reach Failed | `tenant` |
| `WebhookVerificationError` | `verifyWebhook` rejected a request | `message` |

`waitForTenant` throws a plain `Error` when it times out, and the signal's reason when you abort it. Common statuses: 400 bad input (the message says what), 403 wrong key or secret, 404 not found.

### Webhooks

Register an endpoint once and keep its secret. Then check each request with `verifyWebhook`, passing the raw body exactly as received. [docs/webhooks.md](https://github.com/hamchowderr/waas-provisioning-api/blob/main/docs/webhooks.md) lists the events.

```ts
import { verifyWebhook, WebhookVerificationError } from 'waas-provisioning-sdk';

const { secret } = await waas.webhooks.create({
  url: 'https://example.com/waas-hooks',
  eventTypes: ['tenant.ready', 'tenant.failed'],
});

// In your handler (here a fetch-style Request):
try {
  const event = await verifyWebhook(secret, request.headers, await request.text());
  if (event.type === 'tenant.ready') console.log(event.data.tenant?.domainName);
} catch (error) {
  if (error instanceof WebhookVerificationError) return new Response('Bad signature', { status: 400 });
  throw error;
}
```

`headers` can be a `Headers` object or a plain object such as Node's `req.headers`. Requests older than 5 minutes are rejected; pass `{ toleranceSeconds }` to change that.

### Types

The package exports types for the main objects (`Tenant`, `TenantBackup`, `TenantDomain`, `Version`, `Snapshot`, `Template`, `MailDomain`, `DomainConnectLink`, `WebhookEndpoint`, `WebhookDelivery`, `WebhookEvent` and more), and the generated `components`, `operations` and `paths` types for anything the client doesn't wrap.

## Developing this package

From the repository root:

- `npm run sdk:generate` rebuilds `src/generated/` after a change to `openapi/*.yaml`.
- `npm run sdk:check` fails when the generated types are out of date. CI runs it.
- `test/sdk.test.ts` runs the client against the API itself.

`npm run build` in this folder builds `dist/`. Releases: [docs/publishing.md](https://github.com/hamchowderr/waas-provisioning-api/blob/main/docs/publishing.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

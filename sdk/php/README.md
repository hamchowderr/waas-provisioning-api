# WaaS Provisioning SDK for PHP

A PHP client for the [WaaS Provisioning API](https://github.com/hamchowderr/waas-provisioning-api), the API that creates and runs WordPress stores. Use it from your own PHP code, or from a WordPress plugin, to create stores, manage their domains and backups, and check webhooks.

- PHP 8.1 or newer, with no other packages needed.
- Sends requests with curl by default, or with `wp_remote_request` inside WordPress.
- Results are the API's JSON as associative arrays, with the field names from the API reference.

> Your API secret has full control of your stores. Keep it on the server.

## Install

```sh
composer require otakusolutions/waas-provisioning-sdk
```

## Quick start

You need three things from whoever runs the API (or from your own server, if you host it):

- the API's address, such as `https://api.example.com`
- an API key and its secret
- a production version on your storefront, so new stores have something to be copied from ([how](https://github.com/hamchowderr/waas-provisioning-api/blob/main/README.md#quick-start))

Save this as `quickstart.php` next to your `vendor/` folder:

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use Waas\Provisioning\Client;
use Waas\Provisioning\TenantFailedException;
use Waas\Provisioning\WaasApiException;

$waas = new Client(
    getenv('WAAS_API_URL'), // e.g. https://api.example.com (no /v1)
    getenv('WAAS_API_KEY'),
    getenv('WAAS_API_SECRET'),
);

try {
    // Ask for a new store. The call returns once the work is queued.
    $waas->createTenant(['name' => 'Acme Shop', 'externalId' => 'order-1042']);

    // Poll until the store is ready (or failed).
    $store = $waas->waitForTenant(['externalId' => 'order-1042']);
    echo "Ready at https://{$store['domainName']}\n";
} catch (WaasApiException $e) {
    // The API said no. 403 means a wrong key or secret; 400 means bad input.
    error_log("HTTP {$e->getStatus()}: {$e->getApiMessage()}");
} catch (TenantFailedException $e) {
    error_log("Store {$e->getTenant()['externalId']} failed to build");
}
```

Run it:

```sh
WAAS_API_URL=https://api.example.com WAAS_API_KEY=<key> WAAS_API_SECRET=<secret> php quickstart.php
```

Running it again is safe: a second create with the same `externalId` answers with the store already made.

## Words used here

- A **store** is one customer's WordPress website. The API calls it a **tenant**, so the methods are `createTenant`, `getTenant` and so on.
- Your **storefront** is the shop that sells stores. The API calls it a **product**. Your API key belongs to one product and only sees its stores.
- The **API key** (a UUID, also called the key id) and its **secret** are the Basic auth username and password.
- Every change runs in the background. A store's `statusCode` is `0` Pending, `1` Done, `2` Failed or `3` Removing (the `StatusCode` constants).

The full list is in the [main README](https://github.com/hamchowderr/waas-provisioning-api/blob/main/README.md#words-used-in-these-docs).

## Reference

### The client

```php
$waas = new Client($baseUrl, $apiKey, $apiSecret, $transport = null);
```

`$baseUrl` is the API's address, without `/v1`. `$transport` is optional; the default is `Http\CurlTransport`.

Inside WordPress, pass the WordPress transport so its proxy settings and HTTP filters apply:

```php
$waas = new Client($url, $key, $secret, new \Waas\Provisioning\Http\WordPressTransport());
```

Both transports take an optional timeout in seconds (default 30). Any other HTTP client works through the one-method `Http\Transport` interface: `send(string $method, string $url, array $headers, ?string $body): array` returning `['status' => int, 'body' => string]`.

### Picking a store

Every store method takes a tenant ref first: `['externalId' => 'order-1042']` (your own id, such as an order or subscription id) or `['tenantId' => '<uuid>']` (the API's id). Anything else throws `InvalidArgumentException`.

### Methods

Writes return as soon as the work is queued; call `waitForTenant` or use webhooks to know when it is done.

| Area | Method | What it does |
|---|---|---|
| Stores | `listTenants(?array $ref = null)` | Your stores, or just the one `$ref` picks (an empty list when there is none) |
| | `getTenant(array $ref)` | One store, or `null` |
| | `createTenant(array $params)` | Queues a new store. `name` is required; also `externalId`, `customDomainName`, `groupName`, `versionId`, `wordPressUserName`, `wordPressUserEmail`, `wordPressUserRole`, `wordPressUserPassword`, `wpOptions`, `phpConstants` |
| | `updateTenant(array $ref, array $params)` | Sets `wpOptions` and `phpConstants` |
| | `deleteTenant(array $ref)` | Queues the deletion. Backups are kept, so `restoreTenant` can bring it back |
| | `moveTenantToVersion(array $ref, string $targetVersionId)` | Moves the store to another version |
| | `suspendTenant(array $ref, bool $takeBackup = true)` | Takes the store offline (a 503 page), backing it up first unless `$takeBackup` is false |
| | `resumeTenant(array $ref)` | Brings a suspended store back |
| | `restoreTenant(array $ref, ?string $backupId = null)` | Brings back a deleted store, or rolls a live one back, from a backup (the newest finished one when `$backupId` is null) |
| | `listTenantBackups(array $ref)`, `createTenantBackup(array $ref)` | The store's backups; take one now |
| | `waitForTenant(array $ref, int $intervalMs = 5000, int $timeoutMs = 900000)` | Polls until the store is Done (returns it) or Failed (throws `TenantFailedException`). Throws `RuntimeException` on timeout |
| Domains | `listDomains(array $ref)` | The store's domains |
| | `addDomain(array $ref, string $domainName, bool $setAsMainDomain = false)` | Adds a domain, and makes it the main one if asked |
| | `removeDomain(array $ref, string $domainName)` | Removes a domain |
| | `setMainDomain(array $ref, string $domainName)` | Makes a domain the store's main address |
| | `checkDomainAvailability(string $domain)` | Whether a domain is free to use |
| | `domainConnect(array $ref, string $domainName, string $service)` | A one-click link that adds the store's DNS records (`$service` is `'website'` or `'email'`), when the DNS host supports [Domain Connect](https://github.com/hamchowderr/waas-provisioning-api/blob/main/docs/domain-connect.md) |
| Sending domain | `getMailDomain(array $ref)`, `setMailDomain(array $ref, string $domainName)`, `removeMailDomain(array $ref)` | The store's own sending domain for email, with the DNS records to add. `getMailDomain` returns `null` when the store sends from the platform's address |
| Versions | `listVersions(array $query = [])`, `createVersion(array $params)`, `deleteVersion(string $versionId)`, `setProductionVersion(string $versionId)` | Versions of your storefront. New stores use the production version unless they name another |
| Snapshots | `listSnapshots(array $query = [])`, `downloadSnapshot(string $snapshotId)` | Snapshots, and one snapshot's zip as a string of bytes |
| Templates | `listTemplates(array $query = [])`, `createTemplate(array $params)`, `deleteTemplate(string $id)` | Templates (base snapshots). `createTemplate` answers with a URL to upload the zip to |
| Webhooks | `listWebhooks()`, `createWebhook(array $params)`, `getWebhook(string $id)`, `updateWebhook(string $id, array $params)`, `deleteWebhook(string $id)` | Your webhook endpoints. `createWebhook` answers with the `secret`, shown only once |
| | `rotateWebhookSecret(string $id)`, `testWebhook(string $id)` | A new secret (the old one stops at once); send a `webhook.test` event |
| | `listWebhookDeliveries(string $id, array $query = [])`, `retryWebhookDelivery(string $deliveryId)` | Deliveries to an endpoint; send one again |

The full list of fields for each call is in the API reference your server publishes at `/docs` (and as OpenAPI at `/openapi.json`).

### Errors

| Exception | When | Methods |
|---|---|---|
| `WaasApiException` | The API answered with a non-2xx status | `getStatus()`, `getApiMessage()` (the API's explanation, or `null`), `getOperation()` |
| `TenantFailedException` | `waitForTenant` saw the store reach Failed | `getTenant()` |
| `WebhookVerificationException` | `Webhook::verify` rejected a request | `getMessage()` |

All of them extend `RuntimeException`. Common statuses: 400 bad input (the message says what), 403 wrong key or secret, 404 not found.

### Webhooks

Register an endpoint once and keep its secret:

```php
$endpoint = $waas->createWebhook([
    'url' => 'https://example.com/waas-hooks',
    'eventTypes' => ['tenant.ready', 'tenant.failed'],
]);
$secret = $endpoint['secret']; // shown only this once
```

Then check each request with `Webhook::verify`, passing the secret, the headers and the raw body exactly as received. [docs/webhooks.md](https://github.com/hamchowderr/waas-provisioning-api/blob/main/docs/webhooks.md) lists the events.

```php
use Waas\Provisioning\Webhook;
use Waas\Provisioning\WebhookVerificationException;

try {
    $event = Webhook::verify($secret, getallheaders(), file_get_contents('php://input'));
} catch (WebhookVerificationException $e) {
    http_response_code(400);
    exit;
}
if ($event['type'] === 'tenant.ready') {
    $domain = $event['data']['tenant']['domainName'];
}
```

Header names can be in any case. Requests older than 5 minutes are rejected; the fourth argument changes that (in seconds).

## Developing this package

This package lives in `sdk/php` of the [waas-provisioning-api](https://github.com/hamchowderr/waas-provisioning-api) repository; send issues and pull requests there. `test/sdk-php.test.ts` starts the API and runs `tests/live.php` against it, so the API's test suite fails when the client and the API disagree. Changes: [CHANGELOG.md](CHANGELOG.md).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

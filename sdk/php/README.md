# waas-provisioning-sdk (PHP)

A PHP client for the WaaS provisioning API: tenants (stores), their domains, backups and lifecycle, versions, snapshots, templates, store sending domains and Domain Connect links. Field names follow the API's OpenAPI contract in [`openapi/`](../../openapi); results are the API's JSON as associative arrays.

PHP 8.1+, no dependencies. It sends requests with curl by default, or with `wp_remote_request` inside WordPress.

> Your API secret has full control of your stores. Keep it on the server.

## Install

Not on Packagist yet. Until then, point Composer at this folder:

```json
{
  "repositories": [{ "type": "path", "url": "path/to/waas-provisioning-api/sdk/php" }],
  "require": { "otakusolutions/waas-provisioning-sdk": "*" }
}
```

## Use

```php
use Waas\Provisioning\Client;
use Waas\Provisioning\WaasApiException;

$waas = new Client('https://api.example.com', getenv('WAAS_API_KEY'), getenv('WAAS_API_SECRET'));

// Writes return as soon as the work is scheduled. waitForTenant polls until the store is ready.
$waas->createTenant(['name' => 'Acme', 'externalId' => 'order-1042', 'customDomainName' => 'shop.acme.com']);
$store = $waas->waitForTenant(['externalId' => 'order-1042']);
echo $store['domainName'];

try {
    $waas->suspendTenant(['externalId' => 'order-1042']);
} catch (WaasApiException $e) {
    error_log($e->getStatus() . ' ' . $e->getApiMessage());
}
```

Inside WordPress, pass the WordPress transport so proxy settings and HTTP filters apply:

```php
$waas = new Client($url, $key, $secret, new \Waas\Provisioning\Http\WordPressTransport());
```

Any other HTTP client works through the one-method `Http\Transport` interface.

Every tenant call takes a tenant ref: `['externalId' => ...]` (your own id, such as an order or subscription id) or `['tenantId' => ...]`.

| Area | Methods |
|---|---|
| Tenants | `listTenants`, `getTenant`, `createTenant`, `updateTenant`, `deleteTenant`, `moveTenantToVersion`, `suspendTenant`, `resumeTenant`, `restoreTenant`, `listTenantBackups`, `createTenantBackup`, `waitForTenant` |
| Domains | `listDomains`, `addDomain`, `removeDomain`, `setMainDomain`, `checkDomainAvailability`, `domainConnect` |
| Sending domain | `getMailDomain`, `setMailDomain`, `removeMailDomain` |
| Versions | `listVersions`, `createVersion`, `deleteVersion`, `setProductionVersion` |
| Snapshots and templates | `listSnapshots`, `downloadSnapshot`, `listTemplates`, `createTemplate`, `deleteTemplate` |

## Develop

`test/sdk-php.test.ts` in the repository root starts the API and runs [`tests/live.php`](tests/live.php) against it, so `npm test` fails when the client and the API disagree.

## License

GPL-3.0-or-later

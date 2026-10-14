<?php

// Drives the PHP client against a running API: php tests/live.php <baseUrl> <apiKey> <apiSecret>.
// test/sdk-php.test.ts starts the app and runs this, so a route change the client doesn't follow fails CI.

declare(strict_types=1);

spl_autoload_register(static function (string $class): void {
    $prefix = 'Waas\\Provisioning\\';
    if (str_starts_with($class, $prefix)) {
        require __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    }
});

use Waas\Provisioning\Client;
use Waas\Provisioning\StatusCode;
use Waas\Provisioning\WaasApiException;

[, $baseUrl, $apiKey, $apiSecret] = $argv;
$client = new Client($baseUrl . '/', $apiKey, $apiSecret);

function check(bool $ok, string $what): void
{
    if (!$ok) {
        fwrite(STDERR, "FAILED: $what\n");
        exit(1);
    }
    echo "ok - $what\n";
}

$ref = ['externalId' => 'php-1'];
$created = $client->createTenant(['name' => 'PHP store', 'externalId' => 'php-1']);
check($created['externalId'] === 'php-1', 'createTenant answers with the externalId');

$tenant = $client->waitForTenant($ref, 100, 15000);
check($tenant['statusCode'] === StatusCode::DONE && $tenant['domainName'] === $created['baseDomain'], 'waitForTenant returns the Done tenant');
check($client->getTenant(['tenantId' => $tenant['id']])['externalId'] === 'php-1', 'getTenant by tenantId');
check($client->getTenant(['externalId' => 'no-such-store']) === null, 'getTenant is null for an unknown store');

check($client->checkDomainAvailability('shop.php-example.com')['available'] === true, 'checkDomainAvailability');
$client->addDomain($ref, 'shop.php-example.com');
check(in_array('shop.php-example.com', array_column($client->listDomains($ref), 'domainName'), true), 'addDomain then listDomains');
$client->waitForTenant($ref, 100, 15000);
$client->removeDomain($ref, 'shop.php-example.com');
$client->waitForTenant($ref, 100, 15000);

check($client->suspendTenant($ref, false)['backupId'] === null, 'suspendTenant without a backup');
$backup = $client->createTenantBackup($ref);
check(in_array($backup['backupId'], array_column($client->listTenantBackups($ref), 'id'), true), 'createTenantBackup then listTenantBackups');
check($client->resumeTenant($ref)['externalId'] === 'php-1', 'resumeTenant');
check($client->getMailDomain($ref) === null, 'getMailDomain is null without a sending domain');
check(count($client->listVersions()) > 0 && is_array($client->listSnapshots(['onlyProductionVersion' => true])), 'listVersions and listSnapshots');

try {
    $client->createTenant(['name' => 'bad', 'externalId' => 'has space']);
    check(false, 'a bad externalId throws');
} catch (WaasApiException $e) {
    check($e->getStatus() === 400 && $e->getOperation() === 'createTenant' && $e->getApiMessage() !== null, 'WaasApiException carries the status and the API message');
}
try {
    (new Client($baseUrl, $apiKey, 'wrong'))->listVersions();
    check(false, 'a wrong secret throws');
} catch (WaasApiException $e) {
    check($e->getStatus() === 403 && $e->getApiMessage() === 'Invalid API key or secret', 'a wrong secret gets 403');
}

$client->waitForTenant($ref, 100, 15000);
$client->deleteTenant($ref);
echo "ok - deleteTenant\n";

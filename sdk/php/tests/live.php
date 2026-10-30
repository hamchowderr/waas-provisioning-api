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
use Waas\Provisioning\Webhook;
use Waas\Provisioning\WebhookVerificationException;

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
$created = $client->createTenant(['name' => 'PHP store', 'externalId' => 'php-1', 'wordPressUserName' => 'owner', 'wordPressUserEmail' => 'owner@example.com']);
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
    $client->createTenant(['name' => 'bad', 'externalId' => 'has space', 'wordPressUserName' => 'owner', 'wordPressUserEmail' => 'owner@example.com']);
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

$hook = $client->createWebhook(['url' => 'https://hooks.php-example.com/waas', 'eventTypes' => ['tenant.deleted']]);
check(str_starts_with($hook['secret'], 'whsec_'), 'createWebhook returns the secret');
check(in_array($hook['id'], array_column($client->listWebhooks(), 'id'), true), 'listWebhooks');
check($client->updateWebhook($hook['id'], ['enabled' => false])['enabled'] === false, 'updateWebhook');
check($client->rotateWebhookSecret($hook['id'])['secret'] !== $hook['secret'], 'rotateWebhookSecret');
$delivery = $client->testWebhook($hook['id']);
check($delivery['eventType'] === 'webhook.test', 'testWebhook');
check(in_array($delivery['id'], array_column($client->listWebhookDeliveries($hook['id'])['items'], 'id'), true), 'listWebhookDeliveries');
check($client->deleteWebhook($hook['id'])['id'] === $hook['id'], 'deleteWebhook');

// The worked example from the Standard Webhooks specification.
$headers = ['Webhook-Id' => 'msg_p5jXN8AQM9LWM0D4loKWxJek', 'Webhook-Timestamp' => '1614265330', 'Webhook-Signature' => 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='];
check(Webhook::verify('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', $headers, '{"test": 2432232314}', 300, 1614265330) === ['test' => 2432232314], 'Webhook::verify accepts a good signature');
try {
    Webhook::verify('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', $headers, '{"test": 1}', 300, 1614265330);
    check(false, 'a changed body is refused');
} catch (WebhookVerificationException) {
    check(true, 'Webhook::verify refuses a changed body');
}

$client->waitForTenant($ref, 100, 15000);
$client->deleteTenant($ref);
echo "ok - deleteTenant\n";

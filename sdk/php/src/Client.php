<?php

declare(strict_types=1);

namespace Waas\Provisioning;

use InvalidArgumentException;
use RuntimeException;
use Waas\Provisioning\Http\CurlTransport;
use Waas\Provisioning\Http\Transport;

/**
 * A client for the WaaS Provisioning API: stores (tenants), domains, backups, versions, templates,
 * sending domains, Domain Connect links and webhooks. Field names follow the API's OpenAPI files
 * (openapi/*.yaml); results are the API's JSON as associative arrays.
 *
 * Tenant calls take a tenant ref: ['externalId' => 'order-1042'] (your own id) or ['tenantId' => '<uuid>'].
 */
final class Client
{
    private string $baseUrl;
    private string $authorization;
    private Transport $transport;

    public function __construct(string $baseUrl, string $apiKey, string $apiSecret, ?Transport $transport = null)
    {
        if ($baseUrl === '') {
            throw new InvalidArgumentException('baseUrl is required');
        }
        if ($apiKey === '' || $apiSecret === '') {
            throw new InvalidArgumentException('apiKey and apiSecret are required');
        }
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->authorization = 'Basic ' . base64_encode("$apiKey:$apiSecret");
        $this->transport = $transport ?? new CurlTransport();
    }

    // Tenants

    /**
     * Tenants of your product; pass a ref to get just that one (an empty list when it doesn't exist).
     *
     * @param array{externalId?: string, tenantId?: string}|null $tenant
     * @return list<array<string, mixed>>
     */
    public function listTenants(?array $tenant = null): array
    {
        return $this->call('listTenants', 'GET', '/v1/tenants', $tenant === null ? [] : $this->ref($tenant));
    }

    /**
     * The tenant, or null when there is none with that id.
     *
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>|null
     */
    public function getTenant(array $tenant): ?array
    {
        return $this->listTenants($tenant)[0] ?? null;
    }

    /**
     * Schedules a new store; poll with waitForTenant. Repeating a create with the same externalId
     * answers with the store it already made.
     *
     * @param array<string, mixed> $params CreateTenantParams: name, externalId, customDomainName, groupName, wpOptions, phpConstants, ...
     * @return array<string, mixed>
     */
    public function createTenant(array $params): array
    {
        return $this->call('createTenant', 'POST', '/v1/tenants', [], $params);
    }

    /**
     * Sets wpOptions and phpConstants.
     *
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @param array<string, mixed> $params
     * @return array<string, mixed>
     */
    public function updateTenant(array $tenant, array $params): array
    {
        return $this->call('updateTenantOptionsAndConstants', 'PUT', '/v1/tenants', $this->ref($tenant), $params);
    }

    /**
     * Schedules the deletion. Its backups are kept for the retention period, so restoreTenant can bring it back.
     *
     * @param array{externalId?: string, tenantId?: string} $tenant
     */
    public function deleteTenant(array $tenant): void
    {
        $this->call('deleteTenant', 'DELETE', '/v1/tenants', $this->ref($tenant));
    }

    /**
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>
     */
    public function moveTenantToVersion(array $tenant, string $targetVersionId): array
    {
        return $this->call('moveTenantToAVersion', 'POST', '/v1/tenants/version', $this->ref($tenant), ['targetVersionId' => $targetVersionId]);
    }

    /**
     * Takes the store offline, backing it up first unless $takeBackup is false.
     *
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>
     */
    public function suspendTenant(array $tenant, bool $takeBackup = true): array
    {
        return $this->call('suspendTenant', 'POST', '/v1/tenants/suspend', $this->ref($tenant), ['takeBackup' => $takeBackup]);
    }

    /**
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>
     */
    public function resumeTenant(array $tenant): array
    {
        return $this->call('resumeTenant', 'POST', '/v1/tenants/resume', $this->ref($tenant));
    }

    /**
     * Re-creates a deleted tenant, or rolls a live one back, from a backup (the newest finished one when $backupId is null).
     *
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>
     */
    public function restoreTenant(array $tenant, ?string $backupId = null): array
    {
        return $this->call('restoreTenant', 'POST', '/v1/tenants/restore', $this->ref($tenant), $backupId === null ? [] : ['backupId' => $backupId]);
    }

    /**
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return list<array<string, mixed>>
     */
    public function listTenantBackups(array $tenant): array
    {
        return $this->call('listTenantBackups', 'GET', '/v1/tenants/backups', $this->ref($tenant));
    }

    /**
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>
     */
    public function createTenantBackup(array $tenant): array
    {
        return $this->call('createTenantBackup', 'POST', '/v1/tenants/backups', $this->ref($tenant));
    }

    /**
     * Polls the tenant until it is Done (returns it) or Failed (throws TenantFailedException). Use after
     * createTenant, restoreTenant, moveTenantToVersion and domain changes, which return while the work is scheduled.
     *
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>
     */
    public function waitForTenant(array $tenant, int $intervalMs = 5000, int $timeoutMs = 900000): array
    {
        $deadline = microtime(true) + $timeoutMs / 1000;
        for (;;) {
            $current = $this->getTenant($tenant);
            if ($current !== null && $current['statusCode'] === StatusCode::DONE) {
                return $current;
            }
            if ($current !== null && $current['statusCode'] === StatusCode::FAILED) {
                throw new TenantFailedException($current);
            }
            if (microtime(true) + $intervalMs / 1000 > $deadline) {
                throw new RuntimeException('Timed out waiting for tenant ' . ($tenant['externalId'] ?? $tenant['tenantId'] ?? ''));
            }
            usleep($intervalMs * 1000);
        }
    }

    // Domains

    /**
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return list<array<string, mixed>>
     */
    public function listDomains(array $tenant): array
    {
        return $this->call('listTenantDomains', 'GET', '/v1/tenants/domains', $this->ref($tenant));
    }

    /**
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>
     */
    public function addDomain(array $tenant, string $domainName, bool $setAsMainDomain = false): array
    {
        return $this->call('addTenantDomain', 'POST', '/v1/tenants/domains', $this->ref($tenant), ['domainName' => $domainName, 'setAsMainDomain' => $setAsMainDomain]);
    }

    /**
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>
     */
    public function removeDomain(array $tenant, string $domainName): array
    {
        return $this->call('removeTenantDomain', 'DELETE', '/v1/tenants/domains', $this->ref($tenant) + ['domainName' => $domainName]);
    }

    /**
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>
     */
    public function setMainDomain(array $tenant, string $domainName): array
    {
        return $this->call('setMainDomain', 'PUT', '/v1/tenants/domains/main', $this->ref($tenant), ['domainName' => $domainName]);
    }

    /**
     * Whether a domain is free to use as a store domain.
     *
     * @return array<string, mixed>
     */
    public function checkDomainAvailability(string $domain): array
    {
        return $this->call('checkDomainAvailability', 'GET', '/v1/tenants/domains/available', ['domain' => $domain]);
    }

    // The store's own sending domain for email

    /**
     * The sending domain with the DNS records to add, or null when the store sends from the platform's address.
     *
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>|null
     */
    public function getMailDomain(array $tenant): ?array
    {
        return $this->call('getTenantMailDomain', 'GET', '/v1/tenants/mail-domain', $this->ref($tenant))['mailDomain'] ?? null;
    }

    /**
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @return array<string, mixed>
     */
    public function setMailDomain(array $tenant, string $domainName): array
    {
        return $this->call('setTenantMailDomain', 'PUT', '/v1/tenants/mail-domain', $this->ref($tenant), ['domainName' => $domainName])['mailDomain'];
    }

    /** @param array{externalId?: string, tenantId?: string} $tenant */
    public function removeMailDomain(array $tenant): void
    {
        $this->call('removeTenantMailDomain', 'DELETE', '/v1/tenants/mail-domain', $this->ref($tenant));
    }

    /**
     * A link that adds the store's DNS records at the domain's DNS host, when it supports Domain Connect.
     *
     * @param array{externalId?: string, tenantId?: string} $tenant
     * @param 'website'|'email' $service
     * @return array{dnsProvider: ?string, supported: bool, url: ?string, conflict?: string}
     */
    public function domainConnect(array $tenant, string $domainName, string $service): array
    {
        return $this->call('getTenantDomainConnect', 'GET', '/v1/tenants/domain-connect', $this->ref($tenant) + ['domainName' => $domainName, 'service' => $service]);
    }

    // Versions, snapshots and templates

    /**
     * @param array{versionId?: string, versionName?: string} $query
     * @return list<array<string, mixed>>
     */
    public function listVersions(array $query = []): array
    {
        return $this->call('listVersions', 'GET', '/v1/versions', $query);
    }

    /**
     * @param array<string, mixed> $params CreateVersionParams: name, phpVersion, wordPressVersion, snapshotId, ...
     * @return array<string, mixed>
     */
    public function createVersion(array $params): array
    {
        return $this->call('createVersion', 'POST', '/v1/versions', [], $params);
    }

    public function deleteVersion(string $versionId): void
    {
        $this->call('deleteVersion', 'DELETE', '/v1/versions', ['versionId' => $versionId]);
    }

    /**
     * New tenants are created on the production version unless they name another.
     *
     * @return array<string, mixed>
     */
    public function setProductionVersion(string $versionId): array
    {
        return $this->call('setProductionVersion', 'PUT', '/v1/versions/production', [], ['versionId' => $versionId]);
    }

    /**
     * @param array{versionId?: string, snapshotId?: string, snapshotName?: string, groupName?: string, onlyProductionVersion?: bool} $query
     * @return list<array<string, mixed>>
     */
    public function listSnapshots(array $query = []): array
    {
        return $this->call('listSnapshots', 'GET', '/v1/snapshots', $query);
    }

    /** The snapshot's zip, as bytes. */
    public function downloadSnapshot(string $snapshotId): string
    {
        return $this->send('downloadSnapshot', 'GET', '/v1/snapshots/download', ['snapshotId' => $snapshotId]);
    }

    /**
     * Base snapshots: templates new versions can start from.
     *
     * @param array{baseSnapshotId?: string, name?: string, groupName?: string} $query
     * @return list<array<string, mixed>>
     */
    public function listTemplates(array $query = []): array
    {
        return $this->call('listBaseSnapshotsTemplates', 'GET', '/v1/basesnapshots', $query);
    }

    /**
     * Registers a template and answers with a URL to upload its zip to.
     *
     * @param array<string, mixed> $params CreateBaseSnapshotParams: name, comment, groupName, ...
     * @return array<string, mixed>
     */
    public function createTemplate(array $params): array
    {
        return $this->call('createBaseSnapshotTemplateUpload', 'POST', '/v1/basesnapshots', [], $params);
    }

    /** @return array<string, mixed> */
    public function deleteTemplate(string $id): array
    {
        return $this->call('deleteBaseSnapshot', 'DELETE', '/v1/basesnapshots', ['id' => $id]);
    }

    // Webhooks (docs/webhooks.md)

    /** @return list<array<string, mixed>> */
    public function listWebhooks(): array
    {
        return $this->call('listWebhookEndpoints', 'GET', '/v1/webhooks');
    }

    /**
     * Registers an endpoint. The answer's 'secret' is shown only this once: keep it to verify requests.
     *
     * @param array{url: string, description?: string|null, eventTypes?: list<string>, enabled?: bool} $params
     * @return array<string, mixed>
     */
    public function createWebhook(array $params): array
    {
        return $this->call('createWebhookEndpoint', 'POST', '/v1/webhooks', [], $params);
    }

    /** @return array<string, mixed> */
    public function getWebhook(string $id): array
    {
        return $this->call('getWebhookEndpoint', 'GET', '/v1/webhooks/' . rawurlencode($id));
    }

    /**
     * Fields left out keep their value; an empty eventTypes is every event.
     *
     * @param array{url?: string, description?: string|null, eventTypes?: list<string>, enabled?: bool} $params
     * @return array<string, mixed>
     */
    public function updateWebhook(string $id, array $params): array
    {
        return $this->call('updateWebhookEndpoint', 'PUT', '/v1/webhooks/' . rawurlencode($id), [], $params);
    }

    /** @return array<string, mixed> */
    public function deleteWebhook(string $id): array
    {
        return $this->call('deleteWebhookEndpoint', 'DELETE', '/v1/webhooks/' . rawurlencode($id));
    }

    /**
     * A new secret; the old one stops working at once.
     *
     * @return array<string, mixed>
     */
    public function rotateWebhookSecret(string $id): array
    {
        return $this->call('rotateWebhookSecret', 'POST', '/v1/webhooks/' . rawurlencode($id) . '/rotate-secret');
    }

    /**
     * Sends a webhook.test event to the endpoint and answers with the pending delivery.
     *
     * @return array<string, mixed>
     */
    public function testWebhook(string $id): array
    {
        return $this->call('testWebhookEndpoint', 'POST', '/v1/webhooks/' . rawurlencode($id) . '/test');
    }

    /**
     * @param array{status?: string, tenantId?: string, page?: int, pageSize?: int} $query
     * @return array{items: list<array<string, mixed>>, total: int, page: int, pageSize: int}
     */
    public function listWebhookDeliveries(string $id, array $query = []): array
    {
        return $this->call('listWebhookDeliveries', 'GET', '/v1/webhooks/' . rawurlencode($id) . '/deliveries', $query);
    }

    /**
     * Sends a delivered or failed delivery again, retries included.
     *
     * @return array<string, mixed>
     */
    public function retryWebhookDelivery(string $deliveryId): array
    {
        return $this->call('retryWebhookDelivery', 'POST', '/v1/webhooks/deliveries/' . rawurlencode($deliveryId) . '/retry');
    }

    /**
     * @param array<string, mixed> $tenant
     * @return array<string, string>
     */
    private function ref(array $tenant): array
    {
        $externalId = $tenant['externalId'] ?? null;
        $tenantId = $tenant['tenantId'] ?? null;
        if (is_string($externalId) && $externalId !== '' && $tenantId === null) {
            return ['externalId' => $externalId];
        }
        if (is_string($tenantId) && $tenantId !== '' && $externalId === null) {
            return ['tenantId' => $tenantId];
        }
        throw new InvalidArgumentException("A tenant ref is ['externalId' => ...] or ['tenantId' => ...]");
    }

    /**
     * @param array<string, scalar|null> $query
     * @param array<string, mixed>|null $body
     */
    private function call(string $operation, string $method, string $path, array $query = [], ?array $body = null): mixed
    {
        $text = $this->send($operation, $method, $path, $query, $body);

        return $text === '' ? null : json_decode($text, true, 512, JSON_THROW_ON_ERROR);
    }

    /**
     * @param array<string, scalar|null> $query
     * @param array<string, mixed>|null $body
     */
    private function send(string $operation, string $method, string $path, array $query = [], ?array $body = null): string
    {
        $params = [];
        foreach ($query as $name => $value) {
            if ($value !== null) {
                $params[$name] = is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;
            }
        }
        $url = $this->baseUrl . $path . ($params ? '?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986) : '');
        $headers = ['Authorization' => $this->authorization, 'Accept' => 'application/json'];
        $json = null;
        if ($body !== null) {
            $headers['Content-Type'] = 'application/json';
            // An empty PHP array would encode as [], and these bodies are JSON objects.
            $json = $body === [] ? '{}' : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        }
        $response = $this->transport->send($method, $url, $headers, $json);
        if ($response['status'] < 200 || $response['status'] >= 300) {
            $decoded = json_decode($response['body'], true);
            $message = is_array($decoded) && is_string($decoded['message'] ?? null) ? $decoded['message'] : null;
            throw new WaasApiException($response['status'], $operation, $message);
        }

        return $response['body'];
    }
}

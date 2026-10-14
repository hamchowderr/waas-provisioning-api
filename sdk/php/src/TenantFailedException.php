<?php

declare(strict_types=1);

namespace Waas\Provisioning;

use RuntimeException;

/** A tenant reached Failed while Client::waitForTenant was waiting for it. */
final class TenantFailedException extends RuntimeException
{
    /** @param array<string, mixed> $tenant */
    public function __construct(private array $tenant)
    {
        parent::__construct('Tenant ' . ($tenant['externalId'] ?? $tenant['id'] ?? '') . ' failed to provision');
    }

    /** @return array<string, mixed> */
    public function getTenant(): array
    {
        return $this->tenant;
    }
}

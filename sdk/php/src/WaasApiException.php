<?php

declare(strict_types=1);

namespace Waas\Provisioning;

use RuntimeException;

/** A non-2xx answer. getApiMessage() is the API's own explanation when it sent one. */
final class WaasApiException extends RuntimeException
{
    public function __construct(
        private int $status,
        private string $operation,
        private ?string $apiMessage,
    ) {
        parent::__construct($apiMessage !== null ? "$operation: $apiMessage ($status)" : "$operation failed with HTTP $status", $status);
    }

    public function getStatus(): int
    {
        return $this->status;
    }

    public function getOperation(): string
    {
        return $this->operation;
    }

    public function getApiMessage(): ?string
    {
        return $this->apiMessage;
    }
}

<?php

declare(strict_types=1);

namespace Waas\Provisioning\Http;

/** Sends one HTTP request. Swap it to use your framework's HTTP client. */
interface Transport
{
    /**
     * @param array<string, string> $headers
     * @return array{status: int, body: string}
     */
    public function send(string $method, string $url, array $headers, ?string $body): array;
}

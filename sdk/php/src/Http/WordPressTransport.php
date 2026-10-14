<?php

declare(strict_types=1);

namespace Waas\Provisioning\Http;

use RuntimeException;

/** Sends requests with wp_remote_request, so WordPress proxy settings and HTTP filters apply. */
final class WordPressTransport implements Transport
{
    public function __construct(private int $timeoutSeconds = 30)
    {
    }

    public function send(string $method, string $url, array $headers, ?string $body): array
    {
        $response = wp_remote_request($url, [
            'method' => $method,
            'headers' => $headers,
            'body' => $body,
            'timeout' => $this->timeoutSeconds,
        ]);
        if (is_wp_error($response)) {
            throw new RuntimeException("Request to $url failed: " . $response->get_error_message());
        }

        return [
            'status' => (int) wp_remote_retrieve_response_code($response),
            'body' => (string) wp_remote_retrieve_body($response),
        ];
    }
}

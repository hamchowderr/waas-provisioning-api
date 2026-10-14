<?php

declare(strict_types=1);

namespace Waas\Provisioning\Http;

use RuntimeException;

final class CurlTransport implements Transport
{
    public function __construct(private int $timeoutSeconds = 30)
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('CurlTransport needs the curl extension; pass another Transport to the Client');
        }
    }

    public function send(string $method, string $url, array $headers, ?string $body): array
    {
        $curl = curl_init($url);
        $lines = [];
        foreach ($headers as $name => $value) {
            $lines[] = "$name: $value";
        }
        curl_setopt_array($curl, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
        ]);
        if ($body !== null) {
            curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
        }
        $response = curl_exec($curl);
        if ($response === false) {
            $error = curl_error($curl);
            curl_close($curl);
            throw new RuntimeException("Request to $url failed: $error");
        }
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        curl_close($curl);

        return ['status' => $status, 'body' => (string) $response];
    }
}

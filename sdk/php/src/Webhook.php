<?php

declare(strict_types=1);

namespace Waas\Provisioning;

/**
 * Checks webhook requests from the API (Standard Webhooks signing, docs/webhooks.md).
 *
 *     $event = Webhook::verify($secret, getallheaders(), file_get_contents('php://input'));
 */
final class Webhook
{
    /**
     * Returns the event when the signature matches and the timestamp is within $toleranceSeconds
     * of now; throws WebhookVerificationException otherwise. Pass the raw body exactly as received.
     *
     * @param array<string, string|list<string>> $headers Any case.
     * @return array<string, mixed>
     */
    public static function verify(string $secret, array $headers, string $rawBody, int $toleranceSeconds = 300, ?int $now = null): array
    {
        $headers = array_change_key_case($headers, CASE_LOWER);
        $get = static function (string $name) use ($headers): ?string {
            $value = $headers[$name] ?? null;
            return is_array($value) ? ($value[0] ?? null) : $value;
        };
        $id = $get('webhook-id');
        $timestamp = $get('webhook-timestamp');
        $signatures = $get('webhook-signature');
        if ($id === null || $timestamp === null || $signatures === null) {
            throw new WebhookVerificationException('Missing webhook-id, webhook-timestamp or webhook-signature');
        }
        if (!ctype_digit($timestamp) || abs(($now ?? time()) - (int) $timestamp) > $toleranceSeconds) {
            throw new WebhookVerificationException('The webhook timestamp is too old or in the future');
        }
        $key = base64_decode(preg_replace('/^whsec_/', '', $secret) ?? '', true);
        if ($key === false) {
            throw new WebhookVerificationException('The secret is not a whsec_ secret');
        }
        $expected = 'v1,' . base64_encode(hash_hmac('sha256', "$id.$timestamp.$rawBody", $key, true));
        foreach (explode(' ', $signatures) as $signature) {
            if (hash_equals($expected, $signature)) {
                return json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
            }
        }
        throw new WebhookVerificationException('The webhook signature does not match');
    }
}

# Webhooks

The API tells your server when a store or version finishes a change, so you don't have to poll `GET /v1/tenants` for `statusCode`. Everything runs inside the API on its own Postgres and pg-boss: no outside service is needed.

With an SDK, `waas.webhooks.create()` registers an endpoint and `verifyWebhook()` checks a request ([TypeScript](../sdk/typescript/README.md#webhooks)); in PHP it is `createWebhook()` and `Webhook::verify()` ([PHP](../sdk/php/README.md#webhooks)). The rest of this page is what happens on the wire.

The endpoints are in [openapi/webhooks.yaml](../openapi/webhooks.yaml), and the admin endpoints are in [openapi/admin/admin-api.yaml](../openapi/admin/admin-api.yaml) under `/admin/webhooks`.

## Register an endpoint

Sign in with the storefront's API key and secret (Basic auth, as for every `/v1` call). An endpoint belongs to the key's product (storefront), so every key of that product sees it. A product can have up to 10.

```sh
curl -u "$KEY:$SECRET" -H 'Content-Type: application/json' \
  -d '{"url": "https://hooks.example.com/waas", "eventTypes": ["tenant.ready", "tenant.failed"]}' \
  https://api.example.com/v1/webhooks
```

The answer includes `secret` (`whsec_…`). It is shown only this once, so keep it. `POST /v1/webhooks/{id}/rotate-secret` gives a new one, and the old one stops working at once. An empty or missing `eventTypes` sends every event. `POST /v1/webhooks/{id}/test` sends a `webhook.test` event. `PUT` changes an endpoint (for example `{"enabled": false}`), and `DELETE` removes it.

The URL must be `https://` on a public address. When the API runs on a private network (or in tests), `WEBHOOK_ALLOW_PRIVATE=true` also allows `http://` and private addresses. Addresses are checked when the request connects, so a name can't resolve to a public address when it's saved and a private one later.

## Events

Each request body is `{"type": "...", "timestamp": "<ISO time>", "data": {...}}`.

| Type | When | `data` |
|---|---|---|
| `tenant.ready` | A new store is created and answering | `tenant` |
| `tenant.updated` | `wpOptions` or `phpConstants` were applied | `tenant` |
| `tenant.version_changed` | The store moved to another version | `tenant` |
| `tenant.domains_changed` | Its domains were applied | `tenant` |
| `tenant.suspended`, `tenant.resumed` | Taken offline, or back online | `tenant` |
| `tenant.deleted` | The store is gone | `tenant` as it was |
| `tenant.restored` | A deleted store is back from its backup | `tenant` |
| `tenant.rolled_back` | A live store went back to one of its backups | `tenant` |
| `tenant.backup_completed`, `tenant.backup_failed` | A backup finished or failed, nightly ones included | `tenant`, `backupId` |
| `tenant.failed` | A change still failed after its retries | `tenant`, `action` (`create`, `update`, `change_version`, `change_domains`, `delete`, `suspend`, `resume`, `restore`, `roll_back`) |
| `version.ready`, `version.deleted` | A version finished building, or is gone | `version` |
| `version.failed` | A version build or delete failed | `version`, `action` |
| `webhook.test` | Sent by `POST /v1/webhooks/{id}/test` | `endpointId` |

`tenant` has the same fields as an item of `GET /v1/tenants`, and `version` the same as an item of `GET /v1/versions`. Events are sent only when a product has an endpoint that wants them, and nothing is recorded otherwise.

## Verify the signature

Requests follow the [Standard Webhooks](https://www.standardwebhooks.com) specification, so its libraries (`standardwebhooks` on npm, PyPI, Packagist and others) verify them with the endpoint's secret. Each request carries three headers:

- `webhook-id`: the event id, the same on every retry. Use it to drop repeats.
- `webhook-timestamp`: Unix seconds when this attempt was sent. Reject one more than 5 minutes off.
- `webhook-signature`: `v1,` followed by the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<raw body>`, keyed by the base64-decoded part of the secret after `whsec_`.

Without a library, in Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, rawBody) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = Buffer.from(createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64'));
  return headers['webhook-signature'].split(' ').some((s) => {
    const given = Buffer.from(s.replace(/^v1,/, ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

In PHP:

```php
function waas_verify(string $secret, array $headers, string $body): bool {
    $id = $headers['webhook-id'];
    $ts = $headers['webhook-timestamp'];
    if (abs(time() - (int) $ts) > 300) return false;
    $key = base64_decode(substr($secret, strlen('whsec_')));
    $expected = 'v1,' . base64_encode(hash_hmac('sha256', "$id.$ts.$body", $key, true));
    foreach (explode(' ', $headers['webhook-signature']) as $sig) {
        if (hash_equals($expected, $sig)) return true;
    }
    return false;
}
```

Sign over the raw body exactly as received, not over JSON you parsed and encoded again.

## Delivery and retries

| | |
|---|---|
| Success | Any 2xx answer within 10 seconds. Redirects are not followed. |
| Retries | 10 more attempts, from 30 seconds apart doubling to an hour, about seven hours in all (pg-boss `webhooks` queue). Each attempt is a new timestamp and signature over the same body. |
| After that | The delivery is marked `failed`. `POST /v1/webhooks/deliveries/{id}/retry` (or Retry on the dashboard's Webhooks page) sends it again from the start. |
| Order | Not guaranteed, and an event can arrive more than once. Use `webhook-id` to drop repeats, and `timestamp` or a fresh `GET /v1/tenants` for the latest state. |
| Records | `GET /v1/webhooks/{id}/deliveries` lists each delivery with its attempts, the last HTTP status, the start of the last answer (500 characters) and the error. Events and deliveries are kept `WEBHOOK_LOG_DAYS` (30) and deleted by the daily maintenance job. |
| Secrets | Stored encrypted under `SECRETS_KEY`, like private PHP constants. |

A webhook problem never fails the store job that sent it: if an event can't be recorded, the job still finishes and the error goes to the API's log.

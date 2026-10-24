# Integrations

No-code apps for the API, so a form, a payment or a CRM step can create a site and a flow can start when it's ready.

| Folder | Platform | What it is | Published as |
|---|---|---|---|
| [`n8n/`](n8n/) | n8n | Community node package: an **AnyPress** node and an **AnyPress Trigger** | `n8n-nodes-anypress` on npm, then n8n's verified list |
| [`zapier/`](zapier/) | Zapier | Zapier Platform CLI app | The AnyPress app on Zapier |
| [`make/`](make/) | Make | Custom app in the Make Apps local project format (`makecomapp.json`) | The AnyPress app on Make |

All three have the same steps:

- **Create a site** (`POST /v1/tenants`), **get** it (`GET /v1/tenants`), **suspend**, **resume** and **delete** it, by the caller's own reference (`externalId`) or the site's id.
- **Site events**: a trigger that registers a webhook (`POST /v1/webhooks`) when the flow is turned on and removes it when it's turned off. Each event is one item with the site and its `url`.
- **Storefront keys and partner keys.** A partner key needs the storefront on each call (`productId`): n8n and Zapier show a storefront dropdown filled from `GET /v1/products`; Make keeps it on the connection, one connection per storefront.

## Checking webhook requests

n8n and Zapier check the Standard Webhooks signature on the raw body with the secret the API returned when the webhook was registered, and refuse a timestamp more than five minutes off (n8n answers 401; Zapier starts nothing). Make doesn't give a custom app the raw body, so Make's trigger reads the site back from the API with the connection's own key and passes that on, with `verified` set when it found it. A request that didn't come from the API can't put made-up site data into a scenario.

## Tests

`test/integrations.test.ts` drives the n8n node and the Zapier app against the real app over HTTP, real webhook deliveries included, and checks the Make app's files against the API's spec. It needs the two packages installed and the n8n node built first, as CI does:

```sh
(cd integrations/n8n && npm ci && npm run lint && npm run build)
(cd integrations/zapier && npm ci && npm run validate)
npx vitest run test/integrations.test.ts
```

`npm run lint` is n8n's own linter (`@n8n/node-cli`), the checks n8n runs before verifying a node. `npm run validate` is Zapier's schema check. The Make files also pass the JSON schemas of Make's VS Code extension (`integromat/vscode-apps-sdk`).

`npm run dev` in `integrations/n8n` starts a local n8n with the node loaded.

## Publishing

Each one is released by pushing a tag. The workflows check the tag matches the version.

| Tag | Workflow | Needs, once |
|---|---|---|
| `n8n-v0.1.1` | [`release-n8n.yml`](../.github/workflows/release-n8n.yml) | npm Trusted Publishing for `n8n-nodes-anypress` with this repository and `release-n8n.yml` (as for the SDK in [docs/publishing.md](../docs/publishing.md)). Then submit the package on the [n8n Creator Portal](https://creators.n8n.io/nodes) for verification |
| `zapier-v1.0.0` | [`release-zapier.yml`](../.github/workflows/release-zapier.yml) | The app registered on Zapier's developer platform (its number goes in the repository variable `ZAPIER_APP_ID`) and a deploy key in the secret `ZAPIER_DEPLOY_KEY`. Making it public is a request on the developer platform once it has users |
| `make-v1.0.0` | [`release-make.yml`](../.github/workflows/release-make.yml) | A Make API token with `sdk-apps:read` and `sdk-apps:write` in the secret `MAKE_API_TOKEN`, and the variables `MAKE_ZONE` (such as `us1.make.com`) and `MAKE_APP_ID`. The first run creates the app. Making it public is a review request to Make |

n8n verification needs an MIT license and no runtime dependencies, which is why `n8n/` is MIT while the rest of this repository is GPL.

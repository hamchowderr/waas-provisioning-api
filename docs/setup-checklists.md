# Setup checklists

Every storefront and reseller has a setup checklist. Each step ticks itself from data the API already holds, so nobody ticks a box by hand. `GET /admin/setup` returns them. The platform admin gets every storefront and reseller. A signed-in customer calls `GET /account/setup` and gets their own storefront, or, on a reseller's team, the reseller and all its storefronts.

## A storefront's steps

| Key | Step | Done when |
|---|---|---|
| `approved` | Application approved | The seller's application was approved. It is also done for a storefront made without an application. |
| `shop-connected` | Shop connected | One of the storefront's API keys has been used, which means AnyPress Host on the shop has signed in. A seller with a ready-made storefront is told it connects itself; others are told to install AnyPress Host and add their key. |
| `starting-site` | Starting site picked | The storefront has a production version. |
| `plans` | Plans on sale | The shop's AnyPress Host reports a published plan. Reads `not-reported` until AnyPress Host sends it. |
| `payments` | Payments on | The shop's AnyPress Host reports a live payment method. Reads `not-reported` until AnyPress Host sends it. |
| `own-domain` | Own domain | The shop address AnyPress Host last reported is not a platform address (the stores domain, the platform domain, sslip.io or an IP address). |
| `brand` | Brand added | The storefront, or its reseller, has a name or logo on Branding. |
| `team` | Team invited | Someone besides the first member has joined the storefront's team, or its reseller's team. |
| `self-building` | Stores build themselves | A store was made through the storefront's own key, so an order on the shop built it with nobody involved. This step reads from the request log, so it only sees stores made within the log's retention (`REQUEST_LOG_DAYS`). |
| `first-store` | First store sold | One of the storefront's stores has gone live. |

## A reseller's steps

| Key | Step | Done when |
|---|---|---|
| `billing` | Billing details | The reseller has a billing email. |
| `partner-key` | Partner key made | The reseller has at least one partner key. |
| `storefronts-ready` | Every storefront set up | Every one of its storefronts has finished all of its steps. |

## Progress

Each checklist also returns `done`, `total`, `next` (the first step left to do, skipping steps AnyPress Host hasn't reported yet unless nothing else is left) and `lastProgressAt`, which is the newest step done, or when the account was made if none are. A checklist is `stuck` when it isn't finished and no step has been done for 7 days.

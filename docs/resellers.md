# Reseller accounts

For whoever runs the API: how to group a partner's storefronts and count what to bill them.

A **reseller** is a partner that sells stores from one or more storefronts (products) under its own brand, and pays the platform a wholesale price for every live store across them. The public contract calls this a *subscription*; a reseller's id will be its `subscriptionId` once the partner calls in [docs/contract.md](contract.md) are built.

A storefront that belongs to no reseller works exactly as before. Moving one into a reseller changes nothing for its API keys, team or stores; it only adds the reseller's limits and starts counting its stores toward the reseller's usage.

## Making one

Everything is on the admin API (`Authorization: Bearer <ADMIN_TOKEN>`). Signed-in customers get 404 for all of it.

| Call | What it does |
|---|---|
| `POST /admin/resellers` `{"name": "Acme Partners", "productIds": ["…"]}` | A new reseller. `productIds` moves those storefronts into it at once |
| `PUT /admin/resellers/{id}` | Changes only the settings sent (below) |
| `PUT /admin/resellers/{id}/products/{productId}` | Moves a storefront in. A storefront of another reseller is 409 |
| `DELETE /admin/resellers/{id}/products/{productId}` | Moves it out; it is its own storefront again |
| `DELETE /admin/resellers/{id}` | Only when it has no storefronts (409 otherwise). Its usage history stays |

| Setting | Meaning |
|---|---|
| `maxProducts` | Storefronts it may have. `null`: no limit |
| `maxTenants` | Stores across all its storefronts. At the limit, creating or restoring a store answers 400, as a storefront's own `maxTenants` does. Both limits apply |
| `wholesalePercent` | The discount off list price on its bill, 0 to 100 (default 40) |
| `billingEmail` | Where its bill goes |
| `brandName`, `brandUrl` | Its own name, and an http(s) link on it, for the "website unavailable" page its stores show while suspended, in place of the platform's (`STORE_BRAND_NAME`). `null` uses the platform's again. A store already suspended keeps the page it got; the next suspension uses the new brand |
| `listPriceCents` | `{"small": 1200, "medium": 2400, "large": 4800}`: the monthly list price of one store of each size, in US cents, before the discount. Send only the sizes to change. The default is the Website plan's price |

Lowering a limit below the current count removes nothing; it only stops new storefronts or stores.

## Usage

`GET /admin/resellers/{id}/usage?from=…&to=…` answers store-days per size (`small`, `medium`, `large`), in total and per storefront. `from` and `to` default to the current calendar month (UTC). A store live for all of a 30-day month is 30 store-days.

A store counts:

- from when it first finished building, so a store that never built isn't billed;
- while it is not suspended and not being removed. A store that is only updating (a moment of Pending) keeps counting;
- at its size at the time, so a resize part way through a month is billed at each size for its share;
- for the reseller its storefront belonged to at the time.

The record is the `tenant_periods` table, one row for each stretch a store was live at one size under one reseller. Database triggers on `tenants` and `products` keep it, so every way a store is created, suspended, resized, moved or deleted is counted without the code having to remember. Rows stay after the store is deleted, so a past month always adds up the same. Stores live when the record began start their first row at that moment; nothing earlier was recorded.

## The monthly bill

`GET /admin/resellers/{id}/bill?month=2026-09` answers what the reseller owes for one calendar month (UTC); without `month` it is last month. The dashboard shows it on the reseller's page, with a CSV download.

Each store is charged its size's monthly list price less the wholesale discount, for the share of the month it was live: a store live all month pays the whole monthly price, one live 10 days of a 30-day month a third. There is one line per storefront and size, with its store-days, the store-months they make, the price after the discount and the amount, then the total. Amounts are US cents, rounded per line. A month not yet over is answered with `complete: false`, so it can be watched as it grows.

The bill is worked out from the usage record each time it is asked for; nothing is stored. For now it is sent by hand to the reseller's `billingEmail`.

# Reseller accounts

For whoever runs the API: how to group a partner's storefronts and count what to bill them.

A **reseller** is a partner that sells stores from one or more storefronts (products) under its own brand, and pays the platform a wholesale price for every live store across them. The public contract calls this a *subscription*, and a reseller's id is its `subscriptionId`.

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

## Partner keys

A partner key is an API key that belongs to the reseller instead of one storefront. It works on every storefront in the account, so a partner running several of them needs one key, not one per storefront.

| Call | What it does |
|---|---|
| `GET /admin/resellers/{id}/keys` | Its keys: working ones and those revoked in the last 30 days. Never secrets |
| `POST /admin/resellers/{id}/keys` `{"label": "…"}` | A new key. The secret is in this answer only |
| `POST /admin/resellers/{id}/keys/{keyId}/rotate` `{"graceHours": 24}` | A new key in place of an active one; the old one keeps working for `graceHours` (0 to 720) |
| `DELETE /admin/resellers/{id}/keys/{keyId}` | Revokes it now |

A reseller can have 20 working keys, like a storefront. Deleting the reseller deletes its keys.

On `/v1`, the partner key signs in with Basic auth like any key, and:

- `GET /v1/subscriptions` answers its own account, and `GET /v1/products` its storefronts. These need no `productId`. A storefront's own key gets 403 on both.
- Every other call takes `?productId=` to say which storefront it is for, and then works exactly as it would with that storefront's own key. Without it the answer is 400; a storefront outside the account is 403. A storefront moved out of the account is out of reach at once.
- A storefront's own key ignores `productId`, as the contract says, so nothing changes for existing callers.

Making and deleting storefronts with a partner key (`POST`, `DELETE /v1/products`) comes later.

## Reseller team

People at the reseller sign in to the dashboard like any customer. A reseller has one team (an organization), and everyone on it reaches every storefront the reseller has, with their role on the team (`owner`, `admin` or `member`, as in [accounts.md](accounts.md#roles)). A storefront moved into the reseller is in reach at once; one moved out is out of reach at once.

| Call | What it does |
|---|---|
| `GET /admin/resellers/{id}/organization` | The team, its members and pending invitations |
| `PUT /admin/resellers/{id}/organization` `{"name": "…"}` | Makes the team, or renames it. The name defaults to the reseller's |
| `POST /admin/resellers/{id}/invitations` `{"email": "…", "role": "owner"}` | Invites someone, as for a storefront's team (made if there is none). The invitation is emailed |
| `DELETE /admin/resellers/{id}/invitations/{invitationId}` | Cancels a pending invitation |
| `PATCH /admin/resellers/{id}/members/{memberId}` `{"role": "admin"}` | Changes someone's role. The last owner stays (409) |
| `DELETE /admin/resellers/{id}/members/{memberId}` | Removes someone. Their account stays; it no longer reaches the storefronts |

Only the platform admin manages the reseller's team. A storefront's own team is separate and works as before; someone on both gets the higher of the two roles on that storefront.

A signed-in person with several storefronts picks one in the dashboard's switcher, which sends its id in the `X-Product-Id` header. `GET /account` lists one membership per storefront (`resellerId` is set on those that come from a reseller's team), and `/v1` and `/account/*` act on the picked one. Without the header, or when it names none of theirs, the first storefront of the organization picked in the session is used, or the only one. An AI app connected by a reseller's team member works on the storefront they picked, and stops once they leave the team.

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

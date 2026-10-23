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
| `billingEmail` | Where its bill goes. Its Stripe customer is made from this on its first invoice |
| `stripeCustomerId` | Its Stripe customer (`cus_…`), to bill one that already exists. `null` until the first invoice makes one |
| `autoInvoice` | Send its bill as a Stripe invoice on the 1st (default `true`). `false` leaves it to be billed by hand |
| `brandName`, `brandUrl` | Its own name, and an http(s) link on it, for the "website unavailable" page its stores show while suspended, in place of the platform's (`STORE_BRAND_NAME`). `null` uses the platform's again. A store already suspended keeps the page it got; the next suspension uses the new brand |
| `listPriceCents` | `{"small": 1200, "medium": 2400, "large": 4800}`: the monthly list price of one store of each size, in US cents, before the discount. Send only the sizes to change. The default is the Website plan's price |

Lowering a limit below the current count removes nothing; it only stops new storefronts or stores.

An application to sell can also be approved as a reseller: `POST /admin/applications/{id}/approve` with `{"reseller": true}` makes a reseller named after the business, with its billing email set to the applicant's, `maxTenants` stores (default 3) across up to `maxProducts` storefronts (default 3). The product it makes goes inside, with no store limit of its own, and the applicant is invited as the owner of the reseller's team rather than the product's ([accounts.md](accounts.md#applications-to-sell)). The answer and the application carry its `resellerId`.

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

The partner key also runs the account itself:

| Call | What it does |
|---|---|
| `POST /v1/products?subscriptionId={id}` `{"name": "…", "version": {…}}` | A new storefront in the account, within `maxProducts` (400 at the limit). The partner key works on it at once with `productId`; it gets no key of its own. With `version`, its first version (as for `POST /v1/versions`) is made and becomes the production version; a bad version makes nothing |
| `DELETE /v1/products?productId={id}` | Removes a storefront with no stores left (400 otherwise, so a mistake can't take live sites down, and 400 while a version is still building). Its versions and own templates are removed in the background; its usage history stays |
| `GET /v1/subscriptions/usage?subscriptionId={id}&startDate=…&endDate=…` | Hours between the two dates: `productHours` (storefronts), `versionHours` and `tenantHours` (stores) |
| `GET /v1/products/usage?productId={id}&startDate=…&endDate=…` | The same for one storefront |

Store hours come from the usage ledger, so removed stores count. Storefront and version hours count those that exist now, from when they were made. `subscriptionId` must be the partner's own account (403 otherwise).

## Shared templates

A template (base snapshot) made with a partner key belongs to the account and is offered on every one of its storefronts:

- `POST /v1/basesnapshots` with the partner key makes a shared template, with or without `productId`.
- `GET /v1/basesnapshots` with the partner key and no `productId` lists the shared ones. With a `productId`, or with a storefront's own key, it lists the storefront's own and the shared ones; `onlyPartnerSpecific=true` with the partner key lists only the shared ones.
- `createVersion` and `POST /v1/products` can start a version from a shared template by its id.
- Only the partner key removes a shared template (`DELETE /v1/basesnapshots?id=`). With a `productId` it also removes that storefront's own templates. Deleting the reseller removes its shared templates.

## A partner's first session

What a partner does with a new partner key, start to finish. `API` is the API's address, and `-u` sends the key and secret with Basic auth. Every answer below is shortened from what `/docs` shows for that call, which has the full examples.

```sh
API=https://api.example.com
AUTH="$PARTNER_KEY:$PARTNER_SECRET"

# 1. The account: its id is the subscriptionId the other account calls take.
curl -s -u "$AUTH" "$API/v1/subscriptions"
# [{"id":"1f3ea976-…","name":"Acme Partners"}]
SUB=1f3ea976-…

# 2. A shared template, offered on every storefront in the account. PUT the site archive (.tgz) to uploadUrl.
curl -s -u "$AUTH" -X POST "$API/v1/basesnapshots" -H 'Content-Type: application/json' \
  -d '{"name":"Acme starter","comment":"Home, shop and contact pages","showInConsole":true}'
# {"id":"4c8e2a6f-…","name":"Acme starter","comment":"…","showInConsole":true,"uploadUrl":"https://…"}
curl -s -T acme-starter.tgz "<uploadUrl>"

# 3. A storefront, with its first version started from that template. The version becomes production.
curl -s -u "$AUTH" -X POST "$API/v1/products?subscriptionId=$SUB" -H 'Content-Type: application/json' \
  -d '{"name":"Acme Florists","version":{"name":"v1.0.0","phpVersion":"8.3","wordPressVersion":"6.8","snapshotId":"4c8e2a6f-…"}}'
# {"id":"9d4b7e12-…","name":"Acme Florists","version":{"id":"f742de68-…","domainName":"…","phpVersion":"8.3","wordPressVersion":"6.8"}}
PRODUCT=9d4b7e12-…

# 4. Wait for the version (statusCode 1 is Done), then make a store on that storefront.
curl -s -u "$AUTH" "$API/v1/versions?productId=$PRODUCT"
curl -s -u "$AUTH" -X POST "$API/v1/tenants?productId=$PRODUCT" -H 'Content-Type: application/json' \
  -d '{"name":"Rose and Fern","externalId":"acme-order-1","wordPressUserName":"owner","wordPressUserEmail":"owner@roseandfern.example","wordPressUserRole":"administrator"}'
curl -s -u "$AUTH" "$API/v1/tenants?productId=$PRODUCT&externalId=acme-order-1"

# 5. Usage for a month, for the whole account or one storefront.
curl -s -u "$AUTH" "$API/v1/subscriptions/usage?subscriptionId=$SUB&startDate=2026-09-01T00:00:00Z&endDate=2026-10-01T00:00:00Z"
# {"subscriptionId":"1f3ea976-…","productHours":1440,"versionHours":1872.5,"tenantHours":10080}
curl -s -u "$AUTH" "$API/v1/products/usage?productId=$PRODUCT&startDate=2026-09-01T00:00:00Z&endDate=2026-10-01T00:00:00Z"

# 6. Removing a storefront: remove its stores first, or the answer is 400.
curl -s -u "$AUTH" -X DELETE "$API/v1/tenants?productId=$PRODUCT&externalId=acme-order-1"
curl -s -u "$AUTH" -X DELETE "$API/v1/products?productId=$PRODUCT"
# {"productId":"9d4b7e12-…"}
```

What goes wrong, and the answer:

| Mistake | Answer |
|---|---|
| A store or version call without `productId` | 400 `productId is required with a partner key` |
| A `productId` or `subscriptionId` outside the account | 403 |
| A new storefront past `maxProducts` | 400 `This account has reached its limit of 3 storefronts` |
| Removing a storefront that still has stores | 400 `This storefront still has 2 stores; remove them first` |
| Usage with `endDate` before `startDate` | 400 `endDate must be after startDate` |
| A storefront's own key on `/v1/subscriptions` or `/v1/products` | 403 |

`test/contract-phase2.test.ts` runs these same calls against the contract on every change.

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

The bill is worked out from the usage record each time it is asked for; nothing is stored.

## Automatic invoices

With `STRIPE_SECRET_KEY` set, the API sends each bill as a Stripe invoice. At 07:00 UTC on the 1st (`RESELLER_INVOICE_SCHEDULE` to change), every reseller with `autoInvoice` on gets last month's bill, one invoice line per bill line ("Acme shop: 2 Small stores (60 store-days) at $7.20 a month"):

- The first time, a Stripe customer is made from its `billingEmail` and name, and kept as `stripeCustomerId`. To bill a customer that already exists, set `stripeCustomerId` first. A reseller with neither fails with an error saying so.
- When the customer has a card on file (a default payment method), Stripe charges it. Otherwise Stripe emails the invoice to pay online within `RESELLER_INVOICE_DAYS_DUE` days (default 14). Stripe's own settings decide its emails, receipts and retries.
- A month with nothing to charge is recorded as `nothing_due` and sends nothing.
- Each reseller and month is sent once (the `reseller_invoices` table). Asking again answers the invoice already sent. A failed send is recorded with its error and can be tried again; a draft a stopped try left on Stripe is deleted first, and Stripe idempotency keys stop any part being made twice.

| Endpoint | What it does |
|---|---|
| `GET /admin/resellers/{id}/invoices` | Its invoices, newest month first, with status (`open`, `paid`, `failed`, …), Stripe's invoice page and any error. Open ones are checked with Stripe first, so paid ones show as paid. `enabled: false` while invoicing is off |
| `POST /admin/resellers/{id}/invoices` | Sends a month now (`{"month": "2026-09"}`, default last month), or tries a failed one again. The month must be over. 503 while invoicing is off |

The key needs write access to customers, invoices and invoice items; a restricted key (`rk_…`) with just those works. `RESELLER_INVOICE=off` turns invoicing off while keeping the key. Without a key, bills are only shown, and sent by hand.

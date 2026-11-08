# Buying Domains

A store's owner can buy a new domain for it without leaving AnyPress. The domain is registered in the owner's name, its
DNS is set up for them, and it becomes the store's address: no records to copy, no Domain Connect step. Domains the
owner already has still work as before ([domain-connect.md](domain-connect.md)).

Domains are registered at [Name.com](https://www.name.com) through its official SDK, and paid with a Stripe invoice.

## How It Works

1. **Search.** `GET /v1/tenants/domains/search?query=mybakery` suggests names across the endings sold;
   `query=mybakery.com` checks one name live. Each result says whether it can be bought, the first year's price and
   each later year's price, in cents (USD), with your markup included. Premium names (with a special registry price)
   and endings you don't sell come back as not available, with the reason.
2. **Buy.** `POST /v1/tenants/domains/buy?externalId=<store>` with the domain and the owner's contact details (name,
   address, email, and phone with its country code, such as `+15555555555`). The name is held and the owner is emailed a Stripe invoice to pay
   within 2 days. The answer has `status: awaiting_payment` and `payUrl`, the invoice page, to show or link to.
3. **Registered.** Every 5 minutes the API checks open invoices. Once one is paid, the domain is registered for one
   year in the owner's name with WHOIS privacy on, its A and AAAA records (the domain and `www`) point at the stores,
   and it becomes the store's main address. SSL follows on its own. If the name was taken, or its price went up, before
   the payment came in, the order is marked `failed` and the invoice should be refunded. An invoice that isn't paid
   lets the name go (`cancelled`).
4. **Renewals.** 30 days before a domain expires, the owner gets a renewal invoice. It is charged to their card when one
   is on file. The domain is renewed once the invoice is paid. Turn this off with
   `PUT /v1/tenants/domains/bought/auto-renew` (`autoRenew: false`); the domain then expires at the end of its year.
5. **Leaving.** `GET /v1/tenants/domains/bought/transfer-code?domainName=` gives the code that moves the domain to
   another registrar, so the owner can always take it with them.

`GET /v1/tenants/domains/bought` lists a store's domains with their status, prices and expiry date. The dashboard
has the same calls under `/admin/tenants/{id}/domains/...`.

The registry may email the owner once to confirm their email address. A domain whose address isn't confirmed within
15 days is paused by the registry until it is.

## Selling Domains at a Storefront

A storefront can also sell domains at its own checkout, at its own price and in its own brand. The shop takes the
payment, then tells the API:

1. **Quote.** The same search shows what the domain costs the storefront (`priceCents`, `renewalPriceCents`). The shop
   adds its own margin.
2. **Paid.** Once the shop's order is paid, `POST /v1/tenants/domains/buy` with the domain, the contact and
   `reference` (the shop's order). No invoice is sent: the answer is `status: registering`, `paidBy: storefront`, and
   the domain is registered within a minute, as above. Sending the same `reference` again answers the same domain, so
   the shop can safely retry.
3. **Renewed.** The shop sells the domain as a yearly subscription. When a renewal is paid,
   `POST /v1/tenants/domains/bought/renew` with the domain and the renewal order as `reference` renews it for one more
   year. The API sends no renewal invoices for these domains; one that isn't renewed expires at the end of its year.
4. **Failed.** If the name was taken before the order came in, the domain is marked `failed` and the shop should
   refund the order. Nothing is charged for it.

A reseller's storefronts can do this, and each registration and renewal is on the reseller's monthly bill
(`domainLines`) at the storefront's price. Storefronts without a reseller need to be listed in `DOMAIN_SHOP_PRODUCTS`;
the others get invoices as above.

## Setting It Up

1. Make a [Name.com](https://www.name.com/account/signup) reseller account. Pick a shared username, not Google sign-in.
2. On [API settings](https://www.name.com/account/settings/api), make a **Development/Test Environment** token and a
   **Production** token.
3. Set `NAMECOM_USERNAME`, `NAMECOM_TEST_TOKEN` (and `NAMECOM_TEST_USERNAME` if your test username isn't your
   username plus `-test`) and `STRIPE_SECRET_KEY` (a restricted key with write access to
   customers, invoices and invoice items works). Buying runs on Name.com's test system, where nothing is charged.
4. Add account credit at Name.com: registrations and renewals are paid from it.
5. For real sales, set `NAMECOM_TOKEN` and `NAMECOM_SANDBOX=off`.

`DOMAIN_MARKUP_CENTS` (default 500, $5) is added to each year's price. `DOMAIN_TLDS` lists the endings sold
(default: com, net, org, co, io, shop, store, online, site, biz, info, app, dev, xyz). `DOMAIN_SHOP_PRODUCTS` lists,
comma-separated, the storefronts without a reseller (such as your own shop) that take payment for domains themselves.

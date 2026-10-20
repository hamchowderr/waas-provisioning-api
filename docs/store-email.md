# Store email

For whoever runs the API. Stores send their email (password resets, FluentCart order receipts, new-user mail) through one SMTP relay for the whole platform. The default is [toSend](https://tosend.com) over SMTP (`smtp.tosend.com`, port 587 with STARTTLS, user `tosend`, an API key as the password). The official WordPress image has no mailer of its own, so without this a store's `wp_mail()` fails quietly.

## How it works

- The API holds the relay settings (below). When `STORE_SMTP_PASSWORD` is set, every store gets them as the Coolify variable `WAAS_MAIL_B64` (base64 JSON), which the compose file passes to the `wordpress` and `agent` containers. They are never in an agent command or in the store's files, so snapshots and backups carry no credentials.
- The store agent writes the mu-plugin `wp-content/mu-plugins/waas-mail.php` with the guard (on restore, configure, suspend and resume). It reads `WAAS_MAIL_B64` and sets PHPMailer to SMTP. Without the variable (version sites, or the relay unset) it does nothing.
- The relay only sends from its verified domain, so every message goes out **from the store's own address on `STORE_MAIL_FROM`'s domain under the store's name** (the sender name a plugin set, else the site title); see [Each store's own address](#each-stores-own-address). The address the store meant to send from becomes the Reply-To, unless the message already has one or it is WordPress's placeholder `wordpress@<site>`. When none of that gives a Reply-To, it is the site's administration email, since nobody reads the store's address on the relay's domain.
- Each plugin's own sender settings are filled in to match; see [The plugins' own senders](#the-plugins-own-senders).
- Failures are written to the PHP error log (`WaaS store mail: …`), visible in the store's container logs.
- Existing stores: on startup the API gives every live store the current settings (`ensureStoreMail`, next to the cron check in `src/maintenance.ts`). A store whose variable already matches is left alone. One that needs it gets the variable, a re-rendered compose if it never had one, **one restart**, and the mu-plugin. Changing any setting (a new key) does the same for every store on the next deploy.

## Settings (on the API)

| Variable | Default | |
|---|---|---|
| `STORE_SMTP_PASSWORD` | | Turns store email on. For toSend: an API key (`tsend_…`) scoped to the sending domain only |
| `STORE_MAIL_FROM` | | Required with the password. An address on the domain verified with the relay, e.g. `no-reply@example.com` |
| `STORE_SMTP_HOST` | `smtp.tosend.com` | |
| `STORE_SMTP_PORT` | `587` | 465 uses implicit TLS; any other port STARTTLS |
| `STORE_SMTP_USER` | `tosend` | |
| `TOSEND_ADMIN_KEY` | | Optional. A toSend admin key (`tsend_admin_…`) with **Send email** on, write access to Domains and Sending keys, and read access to Emails. Gives each store its own sending key, lets stores send from their own domain, and counts each store's email (below). Without Send email, toSend refuses to create sending keys (403 `insufficient_scope`) and stores stay on the shared key |
| `TOSEND_API_URL` | `https://api.tosend.com` | |

## Setting up toSend

1. In toSend, add and verify your sending domain: add the DNS records it shows at your DNS host (in Cloudflare, DNS only) and wait until it shows as verified.
2. Create an API key scoped to that domain only. A domain-scoped key limits the damage if it ever leaks.
3. On the API, set `STORE_SMTP_PASSWORD` (the key) and `STORE_MAIL_FROM` (e.g. `no-reply@<your domain>`), then redeploy.

Check the toSend plan's sending limits against the stores' order and password-reset volume before selling at scale.

Another provider works the same way through its SMTP settings (`STORE_SMTP_HOST`, `_PORT`, `_USER`). Check its acceptable-use terms for what your stores sell first.

## Each store's own address

toSend's messages carry no key or account, only the From address, so each store sends from an address of its own; that is what lets the platform count each store's email (below). A store sends from `<name>@<STORE_MAIL_FROM's domain>`:

- `<name>` is the first part of the store's main domain when that is a name directly under `PLATFORM_DOMAIN` or `STORES_DOMAIN` (`volume-test-two.anypress.site` sends from `volume-test-two@anypress.io`).
- Otherwise, the first part of the store's base domain (`t-64e9c63d.stores.anypress.site` sends from `t-64e9c63d@anypress.io`). Also when the name is reserved (`no-reply`, `noreply`, `support`, `admin`, `billing`, `postmaster`, `abuse`, `hostmaster`, `webmaster`, `shop`, `app`, `mail`, `info`, `hello`), is the platform's own address, or another store has sent from it: an address is never shared by two stores.
- A store with its own verified sending domain keeps `no-reply@<its domain>` (below).
- The shop and the platform itself keep sending from `STORE_MAIL_FROM` (`no-reply@`).

The address follows the store's main domain: a change of address (`addTenantDomain` with `setAsMainDomain`, or the dashboard's Change address) moves its sender in the same job, with the restart the domain change already has. Moving to a new name on the same domain keeps the store's toSend key (keys are restricted to a domain, not an address). Every address a store sent from is kept in `tenant_mail_senders`, with when it stopped being used.

Existing stores move to their own address on the deploy that brings this (`ensureStoreMail` on startup), with one restart each; see [coolify.md](coolify.md#store-setup).

## The plugins' own senders

The Fluent plugins each keep a sender of their own (From name and address, Reply-To), show it in their settings and put it on their emails. The mail mu-plugin fills them in on a store's first page load, and again whenever what they hold changes: the store's name, its sending address (`WAAS_MAIL_B64`'s `from`, which moves to the owner's domain once that is verified), or its administration email, or when a plan switches a plugin on.

| Plugin | Where it keeps them |
|---|---|
| FluentCart | its email settings (`EmailNotifications`): `from_name`, `from_email`, `reply_to_name`, `reply_to_email` |
| FluentCRM | option `fluentcrm-global-settings`, `email_settings` (FluentBooking falls back to these only while its own are empty) |
| FluentBooking | option `_fluent_booking_settings`, `emailing` |
| Fluent Support | each web mailbox's `name` and `email` (its notices go to the mailbox's `admin_email_address`, the owner's email) |
| FluentAffiliate | its `global_email_settings`: `send_from_name`, `send_from_email`, `reply_to_name`, `reply_to_email` |
| FluentCommunity | its `global_email_settings`, the same four |
| FluentAuth | option `fa_system_email_settings`, `template_settings` |

The From is the site title and the sending address; the Reply-To is the site title and the administration email (left empty while the store has none).

A value the owner typed is kept: only empty values, the ones the mu-plugin set last time, and a From holding the administration email (what older stores got from the store template) are changed. What was set last is in the option `waas_mail_senders`. The recipients of the plugins' own notices (orders, forms, bookings, logins, support, affiliates) already follow the administration email through each plugin's `{wp.admin_email}` placeholder or the store template, and Fluent Forms' per-form senders are left empty, which sends under the site title from the sending address.

## The platform's count

A store counts its own email (the plan's monthly emails and email packs, see [coolify.md](coolify.md)), but a store administrator can edit that count. So the platform counts too, with `TOSEND_ADMIN_KEY`:

- Every hour (`src/mailcount.ts`, the `mail-count` queue), for each live store that is not suspended, it asks toSend how many emails each address the store used this calendar month (UTC) sent since the first of the month. Messages toSend accepted but never sent (`suppressed`, `failed`, `spam`) are not counted; `sent`, `bounced`, `complained` and `pending` are, as toSend bills them. A store or address that sent nothing costs one request.
- toSend's search matches the address anywhere in the sender, the subject or the recipients, so `acme@anypress.io` also matches `bigacme@anypress.io`. Every known address that contains another one, any store's or `STORE_MAIL_FROM` itself, has its own count taken off: count(`acme@`) = search(`acme@`) − count(`bigacme@`), the longer addresses counted first.
- The count is kept in `tenant_mail_usage` and shown on the dashboard's store page (`emailUsage`). When it changed, the store is told it (the agent's `mail-count` operation), and its plan goes by the higher of its own count and the platform's.
- Searches count against toSend's limit of 300 a minute: the job waits 250 ms between requests, and at a 429 it stops; the next run starts with the stores checked longest ago.
- What a store sent from `STORE_MAIL_FROM` before it moved to its own address is not counted by the platform (it says nothing about which store sent it); the store's own count still has it.

## Per-store keys

With `TOSEND_ADMIN_KEY` set, each store gets its own toSend sending key, named `store-<id>` and restricted to `STORE_MAIL_FROM`'s domain, in place of the shared `STORE_SMTP_PASSWORD`:

- A new store's key is minted at create; a retried create reuses the key it minted the first time. If toSend refuses, the store is created with the shared key and gets its own on the next API start.
- Existing stores move to their own key on the next API start (`ensureStoreMail`, one restart each).
- The key's id is kept on the store's Service as `WAAS_MAIL_KEY_ID`; deleting the store revokes the key first. A restored store gets a new key.
- To cut one store's email off, revoke its key in toSend.

The shared `STORE_SMTP_PASSWORD` is still required: it is what stores use without the admin key, and it keeps the setting that turns store email on in one place.

## A store's own sending domain

With `TOSEND_ADMIN_KEY` set, a store can send from its owner's domain (e.g. `no-reply@shop.example`) instead of `STORE_MAIL_FROM`. The dashboard (or `PUT /admin/tenants/{id}/mail-domain` with `{ "domainName": "shop.example" }`) adds it:

1. The API adds the domain on toSend and returns its DNS records: a DKIM `TXT` on `tosend._domainkey`, and an `MX` and SPF `TXT` on `send`. The owner adds them at their DNS host, by hand or, where the host supports it, with one click through [Domain Connect](domain-connect.md).
2. toSend checks DNS every 10 minutes. The API checks toSend on the same cadence (`src/maildomains.ts`, the `mail-domains` queue). Until the domain is verified the store keeps sending from `STORE_MAIL_FROM`, so its email never stops.
3. Once verified, the store gets a new key restricted to its domain, sends from `STORE_MAIL_FROM`'s name (`no-reply`) at it, and restarts once. The old key is revoked.
4. `DELETE /admin/tenants/{id}/mail-domain` moves the store back to `STORE_MAIL_FROM` within 10 minutes and removes the domain from toSend. A deleted store's domain is removed from toSend too.

Store owners can do the same from their account page on the storefront: the storefront plugin uses `GET`, `PUT` and `DELETE /v1/tenants/mail-domain?externalId=…` with its own API key ([openapi/store-mail.yaml](../openapi/store-mail.yaml)), which only reach that storefront's own stores.

A store has at most one sending domain. The platform's own domain and its subdomains are refused, as is a domain another store or another toSend account already has.

## Not covered yet

- A toSend team per customer (its own logs and suspension).
- The platform counts what a store sent, but the plan's limits are still applied in the store: a store owner who can run PHP in the store can get around them.
- An address in a message's subject or recipients (a store emailing another store's address) adds to that address's count.
- Without `TOSEND_ADMIN_KEY`, all stores share one key. A store admin cannot read it from wp-admin, but anyone able to run PHP in the store could.

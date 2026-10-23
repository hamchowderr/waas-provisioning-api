# Self-hosting

How to run the whole platform yourself: one VPS with Coolify, then more servers, then Kubernetes. The words used here (store, storefront, product, version) are explained in the [main README](../README.md#words-used-in-these-docs). Stage 0 is an optional test run on your own computer with no server. Each stage says what the code supports today and what it doesn't.

The platform is three repositories:

| Repository | What it is | Where it runs |
|---|---|---|
| [waas-provisioning-api](https://github.com/hamchowderr/waas-provisioning-api) | The provisioning API (Hono + pg-boss on Postgres). Creates, changes, backs up and deletes stores. | A container, next to Postgres 16 |
| [waas-dashboard](https://github.com/hamchowderr/waas-dashboard) | The admin dashboard (Next.js). Reads and changes everything through the API's `/admin/*`. | Vercel, or any Node host |
| [waas-plugins](https://github.com/hamchowderr/waas-plugins) | WordPress plugins: **WaaS Host** (turns a WordPress shop into the storefront that sells stores), **WaaS Client** (inside every store), **WaaS Payments** (Authorize.Net for FluentCart) | Your storefront WordPress, and each store |

```
 customer ──► storefront (WordPress + WaaS Host)
                 │  /v1 calls, Basic auth (API key + secret)
                 ▼
            provisioning API ──► Postgres (state + job queue)
                 │        └────► S3 bucket (snapshots, backups, DB backups)
                 │  Coolify API
                 ▼
            Coolify ──► one Service per store: WordPress + MariaDB + agent
                         Traefik routes <name>.<your domain>, Let's Encrypt certificates

 admin ──► dashboard ──► API /admin/* (Bearer ADMIN_TOKEN)
```

## Stage 0 (optional): test it on your own computer

No servers, no DNS. The API runs with the in-memory **fake provisioner**: every store operation succeeds at once and nothing is built.

```sh
git clone https://github.com/hamchowderr/waas-provisioning-api && cd waas-provisioning-api
export ADMIN_TOKEN=$(openssl rand -base64 32)   # turns on the admin API for the dashboard
docker compose up --build -d
docker compose exec api npm run create-key -- --product-name "Local storefront"
curl -u <key>:<secret> http://localhost:4111/v1/versions
```

Point a local storefront at it with `scripts/test-env.sh up` in waas-plugins (WordPress at http://127.0.0.1 with WaaS Host, WaaS Payments, FluentCart, WooCommerce and Subscriptions for WooCommerce), and the dashboard with `WAAS_API_URL=http://localhost:4111` and the same `ADMIN_TOKEN`. For UI work alone the dashboard also runs on sample data (`WAAS_API_FIXTURES=1`).

The fake provisioner builds no real stores, so a test order on the storefront never reaches **Ready**: WaaS Host waits until the store's address answers over HTTPS. Use Stage 0 to try the API, the dashboard and the storefront's settings, and Stage 1 to see a store go live.

## Stage 1: one VPS with Coolify

To do most of this stage with one command on a fresh server, use the [installer](../install/README.md). It can also make the server for you from your computer on Hostinger, Hetzner Cloud or DigitalOcean, with an API token from the provider.

This is how [AnyPress](https://anypress.io) runs: one server with [Coolify](https://coolify.io) v4, Cloudflare R2 for storage, toSend for email and Cloudflare DNS. The API uses `PROVISIONER=coolify`: each store is a Coolify Service with its own WordPress, MariaDB and agent containers ([coolify.md](coolify.md)).

### What you need

| | Used for | Example |
|---|---|---|
| A Linux VPS with Docker | Coolify, the API, the storefront and the stores | Ubuntu 24.04, 8 vCPU / 32 GB |
| A domain on a DNS host you control | Store names (`<name>.<domain>`), version sites | `anypress.io` on Cloudflare |
| An S3-compatible bucket | Snapshots, store backups, the API's database backups | Cloudflare R2, bucket `waas-stores` |
| A second bucket (optional) | Signed plugin releases for the update channel | R2, bucket `waas-releases` |
| An SMTP relay (optional) | Store email (receipts, password resets) | [toSend](https://tosend.com) |

Stores come in three sizes, set per store (`size` on `POST`/`PUT /v1/tenants`, or per plan on the storefront): **small** (1 CPU, 512 MB, 5 GB storage, 5,000 emails a month), **medium** (2 CPU, 512 MB, 10 GB, 20,000) and **large** (4 CPU, 768 MB, 25 GB, 50,000). Every size also has a 384 MB MariaDB and a 256 MB agent container. Details in [coolify.md](coolify.md).

Measured sizes (Docker stats, real images and plugins): a small store uses about **273 MB** warm and peaks near 414 MB under load. Limits cap a busy store; they are not reservations. Keeping room for Coolify and the platform itself, a 32 GB server holds roughly **55 to 68** normal stores. Disk is not the bound: about 150 MB per store plus its uploads and database.

### 1. Install Coolify

Install Coolify v4 (AnyPress runs v4.4.6) with its installer on the VPS, or start from a server image that already has it: Hostinger's **Ubuntu 24.04 with Coolify** VPS template, Hetzner Cloud's **Coolify** app, or the DigitalOcean Marketplace's Coolify 1-Click. To skip Coolify's public sign-up page, create its first user during the install:

```sh
env ROOT_USERNAME=admin ROOT_USER_EMAIL=you@example.com ROOT_USER_PASSWORD='<a strong password>' \
  bash -c 'curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash'
```

Open its dashboard over HTTPS and keep its proxy on **Traefik** with the default Let's Encrypt (HTTP-01) resolver. Turn on **Settings → Advanced → API Access**: a self-hosted Coolify refuses every API call until it is on, and the API drives Coolify only through its API. Create three projects:

- **WaaS API**: the API and its database.
- **WaaS Stores**: the stores. The API creates environments `stores` and `versions` in it and never touches anything outside this project.
- **WaaS Storefront**: your storefront, the WordPress site that sells the stores.

### 2. DNS

In your domain's zone, all records **DNS only** (on Cloudflare: grey cloud), so Traefik terminates TLS and gets certificates itself:

| Type | Name | Content |
|---|---|---|
| A | `*` | your VPS IP |
| A | `*.stores` | your VPS IP |
| A | `*.versions` | your VPS IP |
| A | `api`, `app` (or your own names) | your VPS IP, or your dashboard host |

Customers' stores answer on `<website name>.<domain>`. Each store also keeps an internal name `t-<id8>.stores.<domain>`, and template versions live on `<slug>.versions.<domain>`. Leave out AAAA records until IPv6 to the VPS is confirmed working: Let's Encrypt prefers IPv6, and a broken AAAA fails every certificate.

Per-hostname HTTP-01 certificates are fine below about 40 new stores a week (Let's Encrypt's limit is 50 per registered domain per week). Past that, switch to one wildcard certificate through DNS-01 (Cloudflare shown):

1. Create a Cloudflare API token with **Zone:DNS:Edit** on your zone only.
2. In Coolify → Servers → your server → Proxy, add `CF_DNS_API_TOKEN=<token>` to the proxy's environment and these lines to its command, then restart the proxy (this briefly interrupts every site on the server):
   ```
   - '--certificatesresolvers.cloudflare.acme.dnschallenge=true'
   - '--certificatesresolvers.cloudflare.acme.dnschallenge.provider=cloudflare'
   - '--certificatesresolvers.cloudflare.acme.storage=/traefik/acme.json'
   ```
3. Add a dynamic configuration that asks the `cloudflare` resolver for `stores.<domain>` with the extra name `*.stores.<domain>` (and the same for `<domain>` itself if you name stores directly under it).

Customers' own domains keep using HTTP-01.

### 3. Object storage

Create a private bucket and an API token with **Object Read & Write on that bucket only**. Add a lifecycle rule that deletes `uploads/` after 7 days. The API signs every request itself and hands stores 15-minute pre-signed URLs, so stores never hold bucket credentials.

For the dashboard's archive uploads (new versions and templates), the browser `PUT`s straight to the bucket: add a CORS rule allowing `PUT` from your dashboard's address.

### 4. The API

In the **WaaS API** project:

1. Add a **PostgreSQL 16** database. Keep it private.
2. Add an application from the waas-provisioning-api repository (or your fork), branch `main`, build pack **Dockerfile**, port `4111`, health check `GET /health`, on your API domain (e.g. `https://api.<domain>`).
3. Create a Coolify API token with **read, read:sensitive, write and deploy** (not root). Without `read:sensitive`, Coolify hides the store agent's output and every store create fails.
4. Set the environment variables below and deploy. Migrations run at startup.

| Variable | Value |
|---|---|
| `DATABASE_URL` | the database's internal URL |
| `SECRETS_KEY` | `openssl rand -base64 32`. Encrypts store passwords, private constants and the database backups, and each store's site key for agent site editing is derived from it. **Keep a copy off the server**: lose it and those values can't be read |
| `ADMIN_TOKEN` | `openssl rand -base64 32`. Turns on `/admin/*` for the dashboard |
| `PROVISIONER` | `coolify` |
| `COOLIFY_URL`, `COOLIFY_TOKEN` | your Coolify address and the token from step 3 (the token can be left unset only when a proxy in front of Coolify adds credentials) |
| `COOLIFY_SERVER_UUID` | the server new stores go to (Servers → your server) |
| `COOLIFY_PROJECT_UUID` | the **WaaS Stores** project |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | the bucket from section 3 (`S3_REGION=auto` for R2) |
| `PLATFORM_DOMAIN` | the domain stores are named under, e.g. `anypress.site`. Reserves the apex and names like `www`, `api`, `app` |
| `BRAND_DOMAIN` | your own domain when stores live on a separate one, e.g. `anypress.io`. No store can take it or any name under it. Keep your sign-in sites (storefront, dashboard) here, not under `PLATFORM_DOMAIN`: stores under the same domain could set their cookies. Turning it on only stops new addresses: give each store already under it an address under `PLATFORM_DOMAIN` and make that its main address first |
| `PUBLIC_URL` | the API's own address, e.g. `https://api.anypress.io`, for MCP clients signing in with OAuth |
| `AUTH_URL`, `AUTH_SECRET` | the dashboard's address (e.g. `https://app.<domain>`) and `openssl rand -base64 32`. Turns on dashboard sign-in. With store email set up (section 8), people sign in with an emailed link and nothing else is needed; GitHub and Google sign-in are optional ([accounts.md](accounts.md)) |
| `STORES_DOMAIN`, `VERSIONS_DOMAIN` | `stores.<domain>`, `versions.<domain>` |
| `STORE_BRAND_NAME`, `STORE_BRAND_URL` | the name (and optional link) on a suspended store's "website unavailable" page. Without them the page credits AnyPress |

With the `S3_*` values set, the API also backs up its own database to the bucket every night, encrypted ([db-backups.md](db-backups.md)), and backs up every live store every night ([store-backups.md](store-backups.md)).

Create the storefront's API key in the application's Terminal: `npm run create-key -- --product-name "My storefront"`. It prints the key and secret once.

One host cron job keeps Coolify's own database small: each store runs a `wp-cron` task every minute, and Coolify keeps 60 days of task history. To keep 7 days, open a root shell on the server (Coolify → Servers → your server → Terminal), run `crontab -e` and add:

```
23 4 * * * docker exec coolify-db psql -U coolify -d coolify -c "DELETE FROM scheduled_task_executions WHERE created_at < now() - interval '7 days'" > /dev/null 2>&1
```

Run the `docker exec …` part once by hand first: it prints `DELETE <n>`. It only removes the history of past task runs.

### 5. A template version

Stores are copies of a template version. Three templates ship in `templates/`, each with a `build.sh` that builds the archive and a `publish.sh` that uploads it through the API and creates a version from it:

| Template | What it is |
|---|---|
| [`starter-fluentcart`](../templates/starter-fluentcart/README.md) | The smallest store: WordPress, WaaS Client, FluentCart, Twenty Twenty-Five |
| [`anypress-store`](../templates/anypress-store/README.md) | The full store AnyPress sells: the Fluent plugins, SEO and automation on the Ollie theme, with one role per site type (website, bookings, store, community and courses, everything) in `roles.json` |
| [`seller-storefront`](../templates/seller-storefront/README.md) | Not a store: the ready-made storefront (section 6) |

`publish.sh` needs `WAAS_API_URL` (your API's address) and a product key and secret (`WAAS_KEY`, `WAAS_SECRET`). You can also upload an archive from the dashboard's **Versions & templates** page. Make one version **production**: new stores use it.

Prebuilt archives of `anypress-store` and `seller-storefront`, with their checksums, are on this repository's [`templates-v*` releases](https://github.com/hamchowderr/waas-provisioning-api/releases) (built by `templates/release.sh`). The [installer](../install/README.md) publishes the newest one for you.

### 6. The storefront

Any WordPress site with **FluentCart** 1.7+ (recommended) or **WooCommerce** with WP Swings' Subscriptions for WooCommerce. Install **WaaS Host** (and **WaaS Payments** for Authorize.Net on FluentCart). Then:

1. In `wp-config.php`, set `WAAS_HOST_KEY_ENCRYPTION_KEY` (`openssl rand -base64 48`) and keep it stable.
2. In **WaaS → Settings**, enter the **API URL**, **API key** and **API secret** on the **Connection** tab (or use the `WAAS_API_BASE_URL` constant), and set **Website domain** to your domain on the **Websites** tab, so customers' stores are named `<website name>.<domain>`. Use the same domain as the API's `PLATFORM_DOMAIN`.
3. Make a subscription product and add WaaS Provisioning to it (FluentCart: the product's **Integrations**; WooCommerce: the WaaS product option), with its role (site type), size and snapshot group.

**Or let the API build the storefront.** Publish `templates/seller-storefront` as the production version of a product of its own, set `STOREFRONT_PRODUCT_ID` to that product's id (and `PUBLIC_URL`), and `POST /admin/products/{productId}/storefront` builds a store that is already a connected storefront for that product: WaaS Host installed, the API key and encryption key in wp-config, the website domain set, and the owner made an administrator. Its owner then connects a payment method in FluentCart and makes the subscription products. Details in [the template's README](../templates/seller-storefront/README.md).

The storefront needs a real cron: FluentCart creates stores in the background through Action Scheduler, which otherwise waits for the next page visit. Define `DISABLE_WP_CRON` and run `wp action-scheduler run` and `wp cron event run --due-now` every minute (a Coolify scheduled task works).

### 7. The dashboard

Deploy waas-dashboard to Vercel, or to any host with Node 22 or newer, such as a Coolify application in the **WaaS API** project (`npm ci && npm run build && npm start`, port 3000). Sign-in runs on the API, so the API needs `AUTH_URL` (this dashboard's address) and `AUTH_SECRET` from section 4. On the dashboard set:

- `WAAS_API_URL`: the API's address.
- `WAAS_ADMIN_TOKEN`: the API's `ADMIN_TOKEN`.
- `ALLOWED_ADMIN_EMAILS`: your own email address (comma separated for more). These people see every storefront.
- `AUTH_PROVIDERS` (optional): `email` by default, an emailed sign-in link. Add `github` or `google` once the API has their keys.

Sign in with your email address. Add a CORS rule on the bucket allowing `PUT` from the dashboard's address for archive uploads. Details in its [README](https://github.com/hamchowderr/waas-dashboard#set-it-up).

### 8. Email

Stores have no mailer of their own. To give them one, verify your domain with toSend (or any SMTP relay) and set `STORE_SMTP_PASSWORD` and `STORE_MAIL_FROM` (e.g. `no-reply@<domain>`) on the API. Every store gets the settings on the next deploy. With a toSend admin key in `TOSEND_ADMIN_KEY`, each store gets its own sending key, and a store owner can send from their own domain after adding three DNS records. All of it: [store-email.md](store-email.md).

### 9. Watch it

- `GET /health` answers 200 when Postgres and the queue respond, and 503 otherwise. Point an uptime monitor at it (UptimeRobot, for example). Its `dbBackup.stale` turns true when the last database backup is over 26 hours old.
- `/health`'s `jobs.ok` turns false while a store or version job has failed its last retry in the last 24 hours and hasn't been retried. A keyword monitor on `"jobs":{"ok":true` alerts you through the monitor's own channels. The API also emails each failure to `JOB_ALERT_EMAILS` (comma-separated), or to `APPLICATION_NOTIFY_EMAILS` when that's unset, through the sign-in email settings.
- `/health`'s `restoreTest.ok` turns false when last night's restore test of a store's backup failed, or none passed in about two days ([store-backups.md](store-backups.md#restore-test-nightly)). A keyword monitor on `"restoreTest":{"ok":true` alerts on it; failures are emailed to the same addresses.
- The dashboard's **Jobs** page shows failed jobs with their errors, and retries them.

### Customers' own domains

A customer can point their own domain at their store. They add a `CNAME` to the store's `t-<id8>.stores.<domain>` (or an `A` record to the VPS for an apex domain), then the domain is added from the storefront's account page or the dashboard (**Change address**). The API adds it to the store's Service, Traefik gets its certificate over HTTP-01, and the store's URLs are rewritten. The old address keeps answering with a 301.

With Domain Connect, customers whose DNS host supports it add these records (and their sending domain's) with one click instead of copying them. It needs your own templates accepted by the DNS hosts and a signing key: [domain-connect.md](domain-connect.md).

### Plugin updates

Storefronts update WaaS Host and WaaS Payments from the API (`/v1/plugins/{slug}/update`), never from wordpress.org. Each release is signed with ed25519 and the plugins only install releases signed by a key built into them (`Updater::PUBLIC_KEYS` in waas-plugins). If you run your own channel, generate your own release key, put its public half in `Updater::PUBLIC_KEYS`, sign with the private half (`WAAS_RELEASE_SIGNING_KEY` in the release workflow), and set `RELEASES_S3_BUCKET` on the API. Otherwise set `WAAS_UPDATE_CHANNEL` to `off` in the storefront's `wp-config.php` and install release zips by hand. waas-plugins' `docs/releases.md` has the details.

## Stage 2: more servers

When one server is full, add another to Coolify (Servers → Add, over SSH) and set `COOLIFY_SERVER_UUID` on the API to the new server. New stores and versions are created there. Existing stores keep running where they are: the API finds every store by its Service name in the **WaaS Stores** project, whatever server it is on.

What isn't built yet:

- The API sends new stores to one server at a time. It doesn't spread stores across servers or pick the emptiest one.
- Moving a store between servers is by hand: back it up, delete it, and restore it with the new server configured.
- The API, its database and the storefront stay on the first server. A dead first server stops provisioning, but stores on other servers keep serving.


## Stage 3: Kubernetes

Not supported for stores yet. Here is what works today and what a Kubernetes driver needs.

**The API and dashboard run on Kubernetes today.** Both are plain containers:

- API: the repository's `Dockerfile`, port 4111, readiness and liveness on `GET /health`, environment from a Secret, Postgres 16 from a managed service or an operator (CloudNativePG, for example). Run **one replica**: jobs are safe to share through pg-boss, but the startup checks (store cron, store email, catch-up backups) have only been run from one instance.
- Dashboard: `npm run build && npm start` in a Node 22 image, behind your Ingress, with the environment from section 7.

**Stores need a new provisioner.** All store-side work goes through the `Provisioner` interface (`src/provisioner/provisioner.ts`), and the only real implementation drives Coolify. A `PROVISIONER=kubernetes` would implement the same methods with Kubernetes objects. A sketch of the mapping, not built:

| Today on Coolify | On Kubernetes |
|---|---|
| One Service per store (`store-<id>`) in project WaaS Stores | One Namespace per store, or one per server-sized pool, labelled with the store id |
| WordPress + MariaDB + agent containers, each with a memory limit | A Deployment (WordPress + agent sidecar sharing the `wp-content` volume) and a MariaDB StatefulSet, each with PVCs and the same limits |
| Coolify environment variables (`WAAS_CONSTANTS_B64`, `WAAS_MAIL_B64`, `WAAS_SITE_KEY`) | A Secret per store, mounted as environment |
| Traefik routers on the Service's domains, Let's Encrypt HTTP-01 | An Ingress per store with cert-manager; a wildcard certificate for `*.<domain>` through DNS-01 |
| Commands as on-demand Coolify scheduled tasks in the agent | `kubectl exec` (the exec API) into the agent sidecar, running the same `agent.php` and WP-CLI commands |
| The `wp-cron` scheduled task every minute | A CronJob per store, or one loop in the agent sidecar |
| Separate Docker network per store | A NetworkPolicy that denies traffic between stores and to the platform |
| Coolify's own restart and status | Rollout status and readiness probes |

Most of the work is already outside Coolify: the archive format, `agent.php`, the guard mu-plugin, backups to S3 through pre-signed URLs and the job queue all stay the same. Kubernetes is the sensible next step past a handful of Coolify servers, when stores need spreading and moving automatically. Until then, Stage 2 is simpler to run.

## Settings reference

Everything the API reads, in `src/config.ts` and the modules it loads:

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | Postgres 16+ |
| `SECRETS_KEY` | required | 32 random bytes, base64 |
| `PORT` | `4111` | |
| `ADMIN_TOKEN` | off | Turns on `/admin/*` |
| `PROVISIONER` | `fake` | `fake` or `coolify` |
| `COOLIFY_URL`, `COOLIFY_TOKEN`, `COOLIFY_SERVER_UUID`, `COOLIFY_PROJECT_UUID` | | With `PROVISIONER=coolify` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | `S3_REGION=auto` | Store archives and backups; also turns on database backups |
| `STORES_DOMAIN`, `VERSIONS_DOMAIN` | `stores.waas.example`, `versions.waas.example` | |
| `PLATFORM_DOMAIN` | off | Reserves the platform's own names; also turns on Domain Connect |
| `AUTH_URL`, `AUTH_SECRET` | off | Dashboard sign-in. With `AUTH_GITHUB_ID`/`_SECRET`, `AUTH_GOOGLE_ID`/`_SECRET`, `AUTH_MAIL_KEY`, `AUTH_MAIL_FROM`, `AUTH_BRAND` ([accounts.md](accounts.md)) |
| `BRAND_DOMAIN` | off | Reserves this domain and every name under it |
| `DOMAIN_CONNECT`, `DOMAIN_CONNECT_PRIVATE_KEY`, `DOMAIN_CONNECT_KEY_HOST`, `DOMAIN_CONNECT_PROVIDER_ID`, `DOMAIN_CONNECT_IPV6` | on with `PLATFORM_DOMAIN` or `BRAND_DOMAIN`, none, `_dck1`, `BRAND_DOMAIN` else `PLATFORM_DOMAIN`, none | [domain-connect.md](domain-connect.md) |
| `STORE_BRAND_NAME`, `STORE_BRAND_URL` | AnyPress | The suspended-store page |
| `BACKUP_RETENTION_DAYS` | `90` | How long a deleted store's backups are kept |
| `PUBLIC_URL` | each request's own origin | The API's public URL, e.g. `https://api.anypress.io`: the OAuth issuer and the MCP server's address for MCP clients ([mcp/README.md](../mcp/README.md)). Set it in production |
| `STOREFRONT_PRODUCT_ID` | off | The product whose production version is the [seller storefront template](../templates/seller-storefront/README.md). Turns on ready-made storefronts (`POST /admin/products/{productId}/storefront`). Set `PUBLIC_URL` too: it is the address written into each storefront |
| `APPLICATION_NOTIFY_EMAILS` | off | Comma-separated addresses emailed when someone applies to sell (`POST /applications`, [accounts](accounts.md#applications-to-sell)). Needs sign-in email. Without it, applications only show on the dashboard |
| `JOB_ALERT_EMAILS` | `APPLICATION_NOTIFY_EMAILS` | Comma-separated addresses emailed when a store or version job fails its last retry, with a link to the dashboard's failed jobs. Needs sign-in email |
| `DASHBOARD_DOMAINS` | off | Lets sellers give the dashboard their own address ([branding](branding.md#your-own-dashboard-address)). `vercel` for a dashboard on Vercel: needs `VERCEL_TOKEN` (with access to the dashboard project's team), `VERCEL_PROJECT_ID` and, for a team project, `VERCEL_TEAM_ID`; Vercel lets a Pro team add 100 domains an hour. `coolify` for a dashboard that is a Coolify application: needs `COOLIFY_URL`, `COOLIFY_TOKEN`, `DASHBOARD_COOLIFY_APP` (the application's UUID) and `DASHBOARD_TARGET` (the dashboard's own hostname, which sellers point a CNAME at). The installer sets these for either |
| `REQUEST_LOG_DAYS` | `30` | How long the request log (`GET /admin/requests`) keeps each call; `0` turns it off |
| `WEBHOOK_LOG_DAYS` | `30` | How long webhook events and deliveries are kept ([webhooks.md](webhooks.md)) |
| `WEBHOOK_ALLOW_PRIVATE` | off | `true` lets webhook endpoints be `http://` and on private addresses, for an API on a private network |
| `DB_BACKUP`, `DB_BACKUP_SCHEDULE`, `DB_BACKUP_PREFIX`, `DB_BACKUP_KEEP_DAILY`, `DB_BACKUP_KEEP_WEEKLY` | on, 02:30 UTC, `db-backups/`, 14, 8 | [db-backups.md](db-backups.md) |
| `STRIPE_SECRET_KEY`, `RESELLER_INVOICE`, `RESELLER_INVOICE_SCHEDULE`, `RESELLER_INVOICE_DAYS_DUE` | off, on with a key, 07:00 UTC on the 1st, 14 | Resellers' monthly bill as a Stripe invoice ([resellers.md](resellers.md#automatic-invoices)) |
| `STORE_BACKUP`, `STORE_BACKUP_SCHEDULE`, `STORE_BACKUP_KEEP_DAILY`, `STORE_BACKUP_KEEP_WEEKLY` | on, 09:00 UTC, 7, 4 | [store-backups.md](store-backups.md) |
| `RESTORE_TEST`, `RESTORE_TEST_SCHEDULE` | on, 11:00 UTC | [store-backups.md](store-backups.md#restore-test-nightly) |
| `STORE_SMTP_PASSWORD`, `STORE_MAIL_FROM`, `STORE_SMTP_HOST`, `STORE_SMTP_PORT`, `STORE_SMTP_USER` | off, none, `smtp.tosend.com`, `587`, `tosend` | [store-email.md](store-email.md) |
| `TOSEND_ADMIN_KEY`, `TOSEND_API_URL` | off, `https://api.tosend.com` | Per-store keys and stores' own sending domains |
| `RELEASES_S3_BUCKET` and `RELEASES_S3_*` | off | The plugin update channel; the other values default to `S3_*` |

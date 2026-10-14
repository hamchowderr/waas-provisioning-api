# Self-hosting

How to run the whole platform yourself: one VPS with Coolify, then more servers, then Kubernetes. Stage 0 is an optional test run on your own computer with no server. Each stage says what the code supports today and what it doesn't.

The platform is three repositories:

| Repository | What it is | Where it runs |
|---|---|---|
| [waas-provisioning-api](https://github.com/hamchowderr/waas-provisioning-api) | The provisioning API (Hono + pg-boss on Postgres). Creates, changes, backs up and deletes stores. | A container, next to Postgres 16 |
| [waas-dashboard](https://github.com/hamchowderr/waas-dashboard) | The admin dashboard (Next.js). Reads and changes everything through the API's `/admin/*`. | Vercel, or any Node host |
| [waas-plugins](https://github.com/hamchowderr/waas-plugins) | WordPress plugins: **WaaS Host** (the storefront that sells websites), **WaaS Client** (inside every store), **WaaS Payments** (Authorize.Net for FluentCart) | Your storefront WordPress, and each store |

```
 customer ──► storefront (WordPress + WaaS Host)
                 │  WPCS v1 calls, Basic auth (API key + secret)
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

The fake provisioner builds no real websites, so a test order on the storefront never reaches **Ready**: WaaS Host waits until the website's address answers over HTTPS. Use Stage 0 to try the API, the dashboard and the storefront's settings, and Stage 1 to see a website go live.

## Stage 1: one VPS with Coolify

This is how [AnyPress](https://anypress.io) runs: one server with [Coolify](https://coolify.io) v4, Cloudflare R2 for storage, toSend for email and Cloudflare DNS. The API uses `PROVISIONER=coolify`: each store is a Coolify Service with its own WordPress, MariaDB and agent containers ([coolify.md](coolify.md)).

### What you need

| | Used for | Example |
|---|---|---|
| A Linux VPS with Docker | Coolify, the API, the storefront and the stores | Ubuntu 24.04, 8 vCPU / 32 GB |
| A domain on a DNS host you control | Store names (`<name>.<domain>`), version sites | `anypress.io` on Cloudflare |
| An S3-compatible bucket | Snapshots, store backups, the API's database backups | Cloudflare R2, bucket `waas-stores` |
| A second bucket (optional) | Signed plugin releases for the update channel | R2, bucket `waas-releases` |
| An SMTP relay (optional) | Store email (receipts, password resets) | [toSend](https://tosend.com) |

Measured sizes (Docker stats, real images and plugins): a store uses about **273 MB** warm and peaks near 414 MB under load; its limits are 512 MB / 1 CPU (WordPress), 384 MB (MariaDB), 256 MB (agent). Keeping room for Coolify and the platform itself, a 32 GB server holds roughly **55 to 68** normal stores. Disk is not the bound: about 150 MB per store plus its uploads and database.

### 1. Install Coolify

Follow Coolify's installer on the VPS, open its dashboard over HTTPS, and keep its proxy on **Traefik** with the default Let's Encrypt (HTTP-01) resolver. Create three projects:

- **WaaS API**: the API and its database.
- **WaaS Stores**: the stores. The API creates environments `stores` and `versions` in it and never touches anything outside this project.
- **WaaS Storefront**: your storefront, the WordPress site that sells the websites.

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
| `SECRETS_KEY` | `openssl rand -base64 32`. Encrypts store passwords, private constants and the database backups. **Keep a copy off the server**: lose it and those values can't be read |
| `ADMIN_TOKEN` | `openssl rand -base64 32`. Turns on `/admin/*` for the dashboard |
| `PROVISIONER` | `coolify` |
| `COOLIFY_URL`, `COOLIFY_TOKEN` | your Coolify address and the token from step 3 (the token can be left unset only when a proxy in front of Coolify adds credentials) |
| `COOLIFY_SERVER_UUID` | the server new stores go to (Servers → your server) |
| `COOLIFY_PROJECT_UUID` | the **WaaS Stores** project |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | the bucket from section 3 (`S3_REGION=auto` for R2) |
| `PLATFORM_DOMAIN` | the domain stores are named under, e.g. `anypress.site`. Reserves the apex and names like `www`, `api`, `app` |
| `BRAND_DOMAIN` | your own domain when stores live on a separate one, e.g. `anypress.io`. No store can take it or any name under it. Keep your sign-in sites (storefront, dashboard) here, not under `PLATFORM_DOMAIN`: stores under the same domain could set their cookies |
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

Stores are copies of a template version. `templates/starter-fluentcart/build.sh` builds the starter (WordPress, WaaS Client, FluentCart, Twenty Twenty-Five) and `publish.sh` uploads it through the API and creates a version from it. `publish.sh` needs `WAAS_API_URL` (your API's address) and a product key and secret (`WAAS_KEY`, `WAAS_SECRET`). You can also upload an archive from the dashboard's **Versions & templates** page. Make one version **production**: new stores use it.

### 6. The storefront

Any WordPress site with **FluentCart** 1.7+ (recommended) or **WooCommerce** with WP Swings' Subscriptions for WooCommerce. Install **WaaS Host** (and **WaaS Payments** for Authorize.Net on FluentCart). Then:

1. In `wp-config.php`, set `WAAS_HOST_KEY_ENCRYPTION_KEY` (`openssl rand -base64 48`) and keep it stable.
2. In **WaaS → Settings**, enter the **API URL**, **API key** and **API secret** on the **Connection** tab (or use the `WAAS_API_BASE_URL` constant), and set **Website domain** to your domain on the **Websites** tab, so customers' stores are named `<website name>.<domain>`. Use the same domain as the API's `PLATFORM_DOMAIN`.
3. Make a subscription product and add WaaS Provisioning to it (FluentCart: the product's **Integrations**; WooCommerce: the WaaS product option), with its role and snapshot group.

The storefront needs a real cron: FluentCart creates stores in the background through Action Scheduler, which otherwise waits for the next page visit. Define `DISABLE_WP_CRON` and run `wp action-scheduler run` and `wp cron event run --due-now` every minute (a Coolify scheduled task works).

### 7. The dashboard

Deploy waas-dashboard to Vercel, or to any host with Node 22 or newer (`npm run build && npm start`, plus `AUTH_TRUST_HOST=true` off Vercel). Create a GitHub App (or OAuth app) for sign-in with callback `https://<dashboard>/api/auth/callback/github`, and set `WAAS_API_URL`, `WAAS_ADMIN_TOKEN` (the API's `ADMIN_TOKEN`), `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` and `ALLOWED_GITHUB_LOGINS`. Details in its README.

### 8. Email

Stores have no mailer of their own. To give them one, verify your domain with toSend (or any SMTP relay) and set `STORE_SMTP_PASSWORD` and `STORE_MAIL_FROM` (e.g. `no-reply@<domain>`) on the API. Every store gets the settings on the next deploy. With a toSend admin key in `TOSEND_ADMIN_KEY`, each store gets its own sending key, and a store owner can send from their own domain after adding three DNS records. All of it: [store-email.md](store-email.md).

### 9. Watch it

- `GET /health` answers 200 when Postgres and the queue respond, and 503 otherwise. Point an uptime monitor at it (UptimeRobot, for example). Its `dbBackup.stale` turns true when the last database backup is over 26 hours old.
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
- Dashboard: `npm run build && npm start` in a Node 22 image, behind your Ingress, with `AUTH_TRUST_HOST=true`.

**Stores need a new provisioner.** All store-side work goes through the `Provisioner` interface (`src/provisioner/provisioner.ts`), and the only real implementation drives Coolify. A `PROVISIONER=kubernetes` would implement the same methods with Kubernetes objects. A sketch of the mapping, not built:

| Today on Coolify | On Kubernetes |
|---|---|
| One Service per store (`store-<id>`) in project WaaS Stores | One Namespace per store, or one per server-sized pool, labelled with the store id |
| WordPress + MariaDB + agent containers, each with a memory limit | A Deployment (WordPress + agent sidecar sharing the `wp-content` volume) and a MariaDB StatefulSet, each with PVCs and the same limits |
| Coolify environment variables (`WAAS_CONSTANTS_B64`, `WAAS_MAIL_B64`) | A Secret per store, mounted as environment |
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
| `BRAND_DOMAIN` | off | Reserves this domain and every name under it |
| `DOMAIN_CONNECT`, `DOMAIN_CONNECT_PRIVATE_KEY`, `DOMAIN_CONNECT_KEY_HOST`, `DOMAIN_CONNECT_PROVIDER_ID` | on with `PLATFORM_DOMAIN` or `BRAND_DOMAIN`, –, `_dck1`, `BRAND_DOMAIN` else `PLATFORM_DOMAIN` | [domain-connect.md](domain-connect.md) |
| `STORE_BRAND_NAME`, `STORE_BRAND_URL` | AnyPress | The suspended-store page |
| `BACKUP_RETENTION_DAYS` | `90` | How long a deleted store's backups are kept |
| `DB_BACKUP`, `DB_BACKUP_SCHEDULE`, `DB_BACKUP_PREFIX`, `DB_BACKUP_KEEP_DAILY`, `DB_BACKUP_KEEP_WEEKLY` | on, 02:30 UTC, `db-backups/`, 14, 8 | [db-backups.md](db-backups.md) |
| `STORE_BACKUP`, `STORE_BACKUP_SCHEDULE`, `STORE_BACKUP_KEEP_DAILY`, `STORE_BACKUP_KEEP_WEEKLY` | on, 09:00 UTC, 7, 4 | [store-backups.md](store-backups.md) |
| `STORE_SMTP_PASSWORD`, `STORE_MAIL_FROM`, `STORE_SMTP_HOST`, `STORE_SMTP_PORT`, `STORE_SMTP_USER` | off, –, `smtp.tosend.com`, `587`, `tosend` | [store-email.md](store-email.md) |
| `TOSEND_ADMIN_KEY`, `TOSEND_API_URL` | off, `https://api.tosend.com` | Per-store keys and stores' own sending domains |
| `RELEASES_S3_BUCKET` and `RELEASES_S3_*` | off | The plugin update channel; the other values default to `S3_*` |

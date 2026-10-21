# Installer

`anypress-install.sh` sets up AnyPress on one fresh Ubuntu server (22.04 or 24.04, 4 GB RAM or more): it does
Stage 1 of the [self-hosting guide](../docs/self-hosting.md#stage-1-one-vps-with-coolify) for you, except DNS.

```sh
curl -fsSLO https://raw.githubusercontent.com/hamchowderr/waas-provisioning-api/main/install/anypress-install.sh
curl -fsSL https://raw.githubusercontent.com/hamchowderr/waas-provisioning-api/main/install/anypress.env.example -o /root/anypress.env
nano /root/anypress.env        # your domains, email and storage bucket, and optionally email keys
sudo bash anypress-install.sh
```

It works on a plain server and on one that already runs Coolify (Hostinger's Coolify template, Hetzner's Coolify
app, DigitalOcean's Coolify 1-Click).

## What it does

1. Installs Coolify (4.4.6 unless `ANYPRESS_COOLIFY_VERSION` says otherwise), with your email as its admin, so its
   sign-up page is never open.
2. Turns on Coolify's API and makes the token the provisioning API uses (or uses `COOLIFY_TOKEN` if you give one).
3. Creates the projects **WaaS API**, **WaaS Stores** and **WaaS Storefront**, and Postgres 16 in WaaS API.
4. Deploys the provisioning API on `api.<brand domain>` with generated secrets, and waits for `/health`.
5. Makes an API key for your storefront.
6. Publishes the store template and the storefront template from the newest
   [templates release](https://github.com/hamchowderr/waas-provisioning-api/releases) (checksums checked), and makes
   each the production version. New stores are made from the store template.
7. Builds your storefront: a WordPress site with WaaS Host and FluentCart, already connected to the API, with you as
   its administrator.
8. Deploys the dashboard on `app.<brand domain>`, with you as its admin.
9. Adds the daily job that keeps Coolify's task history to 7 days.
10. Prints the DNS records to add and the storefront's address.

Passwords, keys and the storefront's key go to `/root/anypress/credentials.env` (root only). Keep a copy of
`SECRETS_KEY` somewhere safe: without it, store passwords and database backups can't be read.

Running it again is safe: it finds what it made before (`/root/anypress/state.env`) and only updates settings. When
there is a newer templates release, it publishes that one and makes it production.

## After it finishes

1. Add the DNS records it printed.
2. Open the storefront's wp-admin (linked on the dashboard's **API keys** page), connect Stripe in FluentCart and make the plans
   customers buy, each with WaaS Provisioning added ([section 6](../docs/self-hosting.md#6-the-storefront)).
3. Run `sudo bash anypress-install.sh check`: it checks Coolify, the API, the dashboard, DNS, HTTPS and email,
   and says which still fail.

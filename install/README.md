# Installer

`anypress-install.sh` sets up AnyPress on one fresh Ubuntu server (22.04 or 24.04, 4 GB RAM or more): it does
Stage 1 of the [self-hosting guide](../docs/self-hosting.md#stage-1-one-vps-with-coolify) for you, except DNS,
the store template and the storefront.

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
6. Deploys the dashboard on `app.<brand domain>`, with you as its admin.
7. Adds the daily job that keeps Coolify's task history to 7 days.
8. Prints the DNS records to add.

Passwords, keys and the storefront's key go to `/root/anypress/credentials.env` (root only). Keep a copy of
`SECRETS_KEY` somewhere safe: without it, store passwords and database backups can't be read.

Running it again is safe: it finds what it made before (`/root/anypress/state.env`) and only updates settings.

## After it finishes

1. Add the DNS records it printed.
2. Publish a store template ([section 5](../docs/self-hosting.md#5-a-template-version)).
3. Set up the storefront ([section 6](../docs/self-hosting.md#6-the-storefront)) with the key from `credentials.env`.
4. Run `sudo bash anypress-install.sh check`: it checks Coolify, the API, the dashboard, DNS, HTTPS and email,
   and says which still fail.

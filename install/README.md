# Installer

`anypress-install.sh` sets up AnyPress on one fresh Ubuntu server (22.04 or 24.04, 4 GB RAM or more): it does
Stage 1 of the [self-hosting guide](../docs/self-hosting.md#stage-1-one-vps-with-coolify) for you, DNS included when
your domains are on Cloudflare.

```sh
curl -fsSLO https://raw.githubusercontent.com/hamchowderr/waas-provisioning-api/main/install/anypress-install.sh
curl -fsSL https://raw.githubusercontent.com/hamchowderr/waas-provisioning-api/main/install/anypress.env.example -o /root/anypress.env
nano /root/anypress.env        # your domains, email and storage bucket, and optionally email keys
sudo bash anypress-install.sh
```

It works on a plain server and on one that already runs Coolify (Hostinger's Coolify template, Hetzner's Coolify
app, DigitalOcean's Coolify 1-Click).

## From your computer: Hostinger, Hetzner or DigitalOcean

With an API token from your server provider, the installer can make the server for you, without you logging in to
it. It runs on your computer (Linux, macOS or WSL, with `curl`, `jq` and `openssl`):

```sh
curl -fsSLO https://raw.githubusercontent.com/hamchowderr/waas-provisioning-api/main/install/anypress-install.sh
curl -fsSL https://raw.githubusercontent.com/hamchowderr/waas-provisioning-api/main/install/anypress.env.example -o anypress.env
nano anypress.env              # the answers above, plus your provider's token
bash anypress-install.sh hostinger      # or: hetzner, digitalocean
```

The server gets plain Ubuntu 24.04 and a start-up script holding your answers and the installer, which then runs on
the server as below. Your provider tokens are left out of it. With an SSH key (`~/.ssh/id_ed25519.pub` or
`~/.ssh/id_rsa.pub`, or `ANYPRESS_SSH_KEY`), the key is added to the server and you watch the install as it runs;
without one, follow `/root/anypress/install.log` in the provider's browser console. The server's root password, when
the provider gives one, is saved on your computer in `~/.anypress/`.

| Provider | Token | What it does |
|---|---|---|
| `hostinger` | `HOSTINGER_API_TOKEN` (hPanel → **Account** → **API**) | Sets up a VPS you bought and haven't set up yet (`HOSTINGER_VPS_ID` when there are several), with the script as its post-install script, which is deleted from your account once the server has it. A VPS that is already set up is left alone unless `HOSTINGER_RECREATE=yes`, which wipes it. |
| `hetzner` | `HETZNER_API_TOKEN` (Cloud Console → your project → **Security** → **API tokens**, Read & Write) | Makes a Hetzner Cloud server of type `HETZNER_SERVER_TYPE` (run it without one to see the types), in `HETZNER_LOCATION` if set. |
| `digitalocean` | `DIGITALOCEAN_TOKEN` (Control Panel → **API**, with write access) | Makes a Droplet of size `DIGITALOCEAN_SIZE` (default `s-4vcpu-8gb`) in `DIGITALOCEAN_REGION` (default `nyc3`). |

Hetzner and DigitalOcean servers are named `anypress-<your brand domain>` (or `ANYPRESS_SERVER_NAME`); the installer
stops if one with that name exists, so running it again doesn't make a second server.

Hostinger's terms allow it to suspend a whole server over flagged content, and they don't allow prescription-drug
stores; put stores like that on another provider.

## What it does

1. Installs Coolify (4.4.6 unless `ANYPRESS_COOLIFY_VERSION` says otherwise), with your email as its admin, so its
   sign-up page is never open.
2. Turns on Coolify's API and makes the token the provisioning API uses (or uses `COOLIFY_TOKEN` if you give one).
3. With `CLOUDFLARE_API_TOKEN` (Zone:DNS:Edit), points the five records at the server, DNS only: `*`, `*.stores` and
   `*.versions` under the store domain, `api` and `app` under the brand domain (`app` is a CNAME to
   `cname.vercel-dns.com` when the dashboard is on Vercel). It corrects records that point
   elsewhere or are proxied, and stops if a name has another type of record (a CNAME, for example).
4. Creates the projects **WaaS API**, **WaaS Stores** and **WaaS Storefront**, and Postgres 16 in WaaS API.
5. Deploys the provisioning API on `api.<brand domain>` with generated secrets, and waits for `/health`.
6. Makes an API key for your storefront.
7. Publishes the store template and the storefront template from the newest
   [templates release](https://github.com/hamchowderr/waas-provisioning-api/releases) (checksums checked), and makes
   each the production version. New stores are made from the store template.
8. Builds your storefront: a WordPress site with WaaS Host and FluentCart, already connected to the API, with you as
   its administrator.
9. Deploys the dashboard on `app.<brand domain>`, with you as its admin.
   With `VERCEL_TOKEN`, the dashboard goes to your own Vercel account instead: the installer makes a project
   (`anypress-dashboard`, in the team `VERCEL_TEAM_ID` if set), gives it its settings and `app.<brand domain>`, uploads
   the dashboard's source and deploys it to production. Your Vercel account needs no access to GitHub.
10. Adds the daily job that keeps Coolify's task history to 7 days.
11. Prints the DNS records to add (without a Cloudflare token) and the storefront's address.

Passwords, keys and the storefront's key go to `/root/anypress/credentials.env` (root only). Keep a copy of
`SECRETS_KEY` somewhere safe: without it, store passwords and database backups can't be read.

Running it again is safe: it finds what it made before (`/root/anypress/state.env`) and only updates settings. When
there is a newer templates release, it publishes that one and makes it production.

## After it finishes

1. Add the DNS records it printed, if it had no Cloudflare token.
2. Open the storefront's wp-admin (linked on the dashboard's **API keys** page), connect Stripe in FluentCart and make the plans
   customers buy, each with WaaS Provisioning added ([section 6](../docs/self-hosting.md#6-the-storefront)).
3. Run `sudo bash anypress-install.sh check`: it checks Coolify, the API, the dashboard, DNS, HTTPS and email,
   and says which still fail.

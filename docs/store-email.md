# Store email

Stores send their email (password resets, FluentCart order receipts, new-user mail) through one SMTP relay for the whole platform. The default is [toSend](https://tosend.com) over SMTP (`smtp.tosend.com`, port 587 with STARTTLS, user `tosend`, an API key as the password). Before this, stores sent nothing: the official WordPress image has no mailer, so `wp_mail()` failed quietly.

## How it works

- The API holds the relay settings (below). When `STORE_SMTP_PASSWORD` is set, every store gets them as the Coolify variable `WAAS_MAIL_B64` (base64 JSON), which the compose file passes to the `wordpress` and `agent` containers. They are never in an agent command or in the store's files, so snapshots and backups carry no credentials.
- The store agent writes the mu-plugin `wp-content/mu-plugins/waas-mail.php` with the guard (on restore, configure, suspend and resume). It reads `WAAS_MAIL_B64` and sets PHPMailer to SMTP. Without the variable (version sites, or the relay unset) it does nothing.
- The relay only sends from its verified domain, so every message goes out **from `STORE_MAIL_FROM` under the store's name** (the sender name a plugin set, else the site title). The address the store meant to send from becomes the Reply-To, unless the message already has one or it is WordPress's placeholder `wordpress@<site>`.
- Failures are written to the PHP error log (`WaaS store mail: …`), visible in the store's container logs.
- Existing stores: on startup the API gives every live store the current settings (`ensureStoreMail`, next to the cron check in `src/maintenance.ts`). A store whose variable already matches is left alone. One that needs it gets the variable, a re-rendered compose if it never had one, **one restart**, and the mu-plugin. Changing any setting (a new key) does the same for every store on the next deploy.

## Settings (on the `waas-api` app in Coolify)

| Variable | Default | |
|---|---|---|
| `STORE_SMTP_PASSWORD` | | Turns store email on. For toSend: an API key (`tsend_…`) scoped to the sending domain only |
| `STORE_MAIL_FROM` | | Required with the password. An address on the domain verified with the relay, e.g. `no-reply@anypress.io` |
| `STORE_SMTP_HOST` | `smtp.tosend.com` | |
| `STORE_SMTP_PORT` | `587` | 465 uses implicit TLS; any other port STARTTLS |
| `STORE_SMTP_USER` | `tosend` | |

## Setting up toSend

1. In toSend, add and verify the sending domain `anypress.io`: add the DNS records it shows in Cloudflare (DNS only) and wait until it shows as verified.
2. Create an API key scoped to `anypress.io` only. A domain-scoped key limits the damage if it ever leaks.
3. On `waas-api` in Coolify, add `STORE_SMTP_PASSWORD` (the key) and `STORE_MAIL_FROM` (e.g. `no-reply@anypress.io`), then redeploy.

Check the toSend plan's sending limits against the stores' order and password-reset volume before selling at scale.

Another provider works the same way through its SMTP settings (`STORE_SMTP_HOST`, `_PORT`, `_USER`). Check its acceptable-use terms for the stores' products first ([hosting.md](hosting.md), "What needs a written answer from a provider").

## Not covered yet

- Sending from the customer's own domain (their `From`, verified per store).
- Per-store keys or per-store sending limits: all stores share one key, so one store sending spam affects the domain's reputation for all. A store admin cannot read the key from wp-admin, but anyone able to run PHP in the store could.

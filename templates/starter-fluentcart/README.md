# Starter store (FluentCart)

The first store template: a clean WordPress shop that every new store is created from.

| | |
|---|---|
| WordPress | 7.1.4 for the build; stores run `wordpress:7.1-php8.3-apache` (version `7.1`, PHP `8.3`) |
| Plugins | WaaS Client (`waas-client`, built from [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) `packages/waas-client`), FluentCart 1.7.0 (free, wordpress.org). Nothing else |
| Theme | Twenty Twenty-Five 1.5, the only theme installed |
| Pages | FluentCart's own: Shop (the home page), Cart, Checkout, Receipt, Review Your Order, Account. The sample post, sample page, privacy policy draft and comment are removed |
| Settings | Permalinks `/%postname%/`, timezone UTC, comments and pingbacks closed, registration off, **search engines discouraged** (`blog_public` 0: the store owner turns indexing on at launch) |
| Users | `waas-admin` (`admin@example.invalid`) with a random password nobody keeps, as on any store the provisioner installs. The store's own user is created by `createTenant` |
| Roles | `wp-content/plugins/waas-client-data/roles.json` ([`roles.json`](roles.json)): one role, `store`, with FluentCart. The storefront reads it from the production version's domain; WaaS Client switches plugins on and off per role |

## Format

`dist/starter-fluentcart.zip` is the archive the Coolify provisioner restores ([docs/coolify.md](../../docs/coolify.md), `restore` in `src/provisioner/coolify/agent.php`):

- `database.sql`: `wp db export` of the whole database, table prefix `wp_` (what the stores' `wp-config.php` uses), home and site URL `https://starter.template.invalid`. The agent imports it and rewrites that host to the store's domain (`wp search-replace`), so it must be a bare `https` host without a port.
- `wp-content/`: plugins, theme and an empty `uploads`. WordPress core is not included; it comes from the image.
- `waas-template.json`: what went into the build (versions, waas-plugins commit, build time). Informational.

## Rebuild

Needs Docker, curl, zip, unzip and composer. The build runs MariaDB and WP-CLI in containers and talks to nothing but wordpress.org and the image registry.

```sh
git clone https://github.com/hamchowderr/waas-plugins ../waas-plugins
templates/starter-fluentcart/build.sh ../waas-plugins
```

Downloads are pinned with SHA-256 checksums at the top of `build.sh`. To move to a newer WordPress, FluentCart or theme, change the version and checksum there.

## Publish

```sh
WAAS_API_URL=https://api.example.com WAAS_KEY=<product key> WAAS_SECRET=<secret> templates/starter-fluentcart/publish.sh v1.0.0 --production
```

It creates the base snapshot **Starter store - FluentCart** (base snapshot names allow only letters, digits, spaces and dashes) and uploads the zip, creates the version from it, waits until it is Done and, with `--production`, makes it the production version. New stores are then created from it. Set `WAAS_API_URL` to your API's address (required); `WP_VERSION` and `PHP_VERSION` pick the image (default `7.1`, `8.3`; Docker Hub must have `wordpress:<WP>-php<PHP>-apache`).

A new template release is a new version (`v1.0.1`, ...) made production; existing stores move to it with `moveTenantToAVersion`.

# AnyPress store

The store template AnyPress's own shop sells: WordPress with the Fluent suite for selling, marketing,
bookings, support and affiliates, plus SEO and automation.

| | |
|---|---|
| WordPress | 7.1.3 for the build; stores run `wordpress:7.1-php8.3-apache` (version `7.1`, PHP `8.3`) |
| Theme | Twenty Twenty-Five 1.5, the only theme installed |
| Plugins | WaaS Client (built from [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) `packages/waas-client`) and these free wordpress.org plugins, all active: |

| Plugin | Slug | Version |
|---|---|---|
| FluentCart | `fluent-cart` | 1.9.0 |
| FluentCRM | `fluent-crm` | 3.2.6 |
| Fluent Forms | `fluentform` | 6.2.15 |
| FluentBooking | `fluent-booking` | 2.5.0 |
| Fluent Support | `fluent-support` | 2.4.5 |
| FluentAffiliate | `fluent-affiliate` | 1.6.5 |
| FluentSnippets | `easy-code-manager` | 10.56 |
| Rank Math SEO | `seo-by-rank-math` | 1.0.280 |
| WP Fusion Lite | `wp-fusion-lite` | 3.48.0 |
| AutomatorWP | `automatorwp` | 6.0.4 |

Pages, settings and users are the same as [Starter store (FluentCart)](../starter-fluentcart/README.md): FluentCart's
pages with Shop as the home page, comments off, search engines discouraged until launch, and a `waas-admin` user with
a random password nobody keeps.

Store email is not a plugin: the provisioner's `waas-mail` mu-plugin sends it. Don't add an SMTP plugin.

Pro versions aren't included. They are licensed per site, so a store owner adds their own licence.

## Roles

[`roles.json`](roles.json) has one role, `store`, with every plugin on. To sell plans with different plugin sets, add
a role per plan; WaaS Client switches plugins on and off per role.

## Build and publish

```sh
templates/anypress-store/build.sh ../waas-plugins
WAAS_API_URL=https://api.example.com WAAS_KEY=<product key> WAAS_SECRET=<secret> templates/anypress-store/publish.sh v1.0.0 --production
```

Plugin versions and SHA-256 checksums are pinned in `PLUGINS` at the top of `build.sh`. Otherwise both scripts work as
described in the [starter template's README](../starter-fluentcart/README.md).

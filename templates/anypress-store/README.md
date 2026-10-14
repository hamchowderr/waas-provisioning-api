# AnyPress store

The store template AnyPress's own shop sells: WordPress with the Fluent suite for selling, marketing,
bookings, support and affiliates, plus SEO, automation and login security.

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
| FluentAuth | `fluent-security` | 3.0.5 |

Pages, settings and users are the same as [Starter store (FluentCart)](../starter-fluentcart/README.md): FluentCart's
pages with Shop as the home page, comments off, search engines discouraged until launch, and a `waas-admin` user with
a random password nobody keeps.

## Settings

[`presets.php`](presets.php) runs once on the build and sets what is the same for every store. Each block says why:

- Rank Math: account step skipped and wizard marked done (without that it loads no modules at all), FluentCart
  products and categories in titles and the sitemap, company knowledge graph, no placeholder opening hours, author
  archives off, Redirections and 404 Monitor on, account-only modules and IndexNow off until launch.
- FluentCart: first activation marked done (its first admin visit would otherwise blank the store name), terms
  checkbox at checkout, cart icon in the menu.
- FluentCRM: setup wizard skipped, lists Newsletter and Customers, tags Customer, Lead and Subscriber, sending
  capped at 7 emails a second, IP anonymising, one-click unsubscribe, no Gravatar.
- Fluent Forms: honeypot and token spam checks; the contact form emails the site's admin address; the
  subscription form adds people to Newsletter after they confirm (double opt-in).
- Fluent Support: FluentBooking links in tickets. AutomatorWP: logs cleared after 30 days, no Pro suggestions.
- FluentAuth: first-run wizard done with its defaults (5 failed logins locks an address for 30 minutes, monthly
  login digest to the admin email), XML-RPC off. Two-factor is left for the owner to switch on.

[`mu-plugins/anypress-store.php`](mu-plugins/anypress-store.php) ships in the template and keeps the rest in code:
WP Fusion's staging-site check off (`WPF_STAGING_MODE` false; every store is a clone), vendor usage stats and
upgrade nags off, FluentAffiliate's tracking script only once a programme is on, and on each store's first web
request (and after an address change) fresh install dates, a rewrite-rule flush and a Rank Math sitemap cache clear.

Per-store values come from the purchase: WaaS Host sends the site title (`blogname`), the buyer's email
(`admin_email`) and `waas_store_owner` (`{"country":"US"}`) as `wpOptions`. On the store's first web request the
mu-plugin copies them into the plugins once: FluentCart store name, country and email sender; FluentCRM business
name and sender (FluentBooking uses it too); FluentAffiliate sender and admin email; FluentBooking default country;
Fluent Support's first mailbox; Rank Math's organisation and website name. The template also has a Support Portal
page. Stores created without these options keep `admin@example.invalid` until the owner changes it.

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

# AnyPress store

The store template AnyPress's own shop sells: WordPress with the Fluent suite for selling, marketing,
bookings, support, affiliates and an online community with courses, plus SEO, automation and login security.

| | |
|---|---|
| WordPress | 7.1.3 for the build; stores run `wordpress:7.1-php8.3-apache` (version `7.1`, PHP `8.3`) |
| Theme | [Ollie](https://wordpress.org/themes/ollie/) 1.6.5, a free block theme with a library of ready-made sections; the only theme installed |
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
| FluentCommunity | `fluent-community` | 2.12.0 |

Plus FluentToolkit 2.1.3 (`fluent-toolkit`, shown in wp-admin as FluentHub: one dashboard for the Fluent plugins). It isn't
on wordpress.org, so its GPL zip from WPManageNinja is kept in [`plugins/`](plugins/) and checked by SHA-256 like the others;
once installed it updates itself from the vendor.

Ollie's header lists every page when the site has no menu, and its footer is the theme's own demo (sample links, social
icons, a download pitch), so [`presets.php`](presets.php) adds a Main menu (Shop, Cart, Account, Support; links to pages a
site type hides show nothing) and a plain footer (site title and the same menu). Owners change both in Appearance → Editor.

Starter pages (`mu-plugins/anypress-patterns.php`): whole-page patterns under "Starter pages" when a page is created, and
for the AnyPress connector's agents (`find_patterns`, category `anypress/pages`). Home pages for a website, an online store,
bookings, and community and courses (each only when its plugin is on), plus About, Services and Contact. They use Ollie's
own section layouts with the store's name and plain placeholder text, the Fluent Forms contact form, FluentCart's product
list and, once the owner has made one, the FluentBooking calendar. Ollie's patterns that advertise the theme itself
(Download page, Theme Details) are hidden.

A new store also gets real pages made from them, once, on its first web request after the platform has set the owner's
email and the site type has switched its plugins: published, in the main menu, with Ollie's no-title page template.
Website: Home, Services, About and Contact, with Home as the home page. Bookings: the same with the bookings home page.
Community and courses: Home, About and Contact (it has FluentCart too, to sell courses, but gets the community home
page). Online store and everything: the store home page as Home, with Shop moving to `/shop/`, and About and Contact
after Shop in the menu. A store that already has pages of its own gets none.

Until a store publishes its first product, FluentCart's product lists (the Shop page and the store home page) show
"New products are on their way. Check back soon." instead of an empty filter bar and "No results found"
(`mu-plugins/anypress-store.php`).

Pages, settings and users are the same as [Starter store (FluentCart)](../starter-fluentcart/README.md): FluentCart's
pages with Shop as the home page, comments off, search engines discouraged until launch, and a `waas-admin` user with
a random password nobody keeps.

## Settings

[`presets.php`](presets.php) runs once on the build and sets what is the same for every store. Each block says why:

- Rank Math: account step skipped and wizard marked done (without that it loads no modules at all), FluentCart
  products and categories in titles and the sitemap, company knowledge graph, no placeholder opening hours, author
  archives off, Redirections and 404 Monitor on, account-only modules and IndexNow off until launch.
- FluentCart: first activation marked done (its first admin visit would otherwise blank the store name), terms
  checkbox at checkout, cart icon in the menu, renewal reminders on (monthly plans 7 days before each charge,
  plus the yearly and trial-end ones).
- FluentCRM: setup wizard skipped, lists Newsletter and Customers, tags Customer, Lead and Subscriber, an unticked
  newsletter box at checkout (double opt-in, into Newsletter), WordPress users synced as contacts, sending capped at 7
  emails a second, IP anonymising, one-click unsubscribe, no Gravatar.
- Fluent Forms: honeypot and token spam checks; the contact form emails the site's admin address; the
  subscription form adds people to Newsletter after they confirm (double opt-in).
- FluentAffiliate: FluentCart integration on, so store orders count as referrals.
- Fluent Support: FluentBooking links in tickets. AutomatorWP: logs cleared after 30 days, no Pro suggestions.
- Theme: the Main menu and the plain footer above.
- Starter pages (`mu-plugins/anypress-patterns.php`); the build checks they register.
- FluentAuth: first-run wizard done with its defaults (5 failed logins locks an address for 30 minutes, monthly
  login digest to the admin email), XML-RPC off. Two-factor is left for the owner to switch on.

[`mu-plugins/anypress-store.php`](mu-plugins/anypress-store.php) ships in the template and keeps the rest in code:
WP Fusion's staging-site check off (`WPF_STAGING_MODE` false; every store is a clone), vendor usage stats and
upgrade nags off, FluentAffiliate's tracking script only once the store has an active affiliate, and on each store's first web
request (and after an address change) fresh install dates, a rewrite-rule flush and a Rank Math sitemap cache clear.

Per-store values come from the purchase: WaaS Host sends the site title (`blogname`), the buyer's email
(`admin_email`) and `waas_store_owner` (`{"country":"US"}`) as `wpOptions`. On the store's first web request the
mu-plugin copies them into the plugins once: FluentCart store name and country; FluentCRM business name and
email; FluentAffiliate admin email; FluentBooking default country; Fluent Support's first mailbox; Rank Math's organisation and website name. The template also has a Support Portal
page. Stores created without these options keep `admin@example.invalid` until the owner changes it.
The owner's address, phone, time zone, currency and name are filled in by the provisioner's `waas-owner` mu-plugin
([details](../../docs/coolify.md#the-owners-details)).

Store email is not a plugin: the provisioner's `waas-mail` mu-plugin sends it, and fills in each plugin's own sender
to match ([store email](../../docs/store-email.md#the-plugins-own-senders)). Don't add an SMTP plugin.

Pro versions aren't included. They are licensed per site, so a store owner adds their own licence.

## Roles

[`roles.json`](roles.json) has one role per site type. Each shop product picks one, and WaaS Client switches the
store's plugins to that role's list:

| Role | Site type | Plugins on |
|---|---|---|
| `website` | Website | FluentCRM, Fluent Forms, FluentSnippets, Rank Math, WP Fusion Lite, AutomatorWP, FluentAuth, FluentToolkit |
| `bookings` | Bookings | Website's, plus FluentBooking and Fluent Support |
| `online-store` | Online store | Website's, plus FluentCart, Fluent Support and FluentAffiliate |
| `community` | Community & courses | Website's, plus FluentCommunity and FluentCart (to sell memberships and courses) |
| `everything` | Everything | all of them |
| `store` | Everything, for stores bought before site types | all of them |

Pages that need one plugin carry the post meta `_anypress_needs` (FluentCart's six pages and the Support Portal). The
mu-plugin puts them back to draft while that plugin is off, and the home page shows the latest posts while the shop is
hidden. When a plan change turns the plugin on, the pages come back, and the owner details step for that plugin runs
then.

## Build and publish

```sh
templates/anypress-store/build.sh ../waas-plugins
WAAS_API_URL=https://api.example.com WAAS_KEY=<product key> WAAS_SECRET=<secret> templates/anypress-store/publish.sh v1.0.0 --production
```

Plugin versions and SHA-256 checksums are pinned in `PLUGINS` (and `VENDORED`) at the top of `build.sh`. Otherwise both scripts work as
described in the [starter template's README](../starter-fluentcart/README.md).

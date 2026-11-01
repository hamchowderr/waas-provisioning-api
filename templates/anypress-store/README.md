# AnyPress store

The store template AnyPress's own shop sells: WordPress with the Fluent suite for selling, marketing,
bookings, support, affiliates and an online community with courses, plus SEO, automation and login security.

| | |
|---|---|
| WordPress | 7.1.4 for the build; stores run `wordpress:7.1-php8.3-apache` (version `7.1`, PHP `8.3`) |
| Theme | The [AnyPress theme](https://github.com/hamchowderr/anypress-theme) (a release pinned by version and checksum in [`theme.sh`](theme.sh)), a block theme with 13 kits (a style and sections for one kind of business) and AnyPress Blocks (32 sections that work with any kit); the only theme installed. Stores made from versions before v1.1.0 run [Ollie](https://wordpress.org/themes/ollie/) |
| Plugins | WaaS Client (built from [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) `packages/waas-client`) and these free wordpress.org plugins, all active: |

| Plugin | Slug | Version |
|---|---|---|
| FluentCart | `fluent-cart` | 2.2.0 |
| FluentCRM | `fluent-crm` | 3.3.1 |
| Fluent Forms | `fluentform` | 6.2.16 |
| FluentBooking | `fluent-booking` | 2.5.0 |
| Fluent Support | `fluent-support` | 2.4.7 |
| FluentAffiliate | `fluent-affiliate` | 1.7.0 |
| FluentSnippets | `easy-code-manager` | 10.58 |
| Rank Math SEO | `seo-by-rank-math` | 1.0.280 |
| WP Fusion Lite | `wp-fusion-lite` | 3.48.0 |
| AutomatorWP | `automatorwp` | 6.0.5 |
| FluentAuth | `fluent-security` | 3.1.0 |
| FluentCommunity | `fluent-community` | 2.12.0 |

Plus FluentToolkit 2.1.4 (`fluent-toolkit`, shown in wp-admin as FluentHub: one dashboard for the Fluent plugins). It isn't
on wordpress.org, so its GPL zip from WPManageNinja is kept in [`plugins/`](plugins/) and checked by SHA-256 like the others;
once installed it updates itself from the vendor.

The FluentCart Migrator add-on 1.1.0-beta (`fluent-cart-migrator`, FluentCart's own importer for WooCommerce shops) is kept
in [`plugins/`](plugins/) the same way and installed switched off, so it doesn't load on every page. WaaS Client's shop
switch (`wp waas shop switch`) turns it on when it runs.

And [AnyPress Blocks](https://github.com/hamchowderr/anypress-blocks) (`anypress-blocks`), our own blocks plugin: the Popup block
for signups, offers and booking forms, and Carousel, Counter and Map blocks. A release is pinned by version and checksum in [`build.sh`](build.sh)
(`BLOCKS_VERSION`, `BLOCKS_SHA256`) and it is active on every site type.

And WordPress's [MCP Adapter](https://wordpress.org/plugins/mcp-adapter/) 0.7.1 (`mcp-adapter`), installed but **off**. The store
owner turns it on in Dashboard → Your plan → AI apps (MCP); then AI apps that speak MCP can work on the site's pages and
design at `/wp-json/mcp/anypress`, signed in as a WordPress user with an application password. It is pinned in
[`build.sh`](build.sh) (`OFF_PLUGINS`) and isn't in `roles.json`.

Without a menu the theme's header lists every page, so [`presets.php`](presets.php) adds a Main menu (Shop, Cart,
Account, Support; links to pages a site type hides show nothing), which the header and the footer both show. Owners
change it in Appearance → Editor.

Starter pages (`mu-plugins/anypress-patterns.php`): whole-page patterns under "Starter pages" when a page is created, and
for the AnyPress connector's agents (`find_patterns`, category `anypress/pages`, next to the theme's own kit pages).
Home pages for a website, an online store, bookings, and community and courses (each only when its plugin is on), plus
About, Services and Contact. They use the theme's section layouts (a words-only hero on the brand colour, since a new
store has no photos yet, a features grid, questions, a dark call to action) with the store's name and plain placeholder
text, the Fluent Forms contact form, FluentCart's product list and, once the owner has made one, the FluentBooking
calendar. `theme.sh check` runs the theme's own Playground check (from the pinned release) with these starter pages
added: every page must parse into valid blocks, use the theme's tokens only and render without errors.

A new store also gets real pages made from them, once, on its first web request after the platform has set the owner's
email and the site type has switched its plugins: published, in the main menu, with the theme's no-title page template.
Website: Home, Services, About and Contact, with Home as the home page. Bookings: the same with the bookings home page.
Community and courses: Home, About and Contact (it has FluentCart too, to sell courses, but gets the community home
page). Bookings has FluentCart too, for paid bookings, but keeps the bookings home page and hides the Shop and Cart pages. Online store and everything: the store home page as Home, with Shop moving to `/shop/`, and About and Contact
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
- FluentCRM: setup wizard skipped, one list (Newsletter), an unticked newsletter box at checkout (double opt-in, into
  Newsletter), WordPress users synced as contacts, sending capped at 7 emails a second, IP anonymising, one-click
  unsubscribe, no Gravatar.
- Fluent Forms: honeypot and token spam checks; the contact form emails the site's admin address; the
  subscription form adds people to Newsletter after they confirm (double opt-in).
- FluentAffiliate: FluentCart integration on, so store orders count as referrals.
- Fluent Support: FluentBooking links in tickets. AutomatorWP: logs cleared after 30 days, no Pro suggestions.
- Theme: the Main menu above.
- Starter pages (`mu-plugins/anypress-patterns.php`); the build checks they register.
- FluentAuth: first-run wizard done with its defaults (5 failed logins locks an address for 30 minutes, monthly
  login digest to the admin email), XML-RPC off. Two-factor is left for the owner to switch on.

### CRM lifecycle

Every store starts with its CRM set up ([`crm/setup.php`](crm/setup.php), run after the presets):

- Tags say what a contact wants, has or had: **Offering: Interested / Active / Past**. The offerings are
  **Enquiry** (the contact form), **Shop** (one-off orders, and abandoned checkouts), **Subscription**, **Bookings**,
  **Community**, **Course** and **Affiliate**. Interested never sits with Active or Past of the same offering, Past
  removes Active, and Interested goes after 120 days without a purchase. A full refund removes Active (or Shop: Past
  when it was the only order) and sets the contact's **Refunded** field instead of adding Past.
- Fields: **Source** (contact_form, checkout, booking), **Customer group** and **Refunded**. Lists are consent only:
  Newsletter.
- The contact form asks "What best describes you?" (the customer groups, Just starting out and Already in business to
  begin with), "What can we help with?" ("A booking" shows only where FluentBooking is on) and has an unticked
  newsletter box. Sending it makes the visitor a contact tagged Enquiry: Interested (or Bookings: Interested); they
  join the newsletter only if they tick the box and confirm.
- Abandoned checkout tracking for FluentCart (it tags Shop: Interested once the owner publishes the abandoned
  checkout automation, since FluentCRM only follows a checkout when one is published), and a coupon **COMEBACK20** (20% off the first
  payment, once per customer, 100 uses) for the win-back email.
- Draft automations ([`crm/emails.json`](crm/emails.json)): a nurture series for each customer group, a welcome for
  each offering, a thank-you after a one-off order, win-backs, and the abandoned checkout emails, plus a Newsletter
  email template. Nothing sends until the owner publishes an automation in FluentCRM.

[`mu-plugins/anypress-crm-lifecycle.php`](mu-plugins/anypress-crm-lifecycle.php) does the tagging from FluentCart,
FluentBooking, FluentCommunity, FluentAffiliate and the contact form, and starts the welcome, thank-you, win-back and
nurture automations once they are published (free FluentCRM can't start an automation from a tag; these automations sit
on the user-registration trigger, limited to a role nobody has). New buyers are "transactional", and an unsubscribed
contact stays unsubscribed (WP Fusion also adds new WordPress users as transactional). When WP Fusion is connected to another CRM, such as HighLevel, the same tags follow the
contact there. Each Monday the owner gets the week's numbers by email (new contacts, groups, sources, tags added, paid
orders, monthly revenue from live plans), with a CRM check in the first week of each month; quiet weeks send nothing,
and setting the `anypress_crm_weekly_email` option to `no` turns it off. Owners rename an offering with the
`anypress_crm_offerings` option.

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
| `bookings` | Bookings | Website's, plus FluentBooking, FluentCart (to take payment for bookings, with no Shop or Cart page) and Fluent Support |
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

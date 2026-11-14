# AnyPress store

The store template AnyPress's own shop sells: WordPress with the Fluent suite for selling, marketing,
bookings, support, affiliates, video and an online community with courses, plus SEO, automation and login security.
Plugins are listed in the order AnyPress shows them everywhere.

| | |
|---|---|
| WordPress | 7.1.4 for the build; stores run `wordpress:7.1-php8.3-apache` (version `7.1`, PHP `8.3`) |
| Theme | The [AnyPress theme](https://github.com/hamchowderr/anypress-theme) (a release pinned by version and checksum in [`theme.sh`](theme.sh)), a block theme with 16 kits (a style, sections and a whole website for one kind of business) and AnyPress Blocks (32 sections that work with any kit); the only theme installed. Stores made from versions before v1.1.0 run [Ollie](https://wordpress.org/themes/ollie/) |
| Plugins | AnyPress Client (built from [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) `packages/anypress-client` at the release in [`CLIENT_VERSION`](CLIENT_VERSION)) and these free wordpress.org plugins, all active: |

| Plugin | Slug | Version |
|---|---|---|
| FluentAuth | `fluent-security` | 3.1.1 |
| FluentSMTP | `fluent-smtp` | 2.4.5 |
| FluentCRM | `fluent-crm` | 3.3.1 |
| Fluent Forms | `fluentform` | 6.2.17 |
| FluentBooking | `fluent-booking` | 2.6.0 |
| FluentCart | `fluent-cart` | 2.3.1 |
| FluentCommunity | `fluent-community` | 2.14.0 |
| FluentPlayer | `fluent-player` | 1.4.0 |
| FluentAffiliate | `fluent-affiliate` | 1.7.0 |
| Fluent Support | `fluent-support` | 2.5.0 |
| FluentSnippets | `easy-code-manager` | 10.58 |
| Rank Math SEO | `seo-by-rank-math` | 1.0.282 |
| AutomatorWP | `automatorwp` | 6.1.1 |
| WP Fusion Lite | `wp-fusion-lite` | 3.48.2 |

Plus FluentToolkit 2.1.4 (`fluent-toolkit`, shown in wp-admin as FluentHub: one dashboard for the Fluent plugins). It isn't
on wordpress.org, so its GPL zip from WPManageNinja is kept in [`plugins/`](plugins/) and checked by SHA-256 like the others;
once installed it updates itself from the vendor.

FluentCart Customer Rights 0.1.3 (`fluent-cart-customer-rights`, FluentCart's free add-on for the EU's 14-day right to
cancel: a cancellation form on the "Withdraw from contract" page FluentCart makes with its other pages, and each request
kept on its order) is kept in [`plugins/`](plugins/) the same way and is on wherever FluentCart is.

The FluentCart Migrator add-on 1.1.0-beta (`fluent-cart-migrator`, FluentCart's own importer for WooCommerce shops) is kept
in [`plugins/`](plugins/) the same way and installed switched off, so it doesn't load on every page. AnyPress Client's shop
switch (`wp anypress shop switch`) turns it on when it runs.

And [AnyPress Blocks](https://github.com/hamchowderr/anypress-blocks) (`anypress-blocks`), our own blocks plugin: the Popup block
for signups, offers and booking forms, and Carousel, Counter, Map, Countdown, Before and After, Star Rating, Notice Bar,
Phone Bar, Location Finder and Age Check blocks (0.4.3). A release is pinned by version and checksum in [`build.sh`](build.sh)
(`BLOCKS_VERSION`, `BLOCKS_SHA256`) and it is active on every site type.

And HighLevel's [LeadConnector](https://wordpress.org/plugins/leadconnector/) 4.0.7 (`leadconnector`): HighLevel forms,
chat widget and calendars on the site. It is installed **off** (`OFF_PLUGINS` in [`build.sh`](build.sh)) and only the
`highlevel` site type turns it on.

And WordPress's [MCP Adapter](https://wordpress.org/plugins/mcp-adapter/) 0.7.1 (`mcp-adapter`), installed off and turned on by
AnyPress Client on every site type (it is always on, with no switch). AI apps that speak MCP can work on the site's
pages and design at `/wp-json/mcp/anypress`, signed in as a WordPress user with an application password; Dashboard →
Your plan → AI apps (MCP) shows the address. It is pinned in [`build.sh`](build.sh) (`OFF_PLUGINS`) and isn't in
`roles.json`. FluentHub carries its own copy of the MCP Adapter; `mu-plugins/anypress-store.php` keeps that copy off
(`FLUENT_TOOLKIT_DISABLE_BUNDLED_MCP_ADAPTER`), so the standalone plugin is the only one and a new store doesn't load both.

And [Polylang](https://wordpress.org/plugins/polylang/) 3.9.2 (`polylang`), installed off. It is on only while the site's
owner has **Languages** on (Dashboard → Your plan → Languages, the AnyPress dashboard, or the connector's `site_languages`):
AnyPress Client then sets it up once with the site's own language as the default, addresses like `/es/` for the others,
WordPress's translation files and a language switcher in the menus. It is pinned in [`build.sh`](build.sh)
(`OFF_PLUGINS`) and isn't in `roles.json`.

And [Redis Object Cache](https://wordpress.org/plugins/redis-cache/) 3.0.0 (`redis-cache`), installed off. Community and
everything sites get their own Redis, and WordPress keeps its object cache there through the plugin's drop-in and its
Predis client, set up by the platform (the plugin itself stays off). Other site types keep WordPress's own cache. It
is pinned in [`build.sh`](build.sh) (`OFF_PLUGINS`) and isn't in `roles.json`.

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

Pages, settings and users: FluentCart's pages with Shop as the home page, comments off, search engines discouraged
until launch, and a `waas-admin` user with a random password nobody keeps.

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
  login digest to the admin email), XML-RPC off, and subscribers (members and customers) kept out of wp-admin and
  its admin bar. Two-factor is left for the owner to switch on.

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

Per-store values come from the purchase: AnyPress Host sends the site title (`blogname`), the buyer's email
(`admin_email`) and `anypress_store_owner` (`{"country":"US"}`) as `wpOptions`. On the store's first web request the
mu-plugin copies them into the plugins once: FluentCart store name and country; FluentCRM business name and
email; FluentAffiliate admin email; FluentBooking default country; Fluent Support's first mailbox; Rank Math's organisation and website name. The template also has a Support Portal
page. Stores created without these options keep `admin@example.invalid` until the owner changes it.
The owner's address, phone, time zone, currency and name are filled in by the provisioner's `waas-owner` mu-plugin
([details](../../docs/coolify.md#the-owners-details)).

Store email goes through AnyPress's mail service: the provisioner's `waas-mail` mu-plugin sends it, and fills in each
plugin's own sender to match ([store email](../../docs/store-email.md#the-plugins-own-senders)). FluentSMTP is on so an
owner can connect their own email service; until they add a connection, its default mailer still hands every email to
`waas-mail` (the build checks this), and the mu-plugin hides its "no connection" warning on stores that have the
service. Don't add another SMTP plugin.

Pro versions aren't included. They are licensed per site, so a store owner adds their own licence.

## Roles

[`roles.json`](roles.json) has one role per site type. Each shop product picks one, and AnyPress Client switches the
store's plugins to that role's list. Each role's `about` gives one line on what each of its plugins is for; the
owner sees it in WordPress on Dashboard > Your plan, and the AnyPress dashboard shows it on the store's page.

| Role | Site type | Plugins on |
|---|---|---|
| `website` | Website | FluentAuth, FluentSMTP, FluentCRM, Fluent Forms, FluentPlayer, FluentSnippets, Rank Math, AutomatorWP, WP Fusion Lite, FluentToolkit |
| `bookings` | Bookings | Website's, plus FluentBooking, FluentCart (to take payment for bookings, with no Shop or Cart page) with Customer Rights, and Fluent Support |
| `online-store` | Online store | Website's, plus FluentCart with Customer Rights, Fluent Support and FluentAffiliate |
| `community` | Community & courses | Website's, plus FluentCommunity and FluentCart with Customer Rights (to sell memberships and courses) |
| `everything` | Everything | all of them |
| `highlevel` | HighLevel site, for a HighLevel agency's sites | FluentAuth (login protection), FluentPlayer (video), FluentSnippets (code snippets and shortcodes), Rank Math, AutomatorWP, WP Fusion Lite, LeadConnector, FluentHub (FluentToolkit). HighLevel is the CRM, forms, calendars, payments and email, so no Fluent business plugin. Owners may add plugins of their own (`ownPlugins`) |
| `store` | Everything, for stores bought before site types | all of them |

A store made without a site type keeps every plugin on, so the API gives one to the sites it makes for a HighLevel
agency's storefront (`highlevel`), and the dashboard's New site asks for one. On a HighLevel site made by a
sub-account's workflow, AnyPress Client connects WP Fusion Lite to that sub-account by itself (a token from the agency's
install of the AnyPress app, [integrations/highlevel](../../integrations/highlevel/README.md)): new users become contacts
tagged `website user`, and profile changes follow them. The agency connects LeadConnector (Settings, LeadConnector) in
wp-admin; it stays unconnected in the template.

Pages that need one plugin carry the post meta `_anypress_needs` (FluentCart's six pages and the Support Portal). The
mu-plugin puts them back to draft while that plugin is off, and the home page shows the latest posts while the shop is
hidden. When a plan change turns the plugin on, the pages come back, and the owner details step for that plugin runs
then.

## Try a site type in your browser

`playground/<site type>.json` is a WordPress Playground blueprint for each site type sold (website, bookings, online-store, community, everything, highlevel). Each one sets up a site the way a new store of that type starts: this template's theme, plugins, must-use plugins, presets and CRM set-up, with the latest AnyPress Client and `ANYPRESS_TENANT_ROLES` set to the type, so only that type's plugins are on. It runs in the visitor's browser; nothing is made on a server. Open one at `https://anypress.io/try?type=website` (or `bookings`, `store`, `community`, `everything`, `highlevel`).

After the set-up, each demo becomes a sample business running for about six months, made by `playground/sample/run.php` with each plugin's own functions and routes, for the plugins the type has on. Each business is written in `playground/sample/business-<site type>.php`: a food blog that earns from its newsletter and sponsors (Website), a massage and coaching studio (Bookings), a clothing brand (Online store), a makers' community with a course (Community), a design studio that does all of these (Everything) and a roofing company that works in HighLevel.

- **Blog:** about 18 posts by the business's two or three writers, with photos (CC0, from StockSnap, in `playground/sample/images/`), categories, tags, threaded comments with replies, a few comments waiting for approval, a draft and a scheduled post.
- **Newsletter:** six to twelve months of sent issues in FluentCRM with opens, clicks and unsubscribes, the list growing from the sign-up form over that time (about 100 contacts), the next issue scheduled, one in draft, and a welcome series automation with recent sign-ups in it.
- **Email log:** FluentSMTP keeps a log in simulation mode, so every email the business sent (receipts, shipping notices, booking confirmations, ticket replies, welcome emails) is listed on the day it went out, and none leaves the demo.
- **Forms:** the contact form, the newsletter sign-up and the business's own form (sponsorship enquiries, a client intake form, a member survey or an order problem form), each with entries.
- **Shop:** FluentCart products at real prices, three on sale, one nearly and one fully sold out, a subscription, a gift card, coupons, shipping rates and sales tax, and six months of orders from regulars and new customers (completed, shipped, processing, two refunded, one waiting for payment).
- **Bookings:** two FluentBooking hosts with weekly hours and services, three months of past sessions (with no-shows and cancellations) and the next two weeks filling up. Paid services take payment through FluentCart, so every paid session has its order (refunded when it was cancelled).
- **Memberships:** where the business sells its own course, memberships or vouchers instead of a catalogue (Community), those are FluentCart products with months of orders and monthly and yearly subscriptions.
- **Support, affiliates and community:** months of Fluent Support tickets, FluentAffiliate affiliates with visits and referrals, and a FluentCommunity of about 40 members with spaces, a pinned welcome post, comments, likes and a course whose students ask questions on the lessons.

- **Pages:** the public site is the business's own, built from the theme's sections: a home page with its photo, the shop, the booking calendar, the latest posts, the newsletter sign-up and questions, plus about, contact and blog pages, a services page with its own form where the business has one, and the menu to match.

- **Automations and sign-ins:** AutomatorWP automations that are switched on (the team hears when a post goes live; new members, buyers and clients are tagged in FluentCRM) with months of runs in their log, and a FluentAuth log of two months of sign-ins, a few wrong passwords and one blocked bot.
- **Video:** a video of the business's kind of work in Fluent Player's library, played from Wikimedia Commons (public domain or CC BY-SA, credited in its description).

Rank Math is set up for the business and there is an example snippet. The loader says what it is adding while it works ("Taking six months of orders"). A real store never gets any of this. "Make this my site" carries only pages, styles and menus to the store, and leaves behind the sample pages and menu the visitor did not change, so the store starts from its own.

The files are made from `build.sh`, `theme.sh` and `roles.json` by `node templates/anypress-store/playground/blueprints.mjs`; CI fails when one is out of date, and the Update pins workflow remakes them when it moves a pin.

## Build and publish

```sh
templates/anypress-store/build.sh ../waas-plugins
WAAS_API_URL=https://api.example.com WAAS_KEY=<product key> WAAS_SECRET=<secret> templates/anypress-store/publish.sh v1.0.0 --production
```

Plugin versions and SHA-256 checksums are pinned in `PLUGINS` (and `VENDORED`) at the top of `build.sh`. The build needs
Docker, curl, zip, unzip and composer; it runs MariaDB and WP-CLI in containers and talks to nothing but wordpress.org and
the image registry. `publish.sh` creates the base snapshot and uploads the zip, creates the version from it, waits until
it is Done and, with `--production`, makes it the production version. Set `WAAS_API_URL` to your API's address
(required); `WP_VERSION` and `PHP_VERSION` pick the image (default `7.1`, `8.3`).

### Format

`dist/anypress-store.zip` is the archive the Coolify provisioner restores ([docs/coolify.md](../../docs/coolify.md),
`restore` in `src/provisioner/coolify/agent.php`):

- `database.sql`: `wp db export` of the whole database, table prefix `wp_` (what the stores' `wp-config.php` uses),
  home and site URL `https://store.template.invalid`. The agent imports it and rewrites that host to the store's domain
  (`wp search-replace`), so it must be a bare `https` host without a port.
- `wp-content/`: plugins, theme and an empty `uploads`. WordPress core is not included; it comes from the image.
- `waas-template.json`: what went into the build (versions, waas-plugins commit, build time). Informational.

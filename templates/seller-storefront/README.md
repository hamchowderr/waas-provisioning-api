# Seller storefront

The template for ready-made storefronts: a WordPress site that sells websites with AnyPress Host, for a customer
who doesn't bring a WordPress site of their own. The API builds one with
`POST /admin/products/{productId}/storefront` ([`src/storefronts.ts`](../../src/storefronts.ts)).

| | |
|---|---|
| WordPress | 7.1.4 for the build; storefronts run `wordpress:7.1-php8.3-apache` (version `7.1`, PHP `8.3`) |
| Theme | The AnyPress theme, the release the store template pins ([`../anypress-store/theme.sh`](../anypress-store/theme.sh)), the only theme installed |
| Plugins | AnyPress Host (built from [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) `packages/anypress-host` with its release script, at the version given to `build.sh`), FluentCart 2.3.1, FluentCRM 3.3.1, Fluent Forms 6.2.17, WP Fusion Lite 3.48.0, FluentAuth 3.1.1, FluentBooking 2.6.0, Fluent Support 2.5.0, FluentAffiliate 1.7.0, FluentSnippets 10.58, BetterDocs 4.9.6 and MCP Adapter 0.7.1 (free, wordpress.org), FluentKit 2.1.4 (WPManageNinja, GPL; the zip in `../anypress-store/plugins`) and AnyPress Blocks 0.4.3. All active |
| Pages | A whole shop in the shop design (below), under the owner's own name and logo: Home (what you're making, how it works, the plans, what every plan includes, questions), Plans (FluentCart's shop, at `/plans/`, one card per kind of site) and a page per plan with its sizes, About, Questions, Contact (with the contact form), Terms of service, Privacy policy and Refund policy (plain starting text to edit), Who we help (a page for each kind of customer: shops and makers, specialty retailers, course creators, chambers and associations, churches, franchises and multi-location businesses, freelancers and studios, and software companies, each with what they get, the plan that fits and questions), Support (Fluent Support's portal, where customers open and follow requests), Referrals (FluentAffiliate's sign-up and dashboard, at `/affiliates/`), Book a call (a 30-minute FluentBooking call, weekdays 9 to 5), Website care (the care packages and one-time services, with how they work), Help pages (BetterDocs, at `/docs/`: ten articles for the people who buy a website, in four topics, with questions; [`help.json`](help.json)), plus FluentCart's Cart, Checkout, Receipt and Account. The menu has Plans, Compare sizes, Who we help, Help and Account |
| Plans | One FluentCart product per site type and size (Small, Medium, Large), monthly and yearly (ten months' price), at the [price list](../../src/pricing.ts)'s prices, made by AnyPress Host's own **Create my plans**, each with the price list's free trial (one per person). Also an email pack and a 25 GB storage pack, which customers buy from their website's card in the account, domains at checkout and the volume saving, and AnyPress Host's care packages (Care, Care Plus, Care Pro, monthly or yearly) and one-time services (set-up, move-in, an hour of changes), sold under the owner's name with requests in Fluent Support, all at the price list's prices |
| Settings | Permalinks `/%postname%/`, timezone UTC, comments and pingbacks closed, registration off, **search engines discouraged** until launch |
| Users | `waas-admin` with a random password nobody keeps. The owner's administrator account is made when the storefront is created |

**The shop design** is shop.anypress.io's: the block styles, drawings, pictures and page builders in `waas-plugins` `scripts/test-storefront/remote/design`, with the words in [`brand.json`](brand.json) instead of AnyPress's (no AnyPress name, address or logo; the site's own title and logo instead). [`shop.php`](shop.php) builds the plans and pages from it, [`audiences.json`](audiences.json) holds the Who we help pages' words. Every word is ordinary page content the owner edits in WordPress.

[`presets.php`](presets.php) runs once on the build: FluentCart's first activation marked done, the cart icon in the
menu, renewal reminders, a terms checkbox at checkout, FluentAuth's first-run defaults with XML-RPC off, FluentKit's one dashboard (merged menus, app headers hidden), FluentCRM (no setup wizard, an unticked newsletter box at checkout
into a Newsletter list, neutral email styles, compliance settings), Fluent Forms (spam checks, the contact form emailing
the owner) and WP Fusion Lite connected to FluentCRM on the site.

The CRM is the store template's ([CRM lifecycle](../anypress-store/README.md#crm-lifecycle)), with one offering,
**Website**: a visitor who sends the contact form or leaves checkout is **Website: Interested**, a buyer
**Website: Active**, and when their last plan ends **Website: Past**. The automations are this template's own
([`crm-emails.json`](crm-emails.json)) and ship published: a nurture series per customer group, the welcome (help pages on
day 7, the referral program on day 31, packs, domains and sizes on day 60), the win-back with the COMEBACK20 coupon, the
abandoned checkout emails and a welcome for approved referrers.

[`mu-plugins/seller-storefront.php`](mu-plugins/seller-storefront.php) ships with the storefront. It fills the owner's name and
email into FluentCRM, FluentCart, Fluent Support (its first mailbox), FluentBooking (the call moves to the owner) and
FluentAffiliate on the first visit, and keeps WP Fusion out of staging mode. To use HighLevel
or another CRM instead, the owner picks it in **Settings → WP Fusion → Setup**; the lifecycle tags follow contacts there.

The owner has all of wp-admin. [`mu-plugins/seller-storefront-admin.php`](mu-plugins/seller-storefront-admin.php) only takes out
the upgrade nags of the plugins the storefront comes with ("Upgrade to Pro" menu items, buttons and plugin-row links;
BetterDocs' usage-tracking offer is answered "No thanks" on the build) and asks before AnyPress Host is turned off.
Licence and add-on pages stay, for Pro licences the owner buys.

## How a storefront is connected

Nothing that connects a storefront ships in the template; `build.sh` fails if the API settings are filled in. When the
API creates a storefront for a product, it:

- makes that product a new API key labelled **Ready-made storefront**;
- writes `ANYPRESS_API_BASE_URL` (the API's `PUBLIC_URL`), `ANYPRESS_API_KEY`, `ANYPRESS_API_SECRET` and a random
  `ANYPRESS_HOST_KEY_ENCRYPTION_KEY` into wp-config, the last three as private constants, so AnyPress Host's connection
  settings show them as set in wp-config;
- sets the site title, the admin email and AnyPress Host's website domain (`PLATFORM_DOMAIN`), and creates the owner as
  an administrator. The owner signs in with **Lost your password?** on the storefront's login page;
- when the seller said on their application which kinds of sites they sell and who their customers are, writes them to
  the option `anypress_storefront_setup`. On the first visit the storefront makes its pages again from the kit kept in
  `wp-content/anypress-storefront`: only those kinds of plans stay published, only the matching Who we help pages, and
  none when no customer group fits. "Not sure yet" keeps every kind.

The storefront is a store of the storefront product (`STOREFRONT_PRODUCT_ID`), so it gets what every store gets:
nightly backups, the page cache for visitors with no cookies (a cart or a login always skips it), email through the
platform's relay, and its own domains.

What the owner still does: connect a payment method in FluentCart and turn search engines on. Everything else (words,
prices, call times) works as shipped and can be changed.

## Build and publish

The build needs Docker and Node 22.18 or newer (it reads the price list from `src/pricing.ts`).

```sh
git -C ../waas-plugins checkout anypress-host-v2.20.0
templates/seller-storefront/build.sh ../waas-plugins 2.20.0
WAAS_API_URL=https://api.example.com WAAS_KEY=<storefront product key> WAAS_SECRET=<secret> templates/seller-storefront/publish.sh v1.0.0 --production
```

Then set `STOREFRONT_PRODUCT_ID` on the API to that product's id. Plugin versions and SHA-256 checksums are pinned in
`PLUGINS` at the top of `build.sh`. The archive's format is the [starter template's](../starter-fluentcart/README.md#format).

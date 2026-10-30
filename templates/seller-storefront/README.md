# Seller storefront

The template for ready-made storefronts: a WordPress site that sells websites with WaaS Host, for a customer
who doesn't bring a WordPress site of their own. The API builds one with
`POST /admin/products/{productId}/storefront` ([`src/storefronts.ts`](../../src/storefronts.ts)).

| | |
|---|---|
| WordPress | 7.1.4 for the build; storefronts run `wordpress:7.1-php8.3-apache` (version `7.1`, PHP `8.3`) |
| Theme | The AnyPress theme, the release the store template pins ([`../anypress-store/theme.sh`](../anypress-store/theme.sh)), the only theme installed |
| Plugins | WaaS Host (built from [`waas-plugins`](https://github.com/hamchowderr/waas-plugins) `packages/waas-host` with its release script, at the version given to `build.sh`), FluentCart 2.2.0, FluentCRM 3.3.1, Fluent Forms 6.2.16, WP Fusion Lite 3.48.0 and FluentAuth 3.1.0 (free, wordpress.org), FluentKit 2.1.4 (WPManageNinja, GPL; the zip in `../anypress-store/plugins`) and AnyPress Blocks 0.3.0. All active |
| Pages | A whole website built from the theme's sections: Home (what a website includes, how it works, the plans, questions), How it works, Plans (FluentCart's shop, at `/plans/`), About, Questions and Contact (with the contact form), plus FluentCart's Cart, Checkout, Receipt, Review Your Order and Account. The main menu has How it works, Plans, About, Questions, Contact and Account |
| Settings | Permalinks `/%postname%/`, timezone UTC, comments and pingbacks closed, registration off, **search engines discouraged** until launch |
| Users | `waas-admin` with a random password nobody keeps. The owner's administrator account is made when the storefront is created |

[`presets.php`](presets.php) runs once on the build: FluentCart's first activation marked done, the cart icon in the
menu, renewal reminders, a terms checkbox at checkout, FluentAuth's first-run defaults with XML-RPC off, FluentKit's one dashboard (merged menus, app headers hidden), FluentCRM (no setup wizard, an unticked newsletter box at checkout
into a Newsletter list, neutral email styles, compliance settings), Fluent Forms (spam checks, the contact form emailing
the owner) and WP Fusion Lite connected to FluentCRM on the site.

The CRM is the store template's ([CRM lifecycle](../anypress-store/README.md#crm-lifecycle)), with one offering,
**Website**: a visitor who sends the contact form or leaves checkout is **Website: Interested**, a buyer
**Website: Active**, and when their last plan ends **Website: Past**. The draft automations are this template's own
([`crm-emails.json`](crm-emails.json)): a nurture series per customer group, the welcome (with a referral ask on day 31), the
win-back with the COMEBACK20 coupon, and the abandoned checkout emails. Nothing sends until
the owner publishes them.

[`mu-plugins/seller-storefront.php`](mu-plugins/seller-storefront.php) ships with the storefront. It fills FluentCRM's
business name and email from the owner's on the first visit, and keeps WP Fusion out of staging mode. To use HighLevel
or another CRM instead, the owner picks it in **Settings → WP Fusion → Setup**; the lifecycle tags follow contacts there.

## How a storefront is connected

Nothing that connects a storefront ships in the template; `build.sh` fails if the API settings are filled in. When the
API creates a storefront for a product, it:

- makes that product a new API key labelled **Ready-made storefront**;
- writes `WAAS_API_BASE_URL` (the API's `PUBLIC_URL`), `WAAS_API_KEY`, `WAAS_API_SECRET` and a random
  `WAAS_HOST_KEY_ENCRYPTION_KEY` into wp-config, the last three as private constants, so WaaS Host's connection
  settings show them as set in wp-config;
- sets the site title, the admin email and WaaS Host's website domain (`PLATFORM_DOMAIN`), and creates the owner as
  an administrator. The owner signs in with **Lost your password?** on the storefront's login page.

The storefront is a store of the storefront product (`STOREFRONT_PRODUCT_ID`), so it gets what every store gets:
nightly backups, the page cache for visitors with no cookies (a cart or a login always skips it), email through the
platform's relay, and its own domains.

What the owner still does: connect a payment method in FluentCart, then make a subscription product with the
**WaaS Provisioning** integration (WaaS Host's home page lists the steps).

## Build and publish

```sh
git -C ../waas-plugins checkout waas-host-v2.3.0-beta.11
templates/seller-storefront/build.sh ../waas-plugins 2.3.0-beta.11
WAAS_API_URL=https://api.example.com WAAS_KEY=<storefront product key> WAAS_SECRET=<secret> templates/seller-storefront/publish.sh v1.0.0 --production
```

Then set `STOREFRONT_PRODUCT_ID` on the API to that product's id. Plugin versions and SHA-256 checksums are pinned in
`PLUGINS` at the top of `build.sh`. The archive's format is the [starter template's](../starter-fluentcart/README.md#format).

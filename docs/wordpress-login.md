# Log in to WordPress

The dashboard's **Log in to WordPress** button opens a store's wp-admin already signed in, without its password. It is on every store's page and, for a seller with a ready-made storefront, on the storefront card.

## Who can use it

Anyone who can change the store: the platform admin, and a storefront's owners and admins (a reseller's team included). Team members who can only look don't get the button; they see a plain **WordPress admin** link to the login page instead.

The link signs in as the site's first administrator, the account its owner was given when the store was made.

## How it works

1. The dashboard asks the API for a link: `POST /admin/tenants/{id}/wp-login`, or `POST /admin/products/{productId}/storefront/wp-login` for a ready-made storefront (signed-in customers use the same paths under `/account`).
2. The API signs a link to the site's `/wp-json/waas-client/v1/admin-login` route (`waas-host` on a storefront) with the site's own key, the one it already uses for site editing. The link holds the time, a random value and the signature: no password, no user name.
3. The site's plugin checks the signature, signs the browser in and opens wp-admin.

A link works **once** and for **5 minutes**. Pressing the button again makes a new one. An expired or used link shows a short message with a link to the normal login page.

## Requirements

- WaaS Client 2.10.0 or later on the store (it comes with the store template), or WaaS Host 2.8.0 or later on a ready-made storefront.
- The store is Done, not suspended, and has an address.

On a site whose plugin is older, the API answers `oneClick: false` with the site's login page, and the dashboard opens that and says so.

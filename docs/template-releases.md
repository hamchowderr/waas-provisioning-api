# Template releases

New store templates go live without anyone publishing them by hand.

1. **A pin moves, or a template changes.** The **Update pins** workflow (hourly, [`.github/pins/README.md`](../.github/pins/README.md)) moves
   the store template's pins to their newest releases: the AnyPress theme, AnyPress Blocks, AnyPress Client
   (`templates/anypress-store/CLIENT_VERSION`), WordPress and the wordpress.org plugins. Its pull request merges once
   CI passes. Any other pull request that changes a template (not only its README) counts the same.
2. **The template is built and checked.** A merge that changes `templates/` starts **Release templates**. It builds
   the store template, then runs it on WordPress Playground as every site type in `roles.json`: every wp-admin screen
   and the home page must load without a PHP error, with only that site type's plugins on. Then it restores the built
   zip as a new store gets it (`templates/anypress-store/restore-check.sh`: the store's own compose file in Docker,
   the agent's `restore`), and every site type must serve its pages, REST API and MCP server with no PHP error.
   Only then does it publish
   a `templates-v<version>` release, with `checks.txt` listing what passed.
3. **The API makes it production.** Every 15 minutes the API looks for a newer release that carries `checks.txt`
   (a release made without the checks is never published). It checks `anypress-store.zip` against `SHA256SUMS`,
   publishes it as the next version of the store template product (`STORE_TEMPLATE_PRODUCT_ID`, named after the
   product's highest version, e.g. v1.1.30 after v1.1.29) and, once built, makes it production. The product's stores
   move to it (a store whose move fails is put back), and storefronts that follow the product get a copy. The previous
   production version stays, to go back to.

Without `STORE_TEMPLATE_PRODUCT_ID` the API publishes nothing by itself. The `template_releases` table keeps each
release the API published, its version and whether it became production.

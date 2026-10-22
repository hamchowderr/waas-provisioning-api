# Plugin choices

Sellers and resellers bring their own plugins. A storefront's **plugin choices** are wordpress.org plugins, or
premium plugins uploaded as zips, that its stores get on top of its template, or template plugins it switches off, for some or all of the template's site
types. They are applied to every version as it builds, so stores get them when they move to that version.

Why on versions and not on single stores: moving a store to a version replaces its plugins and themes with the
version's code, and WaaS Client turns plugins on and off from the version's `roles.json`. A plugin installed by
hand on one store is gone after its next move. A plugin choice is part of every version from then on.

## Making choices

| Call | What it does |
|---|---|
| `GET /v1/plugin-choices/search?q=forms&page=1` | The wordpress.org directory's own search (the one wp-admin's Add Plugins screen uses), 24 a page, with each plugin's icon, name, rating, active installs, last update, "tested up to" and the PHP it needs. `blocked` says why a plugin can't be added (below) |
| `GET /v1/plugin-choices` | The storefront's choices and its reseller's. `inProduction` says whether the production version has the choice as it is now. `?checkUpdates=true` adds `latestVersion` for each added plugin |
| `PUT /v1/plugin-choices/{slug}` `{"siteTypes": ["website"]}` | Adds the plugin, pinned to its newest version (or `"version": "6.0.0"`). Its zip is downloaded now and kept, with its SHA-256, so every version built later gets exactly those files |
| `PUT /v1/plugin-choices/{slug}` `{"action": "off", "siteTypes": ["store"]}` | Takes a plugin the template has out of those site types. Its files stay; WaaS Client leaves it switched off |
| `DELETE /v1/plugin-choices/{slug}` | Removes the choice. Versions built from now on leave that plugin as the template has it |

`siteTypes` are the template's site types, the keys of its `roles.json` (AnyPress's template: `website`, `bookings`,
`online-store`, `community`, `everything`, `store`). Empty or left out means all of them. A site type the template
doesn't have fails the version build with a message naming the ones it has.

At most 25 plugins added per storefront (and 25 per reseller). AnyPress's own template is never changed by any of
this: choices only change the versions of the storefront that made them.

The same calls are on the admin API at `/admin/products/{productId}/plugin-choices`, which the dashboard uses for a
signed-in seller (`/account/products/{productId}/plugin-choices`), and for a reseller's shared choices at
`/admin/resellers/{resellerId}/plugin-choices`.

## Premium plugins

A plugin that isn't on wordpress.org (Gravity Forms, a theme vendor's add-on, a seller's own plugin) is uploaded as
the zip its vendor ships:

| Call | What it does |
|---|---|
| `POST /v1/plugin-choices/uploads` | Starts an upload: `{id, uploadUrl, expiresIn, maxBytes}`. PUT the zip (up to 64 MB) to `uploadUrl` within the hour |
| `POST /v1/plugin-choices/uploads/{id}/check` | Checks the zip and answers the upload with `status` `ready` or `rejected` (and `reason`) |
| `PUT /v1/plugin-choices/{slug}` `{"uploadId": "…", "licence": {"GF_LICENSE_KEY": "…"}}` | Adds the checked plugin. `slug` is the plugin's folder in the zip |
| `GET /v1/plugin-choices/uploads` | The uploads, newest first |
| `DELETE /v1/plugin-choices/uploads/{id}` | Deletes an upload no choice (and no version still building) uses. Versions already built keep their copy |

The check reads the zip without unpacking it on the server: one top-level folder named like a plugin slug, a PHP
file in it with a `Plugin Name:` header (its `Version:` is kept), no paths that leave that folder, at most 300 MB
unpacked, no password, and none of the obfuscated code that hacked or "nulled" copies of premium plugins carry
(eval of decoded strings or of request input, known web shells). The blocked list below applies too. A rejected
zip is deleted. A new release of the plugin is a new upload: check it, then `PUT` the choice with its `uploadId`.

`licence` holds PHP constants that stores get with the plugin, which is how most premium plugins take a licence key
without anyone signing in to wp-admin. Up to 10, upper-case names, values up to 500 characters. They are stored
encrypted, only decrypted while a version builds, and never answered: a choice lists their names in
`licenceConstants`. Leaving `licence` out when saving keeps them; `null` removes them. Saving an uploaded choice
again without `uploadId` or `version` keeps its upload.

## Resellers

A reseller's choices apply to all its storefronts. A partner key without a `productId`, or with
`?productId=…&shared=true`, works on them; with a `productId`, on that storefront's own. When both have a choice
for the same plugin, the storefront's wins: a storefront can switch off (`"action": "off"`) a plugin its reseller
added, or pin another version of it.

## Plugins stores can't have

Some plugins clash with the hosting and are refused:

- page caching (WP Super Cache, W3 Total Cache, LiteSpeed Cache, …): the hosting caches pages;
- backups and site moving (UpdraftPlus, Duplicator, All-in-One WP Migration, WP Staging, …): the hosting backs stores up and moves sites;
- SMTP plugins (WP Mail SMTP, FluentSMTP, Post SMTP, …): stores send through the platform's relay, which counts their email against the plan;
- file managers: a store's code is replaced with each version's;
- firewalls that rewrite the server setup (Wordfence, Solid Security, All-In-One Security, …);
- update managers: updates come with each new version;
- the platform's own plugins.

The list is `BLOCKED` in [`src/pluginchoices.ts`](../src/pluginchoices.ts).

## Updates

A choice stays on its version until it is saved again: `PUT` it with no `version` to move it to the newest (or with
the one you want), then build a new version and make it production. `inProduction` turns false for a changed choice
until then.

## How a version build applies them

When a version is made, the storefront's choices as they are then are stored with it (`versions.plugin_choices`).
The build restores the version's source into its version site and runs the store agent's `plugins` step before the
code is exported:

1. It undoes choices an earlier build applied to the archive (one from another version or a store snapshot): the
   plugins they added are removed and `roles.json` goes back to the template's own (`roles.template.json`).
2. Each added plugin's zip is fetched from the platform's bucket (`plugins/wporg/<slug>/<version>.zip`, or
   `plugins/uploads/<id>.zip` for an upload), checked
   against its SHA-256 and unpacked into `wp-content/plugins/<slug>`. Its main file (the PHP file with a
   `Plugin Name:` header) is added to the chosen site types in `roles.json`.
3. Plugins switched off are taken out of those site types.
4. Licence constants go in one small plugin, `000-plugin-licences`, that every site type loads first.

The list, with signed links to the zips, reaches the agent as a file (`versions/<id>/plugin-choices.json`),
being too long for a task command. It can hold licence keys, so it is deleted as soon as the step has run. The plugin file of each added plugin is kept with the version. A template
without `roles.json` can't take added plugins: the build fails and says so.

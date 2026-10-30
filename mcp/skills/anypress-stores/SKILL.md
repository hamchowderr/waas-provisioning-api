---
name: anypress-stores
description: Create and manage WordPress stores on AnyPress (the WaaS provisioning API) through its MCP server - launching a store, putting it on a custom domain, setting up its sending domain, backups, suspend/resume and restores, and editing a store's pages, sections, colours, fonts, header, footer and menus. Use whenever the user asks to do something with their AnyPress or WaaS stores and the waas-provisioning MCP tools are connected.
license: GPL-3.0-or-later
---

# Managing AnyPress stores

The `waas-provisioning` MCP server exposes the store API as tools. A store is called a **tenant** in the API. Pick a store by `externalId` (the user's own id, e.g. an order or subscription id; what the WaaS Host plugin uses) or by `tenantId`. Prefer `externalId` when you have it.

Most tools take an `action`, e.g. `manage_domain` with `action: "add"`. The tools by area:

| Area | Tools (actions) |
|---|---|
| Stores | `show_stores`, `show_store`, `get_stores` (list, get, wait, move_in), `create_store`, `import_site` (start, new_code), `update_store` (options, move), `store_status` (suspend, resume, go_live, delete) |
| Backups | `show_store_backups`, `manage_backups` (list, create, restore) |
| Domains | `show_store_domains`, `manage_domain` (list, check, connect_link, add, set_main, remove) |
| Email | `mail_domain` (get, set, remove) |
| Versions | `manage_versions` (list, snapshots, templates, create, set_production, delete) |
| Webhooks | `manage_webhooks` (list, get, deliveries, create, update, test, retry, rotate_secret, delete) |
| Website pages and design | `get_site`, `site_pages` (list, read, revisions, create, update, restore_revision), `page_section` (add, replace, remove), `site_patterns` (find, get), `site_styles` (get, update), `header_footer` (get, update), `site_menus` (list, update), `add_image` |

## Rules that apply to everything

- **Writes are asynchronous.** `create_store`, `manage_backups` restore, `update_store` and domain changes return as soon as the work is scheduled. The store then shows `statusCode` 0 (Pending) until it reaches 1 (Done) or 2 (Failed). Call `get_stores` with `action: "wait"` before telling the user it's ready, and before the next write to the same store. If it returns `done: false`, call it again; store setup can take a few minutes.
- **Ask before anything destructive.** `store_status` delete and suspend (suspend takes the site offline), `manage_backups` restore (it replaces the live files and database), `manage_domain` remove, `mail_domain` remove, `manage_versions` delete, `manage_webhooks` rotate_secret and delete, `page_section` remove and `store_status` go_live need the user's explicit yes for that store. Name the store and what will happen.
- **Show, don't dump.** When the user wants to see their stores, call `show_stores`; for one store, `show_store`; for its backups or domains, `show_store_backups` or `show_store_domains`. Clients that support MCP Apps render these as interactive screens. Otherwise summarize: name, status, main domain. Don't paste raw JSON unless asked.
- **Errors carry the API's reason.** A tool error reads `The API refused <operation> (HTTP <status>): <message>`. Relay the message plainly and suggest the fix; don't retry a 400 unchanged.
- If a tool or action is missing, the server may be read-only (`/mcp/read-only` or `WAAS_MCP_READ_ONLY=1`), or the connection wasn't allowed that area: whoever connected the app ticks what it may see and change per area (stores, backups, domains, email, versions, website pages and design). A tool then offers only the actions it may use. Say so, and that reconnecting can allow more, instead of looking for a workaround.

## Launch a store

1. Pick the version: new stores go on the production version unless the user names one (`manage_versions` list). To start from a specific template or snapshot, find it with `manage_versions` snapshots and pass `snapshotId`, or pass `groupName`.
2. `create_store` with `name` (at most 30 characters, starting and ending with a letter or digit) and an `externalId` (letters, digits and `-` only). If the user gives a custom domain up front, pass it as `customDomainName`.
3. `get_stores` wait. Report the store's main domain (`domainName`) when it is Done.

Repeating `create_store` with the same `externalId` answers with the store it already made, so it's safe to retry after a timeout.

## Move an existing site in

1. `import_site` with `action: "start"`, a `name`, an `externalId` and a `size` big enough for the site's files and database. It answers an `importCode` and `pluginDownload`.
2. Tell the site owner: install the AnyPress Export plugin from `pluginDownload` on the old site, open Tools → Move to AnyPress and paste the code (or run `wp anypress-export send <code>`). Their old site is not changed. The code works for 7 days; `import_site` with `action: "new_code"` gives a fresh one.
3. `get_stores` with `action: "wait"` until it is Done (the store stays Pending until the upload arrives and the move finishes, so call it again when it returns `done: false`). The site keeps its own plugins and themes.
4. `get_stores` with `action: "move_in"` says how the move went: any `warnings` to check and, in `siteReport`, what the site runs. For each form, shop, CRM, booking, support, affiliate or community plugin it lists the counts, whether a Fluent plugin can bring that data in (`route`, `needsPro`), what a switch would lose (`willLose`) and what to fix first (`blockers`, such as live payment keys). Tell the user about the blockers.
5. The moved site is **on hold** (`onHold: true`): it only sends email to the store's owner and account emails, doesn't run its scheduled tasks and asks search engines not to index it, so the old and new site don't both email customers or take orders. Tell the user, and have them check the site at its new address.
6. Put it on the customer's domain as below. Once the old host has stopped (or the user says the new site should take over), `store_status` with `action: "go_live"`, then `get_stores` wait. Ask first: from then on the site sends all its email and runs its scheduled tasks.

## Put a store on the customer's own domain

1. `manage_domain` check with the `domainName`.
2. Point the domain at the platform. `manage_domain` connect_link with `service: "website"` returns a link the domain owner opens to add the DNS records in one click. When `supported` is false (their DNS host doesn't support Domain Connect, or hasn't accepted the platform's template yet), they add the DNS records by hand.
3. `manage_domain` add (with `setAsMainDomain: true` to make it the address WordPress uses), then `get_stores` wait.
4. To switch the main domain later, use `manage_domain` set_main. The store's other domains redirect to the main one.

## Send email from the store's own domain

1. `mail_domain` set with the `domainName` (e.g. `mail.example.com` or the store's domain). It returns the DNS records to add.
2. Offer `manage_domain` connect_link with `service: "email"` so the owner can add them in one click (when `supported` is true).
3. `mail_domain` get shows whether the records verify. Until they do, the store keeps sending from the platform address.

## Backups, suspend and restore

- `manage_backups` create takes a full backup (files and database); `manage_backups` list shows it reach Done.
- `store_status` suspend takes the store offline and backs it up first (`takeBackup` defaults to true). `store_status` resume brings it back. Typical uses are a lapsed subscription or a dispute.
- `manage_backups` restore re-creates a deleted store, or rolls a live one back, from a backup (the newest finished one unless `backupId` is given). Backups are kept for the retention period after deletion. Always confirm with the user first, then `get_stores` wait.
- `store_status` delete keeps backups for the retention period, so a deleted store can still be restored until then. Mention this when the user hesitates.

## WordPress settings

`update_store` options sets WordPress options (`wpOptions`: option name to value) and PHP constants (`phpConstants`: name to `{ value, isPrivate }`). Mark secrets such as license keys `isPrivate: true`. Its `size` (`small`, `medium` or `large`) moves the store to another size, restarting it once; `create_store` takes a `size` too (small when omitted).

## Versions

A version is a staging WordPress (a PHP and WordPress version) that stores are made from. `manage_versions` create, then poll `manage_versions` list until it is Done, and `manage_versions` set_production makes new stores use it. `update_store` move (with `targetVersionId`) moves an existing store. `manage_versions` delete only works once no store is on it.

## Edit a site's pages and design

The site tools work on one store's WordPress directly (no waiting needed) and need the store to be Done and not suspended.

1. `get_site`, then `site_pages` list. Before changing a page, `site_pages` read: its outline numbers the sections from 0.
2. **Build from the theme.** `site_patterns` find (e.g. `search: "hero"`, `"pricing"`, `"testimonial"`, `"contact"`) and `page_section` add with `pattern` give sections that match the site's design. Then `site_pages` read and `page_section` replace to swap the pattern's sample text and images for the user's own.
3. **Change one part at a time.** To edit text, copy that section's markup from `site_pages` read, change only what was asked, and `page_section` replace. Use `site_pages` update with `content` only to rewrite a whole page.
4. **Use the theme's tokens.** `site_styles` get lists colour, font-size and spacing slugs; use them in blocks (`"backgroundColor":"primary"`, `"fontSize":"large"`) instead of raw values, so the page follows later style changes.
5. **Site-wide look:** `site_styles` update (e.g. `styles.elements.button.color.background`, `styles.typography.fontFamily`, or new colours in `settings.color.palette.custom`). Header and footer: `header_footer` get then update, with `part`. Menus: `site_menus` list then update.
6. **New pages are drafts.** `site_pages` create returns a preview link; share it and publish (`site_pages` update with `status: publish`) only when the user says so. For a whole new page, start from a starter page (`site_patterns` find with `category: "anypress/pages"`). On stores with the AnyPress theme, a kit (Ridge for trades, Hearth for food, Still for wellness, Ledger for professional services, Parcel for shops, Chapter for courses, Gloss for salons, Commons for associations and churches, Rep for gyms, Frame for portfolios, Keystone for real estate, Launch for software, Byline for blogs) is a style plus its own home page and sections in `anypress/kit-*`: apply the style with `site_styles` and use the kit's home page together. AnyPress Blocks are the shared sections that work with any kit (`anypress/blocks-*`: heroes, about, services, proof, calls-to-action, contact, blog, footers). Add the page to the menu if they want it there.
7. **Undo:** `site_pages` revisions and restore_revision. `page_section` remove needs the user's yes; it can be undone the same way.
8. Images: `add_image` with a public https link, then use the returned id and address in an image or cover block. Always give `alt` text.

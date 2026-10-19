---
name: anypress-stores
description: Create and manage WordPress stores on AnyPress (the WaaS provisioning API) through its MCP server - launching a store, putting it on a custom domain, setting up its sending domain, backups, suspend/resume and restores. Use whenever the user asks to do something with their AnyPress or WaaS stores and the waas-provisioning MCP tools are connected.
license: GPL-3.0-or-later
---

# Managing AnyPress stores

The `waas-provisioning` MCP server exposes the store API as tools. A store is called a **tenant** in the API. Pick a store by `externalId` (the user's own id, e.g. an order or subscription id; what the WaaS Host plugin uses) or by `tenantId`. Prefer `externalId` when you have it.

## Rules that apply to everything

- **Writes are asynchronous.** `create_store`, `restore_store`, `move_store_to_version` and domain changes return as soon as the work is scheduled. The store then shows `statusCode` 0 (Pending) until it reaches 1 (Done) or 2 (Failed). Call `wait_for_store` before telling the user it's ready, and before the next write to the same store. If `wait_for_store` returns `done: false`, call it again; store setup can take a few minutes.
- **Ask before anything destructive.** `delete_store`, `restore_store` (it replaces the live files and database), `suspend_store` (takes the site offline), `remove_store_domain`, `remove_store_mail_domain` and `delete_version` need the user's explicit yes for that store. Name the store and what will happen.
- **Show, don't dump.** When the user wants to see their stores, call `show_stores`: clients that support MCP Apps render an interactive panel. Otherwise summarize: name, status, main domain. Don't paste raw JSON unless asked.
- **Errors carry the API's reason.** A tool error reads `The API refused <operation> (HTTP <status>): <message>`. Relay the message plainly and suggest the fix; don't retry a 400 unchanged.
- If a tool is missing, the server may be read-only (`/mcp/read-only` or `WAAS_MCP_READ_ONLY=1`). Say so instead of looking for a workaround.

## Launch a store

1. Pick the version: new stores go on the production version unless the user names one (`list_versions`). To start from a specific template or snapshot, find it with `list_snapshots` and pass `snapshotId`, or pass `groupName`.
2. `create_store` with `name` (at most 30 characters, starting and ending with a letter or digit) and an `externalId` (letters, digits and `-` only). If the user gives a custom domain up front, pass it as `customDomainName`.
3. `wait_for_store`. Report the store's main domain (`domainName`) when it is Done.

Repeating `create_store` with the same `externalId` answers with the store it already made, so it's safe to retry after a timeout.

## Put a store on the customer's own domain

1. `check_domain_availability` for the domain.
2. Point the domain at the platform. `get_domain_connect_link` with `service: "website"` returns a link the domain owner opens to add the DNS records in one click. When `supported` is false (their DNS host doesn't support Domain Connect, or hasn't accepted the platform's template yet), they add the DNS records by hand.
3. `add_store_domain` (with `setAsMainDomain: true` to make it the address WordPress uses), then `wait_for_store`.
4. To switch the main domain later, use `set_store_main_domain`. The store's other domains redirect to the main one.

## Send email from the store's own domain

1. `set_store_mail_domain` with the domain (e.g. `mail.example.com` or the store's domain). It returns the DNS records to add.
2. Offer `get_domain_connect_link` with `service: "email"` so the owner can add them in one click (when `supported` is true).
3. `get_store_mail_domain` shows whether the records verify. Until they do, the store keeps sending from the platform address.

## Backups, suspend and restore

- `create_store_backup` takes a full backup (files and database); `list_store_backups` shows it reach Done.
- `suspend_store` takes the store offline and backs it up first (`takeBackup` defaults to true). `resume_store` brings it back. Typical uses are a lapsed subscription or a dispute.
- `restore_store` re-creates a deleted store, or rolls a live one back, from a backup (the newest finished one unless `backupId` is given). Backups are kept for the retention period after deletion. Always confirm with the user first, then `wait_for_store`.
- `delete_store` keeps backups for the retention period, so a deleted store can still be restored until then. Mention this when the user hesitates.

## WordPress settings

`update_store_options` sets WordPress options (`wpOptions`: option name to value) and PHP constants (`phpConstants`: name to `{ value, isPrivate }`). Mark secrets such as license keys `isPrivate: true`. Its `size` (`small`, `medium` or `large`) moves the store to another size, restarting it once; `create_store` takes a `size` too (small when omitted).

## Versions

A version is a staging WordPress (a PHP and WordPress version) that stores are made from. `create_version`, then poll `list_versions` until it is Done, and `set_production_version` makes new stores use it. `move_store_to_version` moves an existing store. `delete_version` only works once no store is on it.

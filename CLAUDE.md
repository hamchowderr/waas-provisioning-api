# WaaS provisioning API: agent guide

The AnyPress backend: a Hono API on Node 22 with Postgres and pg-boss jobs, which builds and runs every customer store (a "tenant") on Coolify, plus the SDKs, the MCP server and the store templates. Words used (store, storefront/product, version, base snapshot): the README's glossary.

| Folder | What's there |
|---|---|
| `src/` | The API (`app.ts` wires routes; `provisioner/` talks to Coolify; `jobs.ts` and `queue.ts` run background work) |
| `migrations/` | SQL migrations, named `<timestamp>_<name>.sql`; add a new file, never edit an applied one |
| `openapi/` | The API's OpenAPI files; the TypeScript SDK types are generated from them |
| `sdk/` | TypeScript and PHP SDKs (`docs/publishing.md`) |
| `mcp/` | The AnyPress MCP connector and its skills |
| `integrations/` | n8n node, Zapier app, Make app |
| `templates/` | Store templates: `anypress-store` (what shop.anypress.io sells), `starter-fluentcart`, `seller-storefront` |
| `install/` | The self-hosting installer |

## Building and testing

Run what CI runs before pushing: `npm ci`, `npm run typecheck`, `npm run sdk:check`, `npm test` (tests need a Postgres database in `TEST_DATABASE_URL`). After changing an OpenAPI file run `npm run sdk:generate` and commit the result. Merging to `main` redeploys the live API.

## Store templates

- `templates/anypress-store/README.md` lists the WordPress and PHP versions, the theme and every plugin with its pinned version and checksum. Change a pin there and in the build together, and check wordpress.org for the version first.
- A template change only reaches new stores when a new template version is built, published and made production for the shop. That is a publish to customers: do it when the owner has asked for it, then make a test store on it and check what changed.
- `templates/release.sh` builds the zips; the **Release templates** workflow (`templates-v<version>`) attaches them to a GitHub release for self-hosters.

## Building for WordPress

- Use the WordPress skills in `.claude/skills/` (list in its README): `wp-block-themes` and `wp-patterns` for the theme, starter pages and presets, `wp-wpcli-and-ops` for build scripts, `wp-playground` and `blueprint` for trying a template, `wp-performance` for store speed.
- Stores run WordPress 7.1 on PHP 8.3, each with its own WordPress and MariaDB containers. New stores get the **AnyPress theme** (`templates/anypress-theme`), the only one installed; stores made before it run Ollie. Build pages and starter patterns from the theme's own sections (AnyPress Blocks and the kits) and its `theme.json` colour, font and spacing slugs, not fixed colours or pixel sizes, so owners can restyle them in the Site Editor and agents can edit them through the site tools. Customer stores are edited in WordPress, never headless.
- Code in `mu-plugins/` runs on every request of every store, and stores share one server: keep it cheap, and do one-time work once (behind an option flag), not on each page load.

## Rules for every change

- **Beads, every time.** Each piece of work gets a Beads issue before it starts (check for a duplicate first). Put the id in the branch, the PR and the status, and close the issue when the PR merges or the change is live. Run `bd` in the session doing the work; the SessionStart hook in `.claude/settings.json` loads the Dolt login, then `bd dolt push` syncs it. This repository's issues are in DoltHub `chowderr/waas_api (ids `waas-api-*`)`.
- **Pull requests:** open them ready for review, not as drafts, so CI runs. Merge a PR yourself once CI is green and the work was asked for.
- **No "WPCS" wording.** The old platform is gone. Say "the AnyPress API" or "the API's key and secret login". Don't add the word anywhere; existing identifiers that live sites depend on (plugin slugs such as `wpcs-waas-host`, update URLs) stay until a planned migration.
- **Public docs are for users.** READMEs and `docs/` explain how to use and run the code. Internal notes (server and Coolify ids, Beads, deployment steps) go in the obsidian-vault repository under `1. Projects/WaaS/`. Never put how or why AnyPress started in public copy.
- **Verify before claiming.** Check npm, wordpress.org or the official docs before calling a version or spec "the latest", and check a fix on the running system before calling it fixed.

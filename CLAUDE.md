# WaaS provisioning API: agent guide

The AnyPress backend: a Hono API on Node 22 with Postgres and pg-boss jobs, which builds and runs every customer store (a "tenant") on Coolify, plus the SDKs, the MCP server and the store templates. Words used (store, storefront/product, version, base snapshot): the README's glossary.

| Folder | What's there |
|---|---|
| `src/` | The API (`app.ts` wires routes; `provisioner/` talks to Coolify; `jobs.ts` and `queue.ts` run background work) |
| `migrations/` | SQL migrations, named `<timestamp>_<name>.sql`; add a new file, never edit an applied one |
| `openapi/` | The API's OpenAPI files; the TypeScript SDK types are generated from them |
| `sdk/` | TypeScript and PHP SDKs (`docs/publishing.md`) |
| `mcp/` | The AnyPress MCP connector and its skills |
| `agent/` | The website assistant (Mastra), its own package; tests run it against the API and on Playground |
| `voice/` | The phone receptionist (LiveKit Agents), its own package; it answers a store's calls through `src/voice.ts` |
| `integrations/` | n8n node, Zapier app, Make app |
| `templates/` | Store templates: `anypress-store` (what shop.anypress.io sells), `starter-fluentcart`, `seller-storefront` |
| `install/` | The self-hosting installer |

## Building and testing

Run what CI runs before pushing: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run sdk:check`, `npm test` (tests need a Postgres database in `TEST_DATABASE_URL`). `npm run deadcode` (Fallow, `.fallowrc.json`) fails on unused files, exports, types and packages: remove them rather than ignoring them; on a pull request CI also runs `fallow audit`, which fails on duplicated or overly complex code the change adds. After changing an OpenAPI file run `npm run sdk:generate` and commit the result. Merging to `main` redeploys the live API.

## Store templates

- `templates/anypress-store/README.md` lists the WordPress and PHP versions, the theme and every plugin with its pinned version and checksum. The **Update pins** workflow moves every pin in `.github/pins.json` (build, `theme.sh` and README together) to its newest release every hour and merges it once CI passes; CI fails when a pin is behind an AnyPress release (`.github/pins/README.md`). A new pinned file goes into `.github/pins.json` in the same PR.
- Template versions publish themselves (`docs/template-releases.md`, owner's standing approval): a merge that changes `templates/` starts **Release templates**, which builds the zips (`templates/release.sh`), checks every site type on WordPress Playground and releases `templates-v<version>` with `checks.txt`; the API then publishes it to `STORE_TEMPLATE_PRODUCT_ID` and makes it production. Don't build or publish a template by hand; if a check fails, fix the cause and merge. AnyPress Client comes from the release in `templates/anypress-store/CLIENT_VERSION`.

## Building for WordPress

- Use the WordPress skills in `.claude/skills/` (list in its README): `wp-block-themes` and `wp-patterns` for the theme, starter pages and presets, `wp-wpcli-and-ops` for build scripts, `wp-playground` and `blueprint` for trying a template, `wp-performance` for store speed.
- Stores run WordPress 7.1 on PHP 8.3, each with its own WordPress and MariaDB containers. New stores get the **AnyPress theme** (its own repository, `hamchowderr/anypress-theme`; `templates/anypress-store/theme.sh` pins the release the template installs), the only one installed; stores made before it run Ollie. Build pages and starter patterns from the theme's own sections (AnyPress Blocks and the kits) and its `theme.json` colour, font and spacing slugs, not fixed colours or pixel sizes, so owners can restyle them in the Site Editor and agents can edit them through the site tools. Customer stores are edited in WordPress, never headless.
- Code in `mu-plugins/` runs on every request of every store, and stores share one server: keep it cheap, and do one-time work once (behind an option flag), not on each page load.

## Rules for every change

- **Playground only for tests.** Never create a store, product (seller), reseller or ready-made storefront on the server to try, check or demo something. Check on WordPress Playground (the WordPress skills in `.claude/skills/`, and the plugins repo's `scripts/playground`). The API's own tests cover the server building stores. If a check truly can't run on Playground, ask the owner first, say why, and delete the store as soon as the check is done. Never keep test stores.
- **Store tests run as a site type.** Every Playground test, preview or screenshot of a customer store is one of the store template's site types (the keys of `waas-provisioning-api/templates/anypress-store/roles.json`: website, bookings, online-store, community, everything, highlevel), with AnyPress Client on and `ANYPRESS_TENANT_ROLES` set, so only that type's plugins are on, as on a real store. Never a WordPress with every plugin on and no site type. Say which site type in the report or screenshot.
- **Beads, every time.** Each piece of work gets a Beads issue in the list of the repository it changes, before it starts (check for a duplicate first). Put the id in the branch, the PR and the status, and close the issue when the PR merges or the change is live. Run `bd` in the session doing the work; the SessionStart hook in `.claude/settings.json` loads the Dolt login and sets up `.beads` from DoltHub, then `bd dolt push` syncs it. This repository's issues are in DoltHub `chowderr/waas_api` (new ids `waas-api-*`; issues moved here from another list keep their old ids). Each AnyPress repository has its own list. Work that also changes another repository gets an `also:<repo>` label (`api`, `plugins`, `dashboard`, `site`, `theme`, `blocks`, `fluentsuite`), and a task whose epic is in another list gets `epic:<id>`. Jobs that change no code (accounts, outreach, server and shop settings) go in AnyPress Ops (`chowderr/anypress_ops`, in the obsidian-vault repository under `1. Projects/WaaS/AnyPress Ops/`).
- **Pull requests:** open them ready for review, not as drafts, so CI runs. Merge a PR yourself once CI is green and the work was asked for.
- **No "WPCS" wording.** The old platform is gone. Say "the AnyPress API" or "the API's key and secret login". Don't add the word anywhere; existing identifiers that live sites depend on (plugin slugs such as `anypress-host`, update URLs) stay until a planned migration.
- **Public docs are for users.** READMEs and `docs/` explain how to use and run the code. Internal notes (server and Coolify ids, Beads, deployment steps) go in the obsidian-vault repository under `1. Projects/WaaS/`. Never put how or why AnyPress started in public copy.
- **Official SDKs, always.** Call every outside service through its official SDK or library (Stripe: `stripe`, toSend: `tosend`, S3 and R2: `aws4fetch`, HighLevel: `@gohighlevel/api-client`, sign-in: Better Auth and its plugins) and configure it to fit, rather than writing the HTTP calls by hand. Read the SDK's options before deciding it doesn't fit. Only where no official SDK exists, write the client yourself and say so in the PR. `npm run lint` fails on hand-written calls to these services.
- **Verify before claiming.** Check npm, wordpress.org or the official docs before calling a version or spec "the latest", and check a fix on the running system before calling it fixed.

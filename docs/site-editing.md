# Site editing

An AI agent connected to the API's MCP server (`/mcp`) can change a store's pages and design: add a page, put a ready-made section on it, rewrite its text, change the site's colours and fonts, edit the header, footer and menus, and undo through revisions. The store's own plugin, WaaS Client (2.3.0 or newer), does the work in WordPress; the API passes each request on, signed for that store only.

## How a request reaches the store

1. The agent calls an MCP tool, e.g. `add_section` for the store `store-1042`.
2. The tool calls `POST /v1/tenants/site?externalId=store-1042` with `{ "method": "POST", "path": "/pages/12/sections", "body": { "pattern": "ollie/hero-light" } }`.
3. The API checks the caller owns the store and that it is Done and not suspended, signs the request with the store's **site key** and sends it to `https://<main domain>/wp-json/waas-client/v1/site/pages/12/sections`.
4. WaaS Client checks the signature and makes the change as the store's first administrator. Its answer comes back as `{ status, body }`.

The routes WaaS Client answers, the signature format and its safety rules are in waas-plugins' [docs/site-editing-api.md](https://github.com/hamchowderr/waas-plugins/blob/main/docs/site-editing-api.md).

## Site keys

Each store's key is derived from `SECRETS_KEY` and the store's id (HKDF, then HMAC-SHA256), so the API stores no keys and can always derive one again. The Coolify provisioner gives each store its key as the `WAAS_SITE_KEY` variable: new stores when they are created, existing stores on the API's next start (store setup 3, which re-renders the store's compose file and restarts it once).

Changing `SECRETS_KEY` changes every store's site key; stores then refuse site requests until they get the new key (bump `STORE_SETUP` to hand it out).

## MCP tools

| Tool | Does |
|---|---|
| `get_site` | Name, tagline, address, theme, home page |
| `list_pages`, `read_page` | Pages; one page's numbered sections and block markup |
| `create_page`, `update_page` | New page (a draft unless asked to publish); title, slug, status or whole content |
| `add_section`, `replace_section`, `remove_section` | One section at a time, from a pattern or blocks |
| `list_page_revisions`, `restore_page_revision` | Undo |
| `find_patterns`, `get_pattern` | The theme's ready-made sections |
| `get_site_styles`, `update_site_styles` | Colours, fonts, sizes; site-wide style changes |
| `get_header_footer`, `update_header_footer` | The header and footer every page shows |
| `list_menus`, `update_menu` | Navigation menus |
| `add_image` | Copies an image from a link into the media library |

The read-only server (`/mcp/read-only`) offers only the tools that read.

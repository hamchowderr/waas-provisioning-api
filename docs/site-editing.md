# Site editing

An AI agent connected to the API's MCP server (`/mcp`, or `/mcp/site` for a website's own owner) can change a store's pages and design: add a page, put a ready-made section on it, rewrite its text, change the site's colours and fonts, edit the header, footer and menus, and undo through revisions. The store's own plugin, WaaS Client (2.3.0 or newer), does the work in WordPress; the API passes each request on, signed for that store only.

## How a request reaches the store

1. The agent calls an MCP tool, e.g. `page_section` with action `add` for the store `store-1042`.
2. The tool calls `POST /v1/tenants/site?externalId=store-1042` with `{ "method": "POST", "path": "/pages/12/sections", "body": { "pattern": "anypress/hero-statement" } }`.
3. The API checks the caller owns the store and that it is Done and not suspended, signs the request with the store's **site key** and sends it to `https://<main domain>/wp-json/waas-client/v1/site/pages/12/sections`.
4. WaaS Client checks the signature and makes the change as the store's first administrator. Its answer comes back as `{ status, body }`.

The routes WaaS Client answers, the signature format and its safety rules are in waas-plugins' [docs/site-editing-api.md](https://github.com/hamchowderr/waas-plugins/blob/main/docs/site-editing-api.md).

## Site keys

Each store's key is derived from `SECRETS_KEY` and the store's id (HKDF, then HMAC-SHA256), so the API stores no keys and can always derive one again. The Coolify provisioner gives each store its key as the `WAAS_SITE_KEY` variable: new stores when they are created, existing stores on the API's next start (store setup 4, which re-renders the store's compose file and restarts it once).

Changing `SECRETS_KEY` changes every store's site key; stores then refuse site requests until they get the new key (bump `STORE_SETUP` to hand it out).

## Sign in with your website

A store owner who isn't on a product's team can still connect an AI app to their own site. On the connector's approve page (`/oauth/authorize`) they type the website's address. The API finds the store by any of its domains and sends them to `https://<main domain>/wp-admin/admin.php?page=waas-connect` with a link signed with the store's site key, naming the app, where it returns to and the API's answer URL.

WaaS Client's page (2.3.0) shows that to the website's administrators, and Allow or Cancel goes back to `/oauth/site/answer` signed with the same key. The API checks the signature, uses the request once, and gives the app a code for that store only (`oauth_tokens.tenant_id`), with the scope `site:read`, plus `site:write` when the owner allowed changes. That connection gets only the site tools, and every call goes to its own store whatever store the agent names. The token stops working when the store is deleted.

### Signed in by the storefront

A storefront that has already signed in the store's owner (its customer account page) can skip that step for the website assistant. It calls `POST /v1/tenants/site/handoff?externalId=…` with the storefront's key and the assistant's `assistantUrl`, and the answer is the assistant's address with a one-time handoff. The assistant trades that handoff at `POST /oauth/site/handoff`, with its registered `client_id`, `redirect_uri` (which must be `<assistantUrl>/callback`) and PKCE `code_challenge`, for the same code the website's own answer gives: `site:read site:write`, this store only. It finishes the code at `/oauth/token` with its verifier. A handoff works once, for 2 minutes. The storefront's key can already edit the site through `/v1/tenants/site`, so this reaches nothing new.

`POST /v1/tenants/site/sign-in` (the storefront passes the app's own `clientId`, `redirectUri` and `codeChallenge`, and gets the code back) still works for apps that send the owner to the storefront first.

## MCP tools

Most site tools take an `action`; read actions need the `site:read` scope and write actions `site:write`.

| Tool | Actions |
|---|---|
| `get_site` | Name, tagline, address, theme, home page |
| `site_pages` | `list`, `read` (one page's numbered sections and block markup), `revisions`, `create` (a draft unless asked to publish), `update` (title, slug, status or whole content), `restore_revision` (undo) |
| `page_section` | `add`, `replace`, `remove`: one section at a time, from a pattern or blocks |
| `site_patterns` | `find`, `get`: the theme's ready-made sections and starter pages |
| `site_styles` | `get`, `update`: colours, fonts, sizes; site-wide style changes |
| `header_footer` | `get`, `update`: the header and footer every page shows |
| `site_menus` | `list`, `update`: navigation menus |
| `add_image` | Copies an image from a link into the media library |

The read-only server (`/mcp/read-only`) offers only the actions that read.

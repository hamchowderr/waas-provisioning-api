# waas-provisioning-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent create and manage stores through the WaaS provisioning API: stores and their lifecycle, backups, domains, sending domains, Domain Connect links, versions, snapshots and templates, and each store's pages and design. It is built on the [TypeScript SDK](../sdk/typescript), so its tools follow the API's OpenAPI contract, and on the v2 MCP TypeScript SDK: it speaks MCP 2026-07-28 and still serves 2025-era clients.

It comes with:

- **store screens** ([MCP Apps](https://modelcontextprotocol.io/extensions/apps)) that render inline in clients that support MCP Apps (Claude, ChatGPT, VS Code and others): `show_stores` lists your stores with back up, suspend and resume buttons; `show_store` shows one store (status, size, version, domains, and the versions it can move to); `show_store_backups` its backups, with back up and restore buttons; `show_store_domains` its domains, with add, remove and make-main buttons. Other clients get the same data as text.
- an **Agent Skill**, [`skills/anypress-stores`](skills/anypress-stores/SKILL.md), that teaches an agent the common jobs: launching a store, putting it on a custom domain, setting up its sending domain, backups and restores, and editing a store's pages and design. The server serves it too (below), so clients that support the Skills extension pick it up on their own.

> The API secret has full control of your stores. Every tool says whether it only reads or can destroy something, so clients like Claude ask before deleting or restoring a store. The read-only endpoint (or `WAAS_MCP_READ_ONLY=1`) offers only the tools and actions that read, and an OAuth connection offers only the areas you allowed (below).

## Connect over HTTP

The API serves the MCP server itself, so there is nothing to run:

| Endpoint | |
|---|---|
| `https://<your API>/mcp` | All tools |
| `https://<your API>/mcp/read-only` | Only the tools and actions that read |
| `https://<your API>/mcp/site` | For someone who owns one website: its pages and design tools only |

### Sign in with OAuth (Claude, ChatGPT and other connectors)

Add the address as a custom connector. There is no client id or secret to copy: the client registers itself, finds the sign-in on its own and opens the API's approve page.

- At `/mcp` (and `/mcp/read-only`) the page has one way in, **Sign in** (sign-in must be on, see [docs/accounts.md](../docs/accounts.md)): the dashboard opens, you sign in as yourself, pick your storefront, tick what the app may see and change, and approve. The app then acts as you, with your role: someone who may only look can only allow looking. A platform admin can pick any storefront.
- At `/mcp/site` it has only **Sign in with your website**, for someone who owns one website and has no dashboard account: type its address, approve in that website's WordPress dashboard, and the app gets the site tools for that website only ([docs/site-editing.md](../docs/site-editing.md)). This address takes no API key.

Either way the client only gets a token. Website connections made at `/mcp` before `/mcp/site` existed keep working.

#### Scopes

Each area has a scope to see and a scope to change. The approve page has a box for each; the read boxes start ticked, and the write boxes of the areas the app asked to change. Ticking a write box includes that area's read scope. Most tools take an `action`, and each action needs its area's read or write scope: a tool offers only the actions its connection may use (the others are left out of its `action` list and refused if called), and a tool none of whose actions are allowed isn't offered.

| Area | `:read` | `:write` |
|---|---|---|
| `stores` | `show_stores`, `show_store`, `get_stores` (list, get, wait) | `create_store`, `import_site` (start, new_code), `update_store` (options, move), `store_status` (suspend, resume, go_live, delete) |
| `backups` | `show_store_backups`, `manage_backups` (list) | `manage_backups` (create, restore) |
| `domains` | `show_store_domains`, `manage_domain` (list, check, connect_link) | `manage_domain` (add, set_main, remove) |
| `email` | `mail_domain` (get) | `mail_domain` (set, remove) |
| `versions` | `manage_versions` (list, snapshots, templates) | `manage_versions` (create, set_production, delete) |
| `webhooks` | `manage_webhooks` (list, get, deliveries) | `manage_webhooks` (create, update, test, retry, rotate_secret, delete) |
| `site` (pages and design) | `get_site`, `site_pages` (list, read, revisions), `site_patterns` (find, get), `site_styles` (get), `header_footer` (get), `site_menus` (list) | `site_pages` (create, update, restore_revision), `page_section` (add, replace, remove), `site_styles` (update), `header_footer` (update), `site_menus` (update), `add_image` |

So the scopes are `stores:read stores:write backups:read backups:write domains:read domains:write email:read email:write versions:read versions:write site:read site:write`. `/mcp/read-only` offers only the `:read` ones, and `/mcp/site` only `site:read site:write`. Connections made before scopes were per area keep what they had: their `stores:read` still sees everything and their `stores:write` still changes everything, through refreshes too.

What the API implements, per the MCP authorization spec:

- Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp` (and `/mcp/read-only`, `/mcp/site`), pointed to by the `WWW-Authenticate` header of a 401
- Authorization Server Metadata (RFC 8414) at `/.well-known/oauth-authorization-server`
- Client ID Metadata Documents, and dynamic client registration (RFC 7591) at `/oauth/register`
- Authorization code with PKCE (S256 only) at `/oauth/authorize` and `/oauth/token`, refresh tokens that rotate, and revocation (RFC 7009) at `/oauth/revoke`
- Tokens bound to their endpoint (RFC 8707 `resource`), with the scopes above, listed in both metadata documents and the `WWW-Authenticate` header

Access tokens last an hour and refresh tokens 30 days. Both are stored hashed and belong to the person who signed in and their storefront (leaving its team cuts the client off, and becoming a member who only looks takes away the write actions), or to one store. Tokens approved with an API key and secret, before that option was removed, keep working until the key is revoked. Set `PUBLIC_URL` to the API's public address in production; it is the issuer and the resource clients see.

### Sign in with the API key (Basic auth)

Clients that let you set a request header can skip OAuth and send Basic auth, your product API key as the username and the secret as the password, the same as the `/v1` API. Claude Code:

```sh
claude mcp add --transport http waas https://api.example.com/mcp \
  --header "Authorization: Basic $(printf '%s:%s' "$WAAS_API_KEY" "$WAAS_API_SECRET" | base64 -w0)"
```

Either way, every tool call goes through the `/v1` routes as that API key, so it shows up in the request log.

## Run it locally over stdio

| Variable | |
|---|---|
| `WAAS_API_URL` | The API's base URL, e.g. `https://api.example.com` |
| `WAAS_API_KEY` | Your product API key |
| `WAAS_API_SECRET` | Your product API secret |
| `WAAS_MCP_READ_ONLY` | `1` to offer only the tools and actions that read |

Claude Code, from a checkout of this repository (after `npm ci`):

```sh
claude mcp add waas \
  --env WAAS_API_URL=https://api.example.com \
  --env WAAS_API_KEY=... --env WAAS_API_SECRET=... \
  -- npm --prefix /path/to/waas-provisioning-api run -s mcp
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "waas": {
      "command": "npm",
      "args": ["--prefix", "/path/to/waas-provisioning-api", "run", "-s", "mcp"],
      "env": {
        "WAAS_API_URL": "https://api.example.com",
        "WAAS_API_KEY": "...",
        "WAAS_API_SECRET": "..."
      }
    }
  }
}
```

Once the package is on npm, `npx -y waas-provisioning-mcp` replaces the `npm --prefix … run -s mcp` command.

## Install the skill

- Claude Code: copy `skills/anypress-stores` into `~/.claude/skills/` (or a project's `.claude/skills/`).
- Claude apps: zip the `anypress-stores` folder and upload it under Settings, Capabilities, Skills.
- Other agents that support [Agent Skills](https://agentskills.io) load the same folder.

The server also serves it over MCP, per the [Skills extension](https://modelcontextprotocol.io/seps/2640-skills-extension) (`io.modelcontextprotocol/skills`): it declares the extension in its capabilities, the skill's file is the resource `skill://anypress-stores/SKILL.md`, and `skills/list` and `skills/get` return its frontmatter with the file's SHA-256 digest and size. The server's instructions point at the same URI, so a client without the extension can still read it with `resources/read`. Every folder under `skills/` with a `SKILL.md` is served this way.

## Tools

Twenty-one tools, grouped by area. Store tools take `externalId` (your own id) or `tenantId`; most take an `action`. Store writes return as soon as the work is scheduled; `get_stores` with action `wait` waits until the store is Done. Destructive actions are marked; a tool is flagged destructive when any action it offers is.

| Area | Tool | Actions |
|---|---|---|
| Stores | `show_stores` | Panel of every store |
| | `show_store` | Panel of one store: status, size, version, domains, versions |
| | `get_stores` | `list`, `get`, `wait` |
| | `create_store` | Creates a store |
| | `import_site` | `start` (a store that waits for a site moved in from another host), `new_code` |
| | `update_store` | `options` (WordPress options, PHP constants, size), `move` (to another version) |
| | `store_status` | `suspend` (destructive), `resume`, `go_live` (a moved-in site starts sending email and running its scheduled tasks), `delete` (destructive) |
| Backups | `show_store_backups` | Panel of a store's backups |
| | `manage_backups` | `list`, `create`, `restore` (destructive) |
| Domains | `show_store_domains` | Panel of a store's domains |
| | `manage_domain` | `list`, `check`, `connect_link` (Domain Connect), `add`, `set_main`, `remove` (destructive) |
| Email | `mail_domain` | `get`, `set`, `remove` (destructive) |
| Versions | `manage_versions` | `list`, `snapshots`, `templates`, `create`, `set_production`, `delete` (destructive) |
| Webhooks | `manage_webhooks` | `list`, `get`, `deliveries`, `create`, `update`, `test`, `retry`, `rotate_secret` (destructive), `delete` (destructive) |
| Site editing | `get_site` | The site's name, address, theme and home page |
| | `site_pages` | `list`, `read`, `revisions`, `create`, `update`, `restore_revision` |
| | `page_section` | `add`, `replace`, `remove` (destructive) |
| | `site_patterns` | `find`, `get` |
| | `site_styles` | `get`, `update` |
| | `header_footer` | `get`, `update` |
| | `site_menus` | `list`, `update` |
| | `add_image` | Copies an image from a link into the media library |

The site-editing tools change a store's pages and design through its WaaS Client (2.3.0 or newer) and take effect at once; WordPress keeps a revision of every change. How they reach the store: [docs/site-editing.md](../docs/site-editing.md).

Uploading custom snapshots and templates and downloading snapshot zips are left to the SDK, since they move files rather than JSON.

`createWaasMcpServer(client, options)` is exported too, to serve the tools from your own process (pass it to `serveStdio` or `createMcpHandler` from `@modelcontextprotocol/server`).

## Develop

- `npm run mcp` at the repository root starts the stdio server from source; `src/mcp.ts` mounts the HTTP endpoints on the API.
- `test/mcp.test.ts` drives `/mcp` with a 2026-07-28 client and a 2025-era one against the API itself, including the screens and the skill; `test/oauth.test.ts` runs the OAuth sign-in the way a connector does and checks which tools and actions each scope offers.
- The screens are `src/view/*.html`, sharing `src/view/base.css` and `src/view/common.js`. `src/view.ts` inlines those and the MCP Apps client bundle into each one, since hosts render them in a sandbox that can't load scripts from elsewhere.
- `src/skills.ts` serves `skills/` (Skills extension).
- In this repository `waas-provisioning-sdk` resolves to `../sdk/typescript` (see `tsconfig.json` paths). `npm run build` in this folder needs the published SDK installed.

## License

GPL-3.0-or-later

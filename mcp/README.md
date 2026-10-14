# waas-provisioning-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent create and manage stores through the WaaS provisioning API: stores and their lifecycle, backups, domains, sending domains, Domain Connect links, versions, snapshots and templates. It is built on the [TypeScript SDK](../sdk/typescript), so its tools follow the API's OpenAPI contract, and on the v2 MCP TypeScript SDK: it speaks MCP 2026-07-28 and still serves 2025-era clients.

It comes with:

- a **store panel** ([MCP App](https://modelcontextprotocol.io/extensions/apps)): `show_stores` renders your stores inline in clients that support MCP Apps (Claude, ChatGPT, VS Code and others), with back up, suspend and resume buttons. Other clients get the same list as text.
- an **Agent Skill**, [`skills/anypress-stores`](skills/anypress-stores/SKILL.md), that teaches an agent the common jobs: launching a store, putting it on a custom domain, setting up its sending domain, backups and restores.

> The API secret has full control of your stores. Every tool says whether it only reads or can destroy something, so clients like Claude ask before deleting or restoring a store. The read-only endpoint (or `WAAS_MCP_READ_ONLY=1`) offers only the tools that read.

## Connect over HTTP

The API serves the MCP server itself, so there is nothing to run:

| Endpoint | |
|---|---|
| `https://<your API>/mcp` | All tools |
| `https://<your API>/mcp/read-only` | Only the tools that read |

Sign in with Basic auth, your product API key as the username and the secret as the password, the same as the `/v1` API. Every tool call goes through the `/v1` routes, so it shows up in the request log.

Claude Code:

```sh
claude mcp add --transport http waas https://api.example.com/mcp \
  --header "Authorization: Basic $(printf '%s:%s' "$WAAS_API_KEY" "$WAAS_API_SECRET" | base64 -w0)"
```

Any client that lets you set a request header works the same way.

## Run it locally over stdio

| Variable | |
|---|---|
| `WAAS_API_URL` | The API's base URL, e.g. `https://api.example.com` |
| `WAAS_API_KEY` | Your product API key |
| `WAAS_API_SECRET` | Your product API secret |
| `WAAS_MCP_READ_ONLY` | `1` to offer only the tools that read |

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

## Tools

Store tools take `externalId` (your own id) or `tenantId`. Writes return as soon as the work is scheduled; `wait_for_store` waits until the store is Done.

| Area | Read | Write | Destructive |
|---|---|---|---|
| Stores | `show_stores` (panel), `list_stores`, `get_store`, `wait_for_store` | `create_store`, `update_store_options`, `resume_store`, `move_store_to_version` | `suspend_store`, `delete_store`, `restore_store` |
| Backups | `list_store_backups` | `create_store_backup` | |
| Domains | `list_store_domains`, `check_domain_availability`, `get_domain_connect_link` | `add_store_domain`, `set_store_main_domain` | `remove_store_domain` |
| Sending domain | `get_store_mail_domain` | `set_store_mail_domain` | `remove_store_mail_domain` |
| Versions | `list_versions`, `list_snapshots`, `list_templates` | `create_version`, `set_production_version` | `delete_version` |

Uploading custom snapshots and templates and downloading snapshot zips are left to the SDK, since they move files rather than JSON.

`createWaasMcpServer(client, options)` is exported too, to serve the tools from your own process (pass it to `serveStdio` or `createMcpHandler` from `@modelcontextprotocol/server`).

## Develop

- `npm run mcp` at the repository root starts the stdio server from source; `src/mcp.ts` mounts the HTTP endpoints on the API.
- `test/mcp.test.ts` drives `/mcp` with a 2026-07-28 client and a 2025-era one against the API itself, including the panel resource.
- The panel is `src/view/stores.html`. `src/view.ts` inlines the MCP Apps client bundle into it, since hosts render it in a sandbox that can't load scripts from elsewhere.
- In this repository `waas-provisioning-sdk` resolves to `../sdk/typescript` (see `tsconfig.json` paths). `npm run build` in this folder needs the published SDK installed.

## License

GPL-3.0-or-later

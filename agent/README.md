# Website assistant

A [Mastra](https://mastra.ai) agent that helps a website owner change their own site's pages and design in plain words: "add an FAQ page", "make the buttons green", "put the old heading back".

It has no tools of its own. Every request carries the owner's token from **Sign in with your website** (the API's `/mcp/site` login), and the assistant borrows that site's tools from the API with it. The API decides what the token reaches: one website, and only its pages, sections, patterns, styles, header, footer, menus and images. The assistant can't install plugins, change settings, see orders or reach another site, even if it is told to.

## What waits for the owner

Reading never waits. Adding a draft page or an image to the media library happens straight away, because visitors can't see either. Every other change waits for the owner's yes: publishing, editing a page or section, removing a section, changing styles, the header, the footer or a menu, and restoring a revision. If the owner says no, nothing changes. Every change WordPress makes keeps a revision, so the owner can ask for it back later.

The site tools come in two kinds ([`src/site-tools.ts`](src/site-tools.ts)). `site_pages`, `site_styles`, `header_footer` and `site_menus` only look, and add drafts: a page they create is always a draft, whatever the model asks. Their `_change` twins, and `page_section`, make the changes, and each call waits for the owner. "Always allow" can't switch that off: the change tools are set to ask on every call, and an explicit "ask" outranks any grant.

## Beside the page editor

WaaS Client's **Assistant** panel in the block editor and the Site Editor frames the chat's [`/editor`](panel/src/app/editor/) page. With each message the editor sends what it has open (the page, its top-level blocks and the selected block), and the assistant changes that open page with `editor_change` ([`src/editor.ts`](src/editor.ts)): replace or remove a block, insert blocks before or after one, or replace the whole page. The change comes back to the editor, shows there at once and can be undone, and it is kept only when the owner presses Save, so it doesn't wait for an approval card. It never reaches the website by itself.

The page and the editor talk with `postMessage`, and the page only listens to and writes to the address the API answers for the signed-in website (`GET /agent-controller/site`). Signed out, it asks the editor to sign it in: WaaS Client asks the API for a handoff signed with the store's own site key (`POST /oauth/site/store-handoff`, [docs/site-editing.md](../docs/site-editing.md)), so the owner never sees a sign-in.

## HTTP

The assistant speaks [Mastra Chat Kit](https://github.com/hamchowderr/mastra-chat-kit)'s chat routes (Mastra's Agent Controller), streamed as server-sent events. Every route takes `Authorization: Bearer <website sign-in token>`.

| Route | |
|---|---|
| `POST /agent-controller/stream` | `{ text, threadId?, editor? }`. Streams the reply: text, tool steps, and `tool_approval_required` for each change that waits, with a plain `preview.summary` such as "Publish page 14" |
| `POST /agent-controller/approve` | `{ decision: "approve" \| "decline", toolCallId }` |
| `POST /agent-controller/answer` | The owner's answer to a question the assistant asked |
| `POST /agent-controller/abort` | Stops the current reply |
| `GET /agent-controller/threads` | The website's conversations, and `/threads/<id>/messages` for one |
| `GET /agent-controller/site` | The signed-in website's address |

Conversations and waiting changes are kept per website, under the address the API answers for the token. Another website's conversation or waiting change can't be opened, answered or written to.

The chat the owner sees is [`panel/`](panel/), a Next.js app with **Sign in with your website**.

## Running it

```bash
npm ci
ASSISTANT_MODEL=<Anthropic model id> ANTHROPIC_API_KEY=... DATABASE_URL=postgres://... ANYPRESS_API_URL=https://api.anypress.io npm start
```

| Variable | |
|---|---|
| `ASSISTANT_MODEL` | The Anthropic model to use |
| `ANTHROPIC_API_KEY` | Its API key |
| `DATABASE_URL` | Postgres for conversations (schema `assistant`) |
| `ANYPRESS_API_URL` | The AnyPress API |
| `ALLOWED_ORIGINS` | Optional: comma-separated addresses whose pages may call the assistant from the browser |
| `PORT` | Default 3100 |

In a container: `docker build -f agent/Dockerfile .` from the repository root (it reads the root `tsconfig.json` and the AnyPress stores skill).

## Tests

The tests run the API itself in-process, on the API's test database (`TEST_DATABASE_URL`), with [AIMock](https://aimock.copilotkit.dev) playing the model, so every test decides exactly which tool the model calls and then checks what reached which website.

- `npm test`: stores that answer like WaaS Client. Checks the sign-in, drafts, approve and decline, that one website's owner can't see or answer another's waiting change, and that a model told to use another website still only reaches its own.
- `npm run test:playground`: a real WordPress on [WordPress Playground](https://wordpress.github.io/wordpress-playground/) with WaaS Client from [waas-plugins](https://github.com/hamchowderr/waas-plugins). Checks a draft page, publishing only after the owner's yes, a section change and its undo, and a decline, on actual pages. Needs Node 24.18+ and `WAAS_CLIENT_DIR` pointing at `waas-plugins/packages/waas-client` with its `vendor` folder (`composer install --no-dev`).
- `npm run test:browser`: the chat panel in Chromium at desktop and phone width (Playwright). Types a request, checks the change waits on an Approve / Reject card, and that only Approve makes it. Run `npm ci && npm run build` in `panel/` first.

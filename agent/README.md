# Website assistant

A [Mastra](https://mastra.ai) agent that helps a website owner change their own site's pages and design in plain words: "add an FAQ page", "make the buttons green", "put the old heading back".

It has no tools of its own. Every request carries the owner's token from **Sign in with your website** (the API's `/mcp/site` login), and the assistant borrows that site's tools from the API with it. The API decides what the token reaches: one website, and only its pages, sections, patterns, styles, header, footer, menus and images. The assistant can't install plugins, change settings, see orders or reach another site, even if it is told to.

## What waits for the owner

Reading never waits. Adding a draft page or an image to the media library happens straight away, because visitors can't see either. Every other change waits for the owner's yes: publishing, editing a page or section, removing a section, changing styles, the header, the footer or a menu, and restoring a revision. If the owner says no, nothing changes. Every change WordPress makes keeps a revision, so the owner can ask for it back later.

Which calls wait is decided in [`src/approval.ts`](src/approval.ts). A tool or action it doesn't know always waits.

## HTTP

Both routes take `Authorization: Bearer <website sign-in token>` and answer `{ conversation, text, pending }`, where `pending` lists the changes waiting for the owner (`toolCallId`, `tool`, `args`, and a plain `summary` such as "Publish page 14").

| Route | Body |
|---|---|
| `POST /chat` | `{ message, conversation? }`. Leave `conversation` out to start a new one; send the returned id to carry on. |
| `POST /chat/approval` | `{ conversation, toolCallId, approve, reason? }`. `approve: false` declines; `reason` is passed to the assistant. |
| `GET /health` | `{ ok: true }` |

Conversations and waiting changes are kept per website, under the address the API answers for the token. A conversation id from another website opens nothing.

## Running it

```bash
npm ci
ASSISTANT_MODEL=<Anthropic model id> ANTHROPIC_API_KEY=... DATABASE_URL=postgres://... ANYPRESS_API_URL=https://api.anypress.io npm start
```

| Variable | |
|---|---|
| `ASSISTANT_MODEL` | The Anthropic model to use |
| `ANTHROPIC_API_KEY` | Its API key |
| `DATABASE_URL` | Postgres for conversations and waiting changes (schema `assistant`) |
| `ANYPRESS_API_URL` | The AnyPress API |
| `PORT` | Default 3100 |

## Tests

The tests run the API itself in-process, on the API's test database (`TEST_DATABASE_URL`), with [AIMock](https://aimock.copilotkit.dev) playing the model, so every test decides exactly which tool the model calls and then checks what reached which website.

- `npm test`: stores that answer like WaaS Client. Checks the sign-in, drafts, approve and decline, that one website's owner can't see or answer another's waiting change, and that a model told to use another website still only reaches its own.
- `npm run test:playground`: a real WordPress on [WordPress Playground](https://wordpress.github.io/wordpress-playground/) with WaaS Client from [waas-plugins](https://github.com/hamchowderr/waas-plugins). Checks a draft page, publishing only after the owner's yes, a section change and its undo, and a decline, on actual pages. Needs Node 24.18+ and `WAAS_CLIENT_DIR` pointing at `waas-plugins/packages/waas-client` with its `vendor` folder (`composer install --no-dev`).

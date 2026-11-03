# Website assistant chat panel

The chat the website owner sees: a [Next.js](https://nextjs.org) app built from [Mastra Chat Kit](https://github.com/hamchowderr/mastra-chat-kit)'s side panel. It is one page, shown wherever the owner opens the assistant (the shop's My website tab, wp-admin, the Site Editor), with `?site=<address>` filling in their website.

## On each website's own domain

The panel lives under `/.assistant` (`basePath`, `src/lib/base-path.ts`), and every store's domains send `https://<domain>/.assistant` to it: each store's compose file carries a Traefik router for its domains (`assistantLabels` in `src/provisioner/coolify/compose.ts`, store setup 12) pointing at the `website-assistant-panel` service. The panel declares that service itself, with a label in its `Dockerfile` (Docker gives a container its image's labels):

```
traefik.http.services.website-assistant-panel.loadbalancer.server.port=3200
```

So an owner opens the assistant at `https://mybakery.com/.assistant`, and nothing they see names the platform. The dot keeps it from hiding any page of the website: WordPress never gives a page, post or term an address starting with a dot. On a website's domain the panel signs in with a return address on that domain (`https://mybakery.com/.assistant/callback`, an OAuth client registered for it on first use), and its cookies are first-party (`SameSite=Lax`, path `/.assistant`, so the website's WordPress never gets them). The panel tells which website it was opened at from the Host header, which the proxy only sends here for the stores' domains.

The panel has no public address of its own: it is only reached through a website's `/.assistant` (AnyPress Client 2.12.0 and AnyPress Host 2.10.0 or later).

- **Sign in with your website.** The owner types their website's address and says yes in that website's wp-admin. The panel keeps the tokens in httpOnly cookies on the website's `/.assistant`; the browser never sees them (`src/lib/site-session.ts`).
- **From the shop.** A shop that has signed in the owner can skip that step: its "Ask the website assistant" button gets a one-time handoff for the owner's website from the API (`POST /v1/tenants/site/handoff`, with `assistantUrl` the website's own `https://<domain>/.assistant`) and opens `/.assistant/from-shop?handoff=…` there. The panel trades the handoff, with its own PKCE challenge, for a code (`POST /oauth/site/handoff`). Any storefront on the API works; there is no list of shops.
- **Chat.** The `/api/agent-controller/*` routes pass each message, approval and answer to the assistant (`MASTRA_SERVER_URL`) with the owner's token, refreshing it when it is about to run out.
- **Approval cards.** A change that visitors would see shows a card with a plain sentence ("Publish page 14?") and Approve / Reject. Nothing happens until the owner clicks.

## Running it

```bash
npm ci
npm run build
MASTRA_SERVER_URL=http://localhost:3100 ANYPRESS_API_URL=https://api.anypress.io PANEL_URL=https://<panel address> npm start
```

| Variable | |
|---|---|
| `MASTRA_SERVER_URL` | The assistant (`../`, default `http://localhost:4111`) |
| `ANYPRESS_API_URL` | The API, for the sign-in |
| `PANEL_URL` | The container's own address (without `/.assistant`), used only for a request that reaches it directly (tests) |

In a container: `docker build agent/panel` (listens on 3200).

The cookies are `Secure`, so the panel needs https outside `localhost`.

## Where the files come from

`src/components/` (the chat panel, transcript, composer, ai-elements and ui), `src/lib/agent-controller/` and `src/lib/mastra-proxy.ts` are copied from Mastra Chat Kit (commit `a446911`). The changes made here: `mastra-proxy.ts` takes a `getAuthorization` hook (the owner's token), and `ChatPanel` takes `toolTitles` so each step has a plain name.

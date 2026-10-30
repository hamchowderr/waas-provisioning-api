# Website assistant chat panel

The chat the website owner sees: a [Next.js](https://nextjs.org) app built from [Mastra Chat Kit](https://github.com/hamchowderr/mastra-chat-kit)'s side panel. It is one page, shown wherever the owner opens the assistant (the shop's My website tab, wp-admin, the Site Editor), with `?site=<address>` filling in their website.

- **Sign in with your website.** The owner types their website's address and says yes in that website's wp-admin. The panel keeps the tokens in httpOnly cookies on its own address; the browser never sees them (`src/lib/site-session.ts`).
- **From the shop.** A shop that has signed in the owner can skip that step: its "Ask the website assistant" button gets a one-time handoff for the owner's website from the API (`POST /v1/tenants/site/handoff`) and opens `/from-shop?handoff=…`. The panel trades the handoff, with its own PKCE challenge, for a code (`POST /oauth/site/handoff`). Any storefront on the API works; there is no list of shops.
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
| `ANYPRESS_API_URL` | The AnyPress API, for the sign-in |
| `PANEL_URL` | This panel's own address, where the sign-in comes back (`/callback`) |
| `PANEL_OAUTH_CLIENT_ID` | Optional: a fixed sign-in client. Without it the panel registers itself with the API on first use |

In a container: `docker build agent/panel` (listens on 3200).

The cookies are `Secure` and `SameSite=None; Partitioned`, so the panel needs https outside `localhost`.

## Where the files come from

`src/components/` (the chat panel, transcript, composer, ai-elements and ui), `src/lib/agent-controller/` and `src/lib/mastra-proxy.ts` are copied from Mastra Chat Kit (commit `a446911`). The changes made here: `mastra-proxy.ts` takes a `getAuthorization` hook (the owner's token), and `ChatPanel` takes `toolTitles` so each step has a plain name.

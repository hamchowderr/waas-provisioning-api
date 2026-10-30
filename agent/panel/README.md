# Website assistant chat panel

The chat the website owner sees: a [Next.js](https://nextjs.org) app built from [Mastra Chat Kit](https://github.com/hamchowderr/mastra-chat-kit)'s side panel. It is one page, shown wherever the owner opens the assistant (the shop's My website tab, wp-admin, the Site Editor), with `?site=<address>` filling in their website.

- **Sign in with your website.** The owner types their website's address and says yes in that website's wp-admin. The panel keeps the tokens in httpOnly cookies on its own address; the browser never sees them (`src/lib/site-session.ts`).
- **From the shop.** A shop that has signed in the owner can skip that step: its "Ask the website assistant" button opens `/from-shop?shop=<the shop's sign-in address>`, the panel starts its sign-in, and the shop asks the API (`POST /v1/tenants/site/sign-in`) for a code for that owner's website. The shop has to be listed in `PANEL_SHOPS`.
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
| `PANEL_SHOPS` | Comma-separated shop addresses (e.g. `https://shop.anypress.io`) that may sign their owners in |
| `PANEL_OAUTH_CLIENT_ID` | Optional: a fixed sign-in client. Without it the panel registers itself with the API on first use |

The cookies are `Secure` and `SameSite=None; Partitioned`, so the panel needs https outside `localhost`.

## Where the files come from

`src/components/` (the chat panel, transcript, composer, ai-elements and ui), `src/lib/agent-controller/` and `src/lib/mastra-proxy.ts` are copied from Mastra Chat Kit (commit `a446911`). The changes made here: `mastra-proxy.ts` takes a `getAuthorization` hook (the owner's token), and `ChatPanel` takes `toolTitles` so each step has a plain name.

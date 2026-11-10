# Support tickets

People ask for help where they already are: in an AI app connected to AnyPress, in their website's assistant, or through the API. A ticket always belongs to the person signed in, and goes to whoever helps them.

| Who asks | Where the ticket goes |
|---|---|
| A website owner whose store a reseller sells | The reseller's support address (their dashboard branding), by email under the reseller's name. Replies go straight back to the owner. Without a support address, the support desk. |
| Everyone else: website owners of your own stores, sellers, resellers | The support desk: Fluent Support on the storefront named by `SUPPORT_DESK_URL`. |

When no desk is set up, or it doesn't answer, the ticket is emailed to the platform's support address (`AUTH_SUPPORT_EMAIL`, by default `support@<BRAND_DOMAIN>`) with the person as the reply-to address, so nothing is lost.

Each ticket carries what whoever answers needs, so nobody has to ask: who sent it, the storefront, and when it is about a store, its name, address, id, version and state.

## Asking from an AI app

The AnyPress connector has a `support` tool with these actions:

- `open`: files a ticket from a title and message. The AI writes it in the person's words and shows it before sending.
- `list` and `show`: their tickets at the desk and the replies.
- `reply` and `close`: answer a ticket, or close it once it's solved. A reply opens a closed ticket again.

It needs the Stores area for a person signed in to the dashboard (read to look, write to open, reply and close), and the website area on a website owner's own connection ("Sign in with your website"), where it acts for that website's owner. The website assistant offers the same; opening, replying and closing wait for the owner's yes.

## The API

`/v1/support/tickets` (list and open), `/v1/support/tickets/{ticketId}` (read), `.../replies` and `.../close`. See the Support section of the [API reference](../openapi/waas-provisioning-api.yaml). The SDK has them as `client.support.list()`, `open()`, `get()`, `reply()` and `close()`.

These calls need a person: a website owner's connection, or a dashboard user's. An API key on its own says nothing about who is asking, so it gets 400.

## Setting up the desk

1. Install and activate [Fluent Support](https://wordpress.org/plugins/fluent-support/) on the storefront that should answer tickets. It needs AnyPress Host 2.13.0 or newer, connected to this API (so it has its webhook endpoint).
2. Set `SUPPORT_DESK_URL` on the API to that storefront's address, e.g. `https://shop.example.com`, and restart it.

The API signs every call to the desk like a webhook, with the secret of that storefront's webhook endpoint, so no new secret is needed. AnyPress Host checks the signature, uses each signed request once, and lets a customer reach only their own tickets. It also adds a **Support** page with Fluent Support's customer portal, where people can read and answer the same tickets in the browser, and Fluent Support emails them each reply as usual.

# Demos people build themselves

For whoever runs the API or builds a demo page. Anyone can build their own demo site in their browser on WordPress Playground, with no hosting and no account, and keep it when they buy: the store made after checkout starts with the demo's pages, styles and photos.

## How it goes

1. **The demo is built in the visitor's browser.** A demo page opens Playground with the site type's blueprint (AnyPress Client on, `ANYPRESS_TENANT_ROLES` set to the site type, the AnyPress theme and the chosen kit). The visitor edits it in WordPress. Nothing is made on the server.
2. **"Make this my site" saves a draft.** The demo page reads the demo back out of Playground through AnyPress Client's site routes (the same ones the site tools use) and sends it to `POST /demos/drafts`, with no API key:
   - `siteType`: the site type it was built as; `kit`: the kit it started from; `productId`: the storefront whose demo page made it, when it isn't AnyPress's own.
   - `content`: `pages` (title, slug, blocks, `publish` or `draft`), `styles` (`settings` and `styles`, as `PATCH /styles` takes them), `header` and `footer` (blocks), `menus` (title and navigation blocks) and `business` (the business details). Nothing else: no plugins, code, users or settings.
   - `images`: the file names of photos the visitor added. The answer has an upload link for each (one `PUT`, for an hour, at most `maxImageBytes`). In the content, a photo is written as `anypress-demo-image:<name>`.

   The answer's `id` (`demo_…`) is the draft. A draft is kept for 14 days. Up to 300 drafts are saved an hour, from everyone together; past that the route answers 429.
3. **Checkout carries the draft.** The visitor goes to the storefront's checkout with the draft's id. `GET /demos/drafts/{id}` shows what it is (site type, kit, page titles) and whether it was used already.
4. **The store is made after payment.** The storefront creates the store as usual, with `demoDraftId` added to `POST /v1/tenants`. The draft must still be saved and unused, for the store's site type (`ANYPRESS_TENANT_ROLES`), and made on this storefront's demo page or AnyPress's own. It is used once.
5. **The store gets the demo.** The store is built from its template exactly as without a demo. Then, through its site routes: each photo is copied into its media library and the placeholders become the store's own links; the styles, header and footer are saved; each page replaces the store's page with the same slug, or is added as a new page; each menu replaces the store's menu with the same title; and the business details are saved. Pages keep their status from the demo. If a step fails, the steps after it are skipped (the store keeps its template's content there), and the reason is kept with the draft.

Drafts nobody used are removed after 14 days, with their photos.

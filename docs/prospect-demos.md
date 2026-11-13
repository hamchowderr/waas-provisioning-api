# Branded demos for prospects

For whoever runs the API. The platform admin can make a private demo for a business they plan to contact: the demo on anypress.io/try opens with the business's own name, colours, fonts, logo and photos, and shows what the AnyPress route they'd take looks like for them. Like every other /try demo it runs on WordPress Playground in the visitor's browser; nothing is built on the server.

## How it goes

1. **Add the businesses.** `POST /admin/prospect-demos` with up to 200 at a time, each with `company`, `website`, `route`, `siteType` and, if wanted, `kit`, `label` (the group on the board), `city`, `priority` and `notes`. A website already on the list is skipped, so importing a list twice is safe.
2. **Each website is read once, in the background.** One Firecrawl scrape (the official SDK, with the reference reader's `FIRECRAWL_API_KEY`) takes the brand (colours, fonts, logo) and what the business offers: its name, tagline, a short about, phone, city, address, hours, up to 8 things it sells or offers and up to 4 photos. A price is kept only when the website prints one, word for word. It costs about 5 Firecrawl credits a business; `creditsUsed` shows what each one spent.
3. **Images are copied.** The logo, photos and item pictures are copied into object storage under `prospects/<code>/` (images only, up to 5 MB each), because other sites' images often can't be loaded by a demo page and their links change.
4. **The demo link carries a private code.** Each business gets a `code` (`p_…`); its demo is `anypress.io/try?for=<code>`. The demo page reads `GET /demos/prospects/{code}` (no key, sent with `X-Robots-Tag: noindex`) and the images from `GET /demos/prospects/{code}/files/{name}`. Only the route, site type, kit and what was read from the website are public; label, priority and notes stay in the admin list.

`statusCode` is 0 while the website is being read, 1 when the demo is ready and 2 when the website couldn't be read (`error` says why). `POST /admin/prospect-demos/{id}/gather` reads it again; the demo keeps its old look until the new read is done. `PATCH /admin/prospect-demos/{id}` changes the route, site type, kit or notes. `DELETE /admin/prospect-demos/{id}` removes the business and its images, and its link stops working.

## Routes

| `route` | What the demo shows |
|---|---|
| `seller` | A shop made for one of their clients, with their name as the maker |
| `reseller` | One of their locations as its own site |
| `affiliate` | A site for the kind of business their customers run, "Recommended by" them |
| `chamber` | Their own member site, with events and member benefits |
| `owner` | Their own site or shop |

The routes are in `openapi/admin/admin-api.yaml`.

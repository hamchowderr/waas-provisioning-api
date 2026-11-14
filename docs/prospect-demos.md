# Prospects: website check and branded demos

For whoever runs the API. Every storefront's Sales Kit (a seller's, a reseller's, and AnyPress's own shop) keeps a list of businesses it may contact. Each business's website is read once, and that one read gives three things: the website check (a plain report on what their site does well and what it's missing), what kind of site it is, and a private demo that opens with the business's own name, colours, fonts, logo and photos. Like every other demo, it runs on WordPress Playground in the visitor's browser; nothing is built on the server.

## How it goes

1. **Add the businesses.** `POST /admin/products/{productId}/prospects/demos` with up to 200 at a time, each with `company` and `website`, and if wanted `placeId` and `details` (what the prospect finder found: phone, email, address, socials and so on), `route`, `siteType`, `kit`, `label`, `city`, `priority` and `notes`. A website already on the storefront's list is skipped, so importing a list twice is safe. Without `siteType`, the read picks the demo's site type from what their website has (a shop: online store; bookings: bookings; members: community; more than one of these: everything; otherwise website).
2. **Each website is read once, in the background.** One Firecrawl scrape (the official SDK, with the reference reader's `FIRECRAWL_API_KEY`) takes the page, the brand (colours, fonts, logo) and what the business offers: its name, tagline, a short about, phone, city, address, hours, up to 8 things it sells or offers and up to 4 photos. A price is kept only when the website prints one, word for word. It costs about 5 Firecrawl credits a business; `creditsUsed` shows what each one spent. The same read notes what their website is now (`brand.site`): the builder it runs on (WordPress, Wix, Squarespace, Shopify and so on) and what it has (a shop, bookings, events, members, a blog, donations). Four websites are read at once.
3. **The website check runs on the same page** (`report`): a secure connection, speed, phones, Google, a main heading, sharing, how recently it was updated, ways to get in touch and to act online, and picture descriptions, with a score out of 100. Speed comes from one request of our own for the page; a site that turns that request away isn't scored on speed.
4. **Images and fonts are copied.** The logo, photos and item pictures are copied into object storage under `prospects/<code>/` (images only, up to 5 MB each), because other sites' images often can't be loaded by a demo page and their links change. When the heading or body font is an open-licence font (looked up on fontsource.org), its regular and bold files are copied too (`brand.fontFaces`); other fonts can't be copied, and the demo keeps its kit's fonts.
5. **The demo link carries a private code.** Each business gets a `code` (`p_…`) and, once read, a `demoUrl`: `anypress.io/try?for=<code>` for AnyPress's own list, and the storefront's demo page (`/demo/<storefront>?for=<code>` on its own dashboard address, in its own look) for everyone else. The demo page reads `GET /demos/prospects/{code}` (no key, sent with `X-Robots-Tag: noindex`) and the files from `GET /demos/prospects/{code}/files/{name}`. Only the route, site type, kit, storefront and what was read from the website are public; the report, label, priority, notes and the finder's details stay in the storefront's list.
6. **Into the CRM.** When the storefront sends businesses to its FluentCRM or HighLevel (`POST /admin/products/{productId}/prospects/crm`), each one it has read goes with its demo link, website score and what its site runs on: in the FluentCRM contact's note, and as `demoLink`, `websiteScore` and `websitePlatform` in the HighLevel webhook.

`statusCode` is 0 while the website is being read, 1 when it's ready and 2 when it couldn't be read (`error` says why). `POST .../demos/{id}/read` reads it again; the demo keeps its old look until the new read is done. `PATCH .../demos/{id}` changes the route, site type, kit or notes; a site type picked there stays. `DELETE .../demos/{id}` removes the business and its files, and its link stops working.

## Reads each month

Reads are paid, so each storefront has `PROSPECT_READS_PER_MONTH` of them a calendar month (UTC, default 50), counted when a read starts. `GET /admin/products/{productId}/prospects/usage` answers them as `reads`, beside the finder's searches. When they're used, new businesses are still saved, with `statusCode` 2 and an error that says so, and `.../read` answers 429. AnyPress's own list (the `STORE_TEMPLATE_PRODUCT_ID` storefront) has no allowance; prospects added before lists belonged to a storefront become its own when the API starts.

## Routes

| `route` | What the demo shows |
|---|---|
| `seller` | A shop made for one of their clients, with their name as the maker |
| `reseller` | One of their locations as its own site |
| `affiliate` | A site for the kind of business their customers run, "Recommended by" them |
| `chamber` | Their own member site, with events and member benefits |
| `owner` | Their own site or shop (the default) |

For a business's own site (`owner`, `chamber`, `reseller`) the demo shows only what their website has: when it has no shop, the sample's shop, cart and product search are hidden, and the same goes for booking, the community and the blog. When it has a shop, the things their website prints a price for become the shop's products. Their own fonts are used when they were copied.

The routes are in `openapi/admin/admin-api.yaml`.

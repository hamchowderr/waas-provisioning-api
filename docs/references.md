# References: building a site from a link or a file

People describe the site they want by pointing at something: a site they like, their old shop, a Figma mockup, a brand book or a menu as a PDF. A reference read turns any of these into one **bundle** that a person or an AI agent builds the site from, with the AnyPress theme's own colours, fonts and sections.

It is one API call, so it works the same from the MCP connector (`read_reference`), the website assistant, the dashboard, the SDKs (`client.references`) and automation apps such as n8n, Zapier and Make.

## What can be read

| Reference | Send | What the bundle holds |
|---|---|---|
| A website | `{"url": "https://example.com"}` | Every page (up to `maxPages`, the server's limit of 500 by default): each page's text as Markdown, a full-page screenshot and its images; the home page at phone width and its links (the menus); the site's colours, fonts, font sizes, corner radius, colour scheme and logo; products found on its pages; and a coverage list of every address found |
| A WordPress site | Its address, like any website | Everything a website gives, plus every post and other public entry (title, text, date, images) and every WooCommerce product, read from the site's REST API, and every page the site lists, even ones no link points to |
| A Shopify shop | Its address, like any website | Everything a website gives, plus every product (title, description, vendor, type, tags, price, compare-at price, images, and each variant's SKU, price and stock) and collection, read from the shop's public product list. Up to 5,000 products |
| A Squarespace site | Its address, like any website | Everything a website gives, plus each collection's items (blog posts, events, portfolio entries) and shop products, read from the site's own `?format=json` data |
| A Figma file | A Figma link (`figma.com/design/...`), with or without `node-id` | Each frame of the linked page (or the linked frame): its top-level layers in order with their text, a picture of it, the colours and fonts it uses, its corner radius and its image fills |
| A document | A link to a PDF, Word, Excel or OpenDocument file, or an upload: `{"file": {"name": "brief.pdf", "data": "<base64>"}}`, up to 10 MB | The document's text as Markdown |

Figma files must be shared (can view) with the Figma account the server reads with. A password-protected Shopify shop is read as a website without its products.

## How a website is read

The platform's own data comes first, because it is complete, exact and costs nothing; Firecrawl reads what that data can't give.

1. **The home page**, whole (header, menus, footer), with the brand (colours, fonts, sizes, logo), a full-page screenshot, a phone-width screenshot and any product on it. Its address and HTML also tell the platform: WordPress, Shopify, Squarespace, Wix, Webflow or other.
2. **Every address the site has**, from its sitemap and links (Firecrawl's map), plus the pages the platform itself lists (WordPress's REST API lists pages no link points to).
3. **The platform's data**: WordPress posts, other public entries and WooCommerce products from its REST API; a Shopify shop's products and collections; Squarespace collections. These are counted as read. One of each kind (one post, one product) is still read as a page, for its layout.
4. **A crawl of the site** from the home page: the sitemap and every link, parent and sibling paths included, query strings and duplicate addresses folded together, carts, accounts, feeds, tag pages and files left out, and the platform's items left out. Each page gives its main text, images, a full-page screenshot and any product on it (from the page's structured data). Pages that block ordinary readers are retried through a stronger proxy at no extra cost.
5. **A batch read** of every address step 2 found that the crawl didn't reach.
6. **The coverage list**: every address found, with `read` (and whether from Firecrawl or the platform's data), `failed` (and why: a timeout, a 404) or `skipped` (and why: a cart page, a file, blocked by the site's robots.txt, or not read because `maxPages` or the month's credits ran out).

Wix and Webflow sites have no public data to read, so their pages are all read with Firecrawl.

### Credits

Firecrawl charges a credit a page. A website read spends 3 credits before its pages (the home page, its phone picture and the map), then about one a page, whatever the page holds; the platform's own data costs nothing. Firecrawl's cache is used for pages read in the last two days, which is faster and costs the same. A read stops at `maxPages` or when the month's credits run out, and the coverage list says which pages were left.

## Calls

```bash
# Start a read. It answers at once with an id and statusCode 0 (Pending).
curl -u "$KEY:$SECRET" -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "maxPages": 5}' \
  https://api.anypress.io/v1/references

# Poll until statusCode is 1 (Done, with the bundle) or 2 (Failed, with error). A small site takes a minute or two,
# a site of hundreds of pages up to half an hour.
curl -u "$KEY:$SECRET" "https://api.anypress.io/v1/references?id=<id>"

# A big bundle a part at a time: 20 of each list (pages, items, products, coverage addresses) from the 40th.
# totals gives each list's full length.
curl -u "$KEY:$SECRET" "https://api.anypress.io/v1/references?id=<id>&offset=40&limit=20"

# This month's reads and credits, the allowances and the page limit.
curl -u "$KEY:$SECRET" https://api.anypress.io/v1/references/usage
```

With the TypeScript SDK:

```ts
const started = await client.references.start({ url: 'https://example.com' });
let reference = await client.references.get(started.id);
while (reference.statusCode === 0) {
  await new Promise((r) => setTimeout(r, 5000));
  reference = await client.references.get(started.id);
}
```

## The bundle

```json
{
  "kind": "website",
  "source": "https://example.com/",
  "title": "Example",
  "platform": "wordpress",
  "design": {
    "colors": { "primary": "#1d4ed8", "background": "#ffffff", "textPrimary": "#111827" },
    "fonts": { "heading": "Fraunces", "body": "Inter", "all": ["Fraunces", "Inter"] },
    "fontSizes": { "h1": "56px", "body": "16px" },
    "radius": "8px",
    "colorScheme": "light",
    "logo": "https://example.com/logo.svg"
  },
  "pages": [{ "url": "https://example.com/", "title": "Home", "text": "# ...", "sections": [], "screenshot": "https://...", "mobileScreenshot": "https://...", "images": ["https://..."], "links": ["https://example.com/about"] }],
  "items": [{ "kind": "post", "url": "https://example.com/2026/01/hello/", "title": "Hello", "text": "...", "date": "2026-01-01T09:00:00", "images": [] }],
  "products": [],
  "collections": [],
  "coverage": {
    "found": 42, "read": 39, "failed": 1, "skipped": 2, "creditsUsed": 31,
    "urls": [
      { "url": "https://example.com/about", "kind": "page", "status": "read", "via": "firecrawl", "reason": null },
      { "url": "https://example.com/cart", "kind": "listing", "status": "skipped", "via": null, "reason": "a cart, account or sign-in page the store makes itself" }
    ]
  },
  "notes": ["..."]
}
```

Before building, check `coverage`: every page should be read, and each failed one retried or reported. To build from it, map `design.colors` onto the theme's palette slugs and pick the nearest theme fonts and sizes (the `anypress-design-md` skill has the table), then lay out each page from the theme's sections. Screenshot and image links expire (a day for websites, 14 to 30 days for Figma): copy anything the site keeps into its media library.

With someone else's site or file, take its layout and style, never its text, photos or logo.

## Allowance

Each storefront can read `REFERENCE_READS_PER_MONTH` references a calendar month (UTC), 50 by default, and spend `REFERENCE_CREDITS_PER_MONTH` Firecrawl credits, 5,000 by default. A read that fails isn't counted as a read, but the credits it spent are. One read takes at most `REFERENCE_MAX_PAGES` pages, 500 by default. A self-hosted server reads websites and documents once `FIRECRAWL_API_KEY` is set and Figma links once `FIGMA_TOKEN` is set ([self-hosting.md](self-hosting.md)). Until then those reads answer 503.

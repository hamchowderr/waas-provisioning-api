# References: building a site from a link or a file

People describe the site they want by pointing at something: a site they like, their old shop, a Figma mockup, a brand book or a menu as a PDF. A reference read turns any of these into one **bundle** that a person or an AI agent builds the site from, with the AnyPress theme's own colours, fonts and sections.

It is one API call, so it works the same from the MCP connector (`read_reference`), the website assistant, the dashboard, the SDKs (`client.references`) and automation apps such as n8n, Zapier and Make.

## What can be read

| Reference | Send | What the bundle holds |
|---|---|---|
| A website | `{"url": "https://example.com"}` | Up to `maxPages` pages (5 by default, at most 10): each page's text as Markdown, a full-page screenshot and its images, plus the site's colours, fonts, font sizes, corner radius, colour scheme and logo |
| A Shopify shop | Its address, like any website | Everything a website gives, plus every product (title, description, vendor, type, tags, price, compare-at price, images, and each variant's SKU, price and stock) and collection, read from the shop's public product list. Up to 1,000 products |
| A Figma file | A Figma link (`figma.com/design/...`), with or without `node-id` | Each frame of the linked page (or the linked frame): its top-level layers in order with their text, a picture of it, the colours and fonts it uses, its corner radius and its image fills |
| A document | A link to a PDF, Word, Excel or OpenDocument file, or an upload: `{"file": {"name": "brief.pdf", "data": "<base64>"}}`, up to 10 MB | The document's text as Markdown |

Figma files must be shared (can view) with the Figma account the server reads with. A password-protected Shopify shop is read as a website without its products.

## Calls

```bash
# Start a read. It answers at once with an id and statusCode 0 (Pending).
curl -u "$KEY:$SECRET" -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "maxPages": 5}' \
  https://api.anypress.io/v1/references

# Poll until statusCode is 1 (Done, with the bundle) or 2 (Failed, with error). Reading takes up to a few minutes.
curl -u "$KEY:$SECRET" "https://api.anypress.io/v1/references?id=<id>"

# This month's reads and the allowance.
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
  "design": {
    "colors": { "primary": "#1d4ed8", "background": "#ffffff", "textPrimary": "#111827" },
    "fonts": { "heading": "Fraunces", "body": "Inter", "all": ["Fraunces", "Inter"] },
    "fontSizes": { "h1": "56px", "body": "16px" },
    "radius": "8px",
    "colorScheme": "light",
    "logo": "https://example.com/logo.svg"
  },
  "pages": [{ "url": "https://example.com/", "title": "Home", "text": "# ...", "sections": [], "screenshot": "https://...", "images": ["https://..."] }],
  "products": [],
  "collections": [],
  "notes": ["..."]
}
```

To build from it, map `design.colors` onto the theme's palette slugs and pick the nearest theme fonts and sizes (the `anypress-design-md` skill has the table), then lay out each page from the theme's sections. Screenshot and image links expire (a day for websites, 14 to 30 days for Figma): copy anything the site keeps into its media library.

With someone else's site or file, take its layout and style, never its text, photos or logo.

## Allowance

Each storefront can read `REFERENCE_READS_PER_MONTH` references a calendar month (UTC), 50 by default; a read that fails isn't counted. A self-hosted server reads websites and documents once `FIRECRAWL_API_KEY` is set and Figma links once `FIGMA_TOKEN` is set ([self-hosting.md](self-hosting.md)). Until then those reads answer 503.

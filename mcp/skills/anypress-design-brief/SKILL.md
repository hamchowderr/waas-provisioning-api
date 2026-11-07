---
name: anypress-design-brief
description: Write the design brief for a WordPress site on the AnyPress theme before any page is built - who it's for, one idea that runs through the site, the kit, a locked palette and font pairing from the theme's slugs, every page's section plan from the kit's patterns, the photo list and every button. Use as step 2 of anypress-site-builder, before a redesign, or whenever someone asks for a site to "look like a real business, not a template".
license: GPL-3.0-or-later
---

# The design brief

Write `design-brief.md` (template: `references/brief-template.md`) before building any page. It is about 40 lines and every part is required. A vague line ("modern and clean", "blue accent", "nice photos") means the brief isn't done: write what you'd see instead.

The brief is a contract. Later steps follow it; if one of them needs to change it, change the brief first and say why.

## Read first

- `intake.md` from step 1 of `anypress-site-builder`, `business_profile` read and `get_site`.
- `site_styles` get: the store's colour, font-size and spacing slugs, its style variations (kits, palettes, font sets) and its section styles.
- `site_patterns` find with the kit's category, so the section plan names patterns that exist.
- The owner's reference site or brand book, through `anypress-design-md`, if they gave one.

## 1. Who it's for, in one sentence

Who visits, what they want in the first five seconds, and the feeling the site should give them. "Homeowners in Columbus with a fault right now: they want to know we can come today and what it costs, and to feel they've found a tidy, careful firm." Not "a modern website for an electrician".

## 2. One idea that runs through the site

A plain idea the whole site carries, that you could name in a word or two: "the van that turns up on time", "the kitchen table", "the logbook". It decides which photos lead, what the headings sound like and which kit sections fit. It must come from this business, not from web design.

## 3. The kit

Pick the kit that fits the trade (each is a style plus its own home page and sections):

| Kit | For | Patterns |
|---|---|---|
| Ridge | Trades and home services | `anypress/kit-home-services` |
| Circuit | Electricians and technical trades | `anypress/kit-electrical` |
| Hearth | Restaurants, cafes, bakeries | `anypress/kit-food` |
| Still | Wellness, spas, therapists | `anypress/kit-wellness` |
| Ledger | Accountants, lawyers, consultants | `anypress/kit-professional` |
| Parcel | Shops (FluentCart) | `anypress/kit-shop` |
| Chapter | Courses and coaches | `anypress/kit-courses` |
| Gloss | Salons, barbers, beauty | `anypress/kit-salon` |
| Commons | Associations, chambers, churches | `anypress/kit-community` |
| Rep | Gyms and studios | `anypress/kit-fitness` |
| Frame | Portfolios and studios | `anypress/kit-portfolio` |
| Keystone | Real estate | `anypress/kit-real-estate` |
| Launch | Software and apps | `anypress/kit-software` |
| Byline | Blogs and magazines | `anypress/kit-magazine` |

Shared sections that work with any kit are in `anypress/blocks-*` and `anypress/pages`. Kits with only a home page today need their inner pages from `anypress/pages` and the shared sections, restyled by the kit.

## 4. A locked palette

The theme has eleven colour slugs. Fill each with the kit's colour, a theme palette (charcoal-gold, forest, night, ocean, plum, rose) or the owner's brand colours, and write one line on why it fits this business:

`primary` (brand), `primary-accent` (brand soft), `primary-alt` (second brand), `primary-alt-accent` (second brand deep), `main` (text), `main-accent` (text soft), `base` (background), `secondary` (muted text), `tertiary` (tint), `border-light`, `border-dark`.

Rules:

- **One accent.** The brand colour does the work; the second brand colour is for one band or one kind of button, not sprinkled.
- **One mood per site.** A dark site is dark everywhere; a light site may have one dark band (`is-style-section-dark`).
- **Avoid the colour schemes machine-made sites reach for** unless they are the business's own brand: near-black with an orange or amber accent, near-black with neon cyan or green, beige or cream with brass and oxblood, and purple or violet glows. Start from the trade's real world (a plumber's van, a bakery's flour and crust, a law firm's paper) instead.
- **Every pair passes WCAG AA.** On the theme repo, `npm run contrast` checks every palette in every section style.

Section styles carry the palette into sections: `is-style-section-tint`, `-card`, `-brand`, `-brand-soft`, `-second-brand`, `-dark`. Name which sections use which.

## 5. Locked fonts

Pick the kit's own pairing or one of the theme's font sets (editorial, friendly, sturdy, warm-serif), or two of the theme's fonts (Figtree, Bricolage Grotesque, Archivo, Public Sans, Libre Franklin, Manrope, Schibsted Grotesk, Instrument Sans, Jost, Big Shoulders, Fraunces, Newsreader, Young Serif, Source Serif, Instrument Serif, Bodoni Moda, Crimson Pro, Gloock, Literata). Rules:

- A serif heading only when the business is truly editorial, formal or long-established, with a line saying why. A trade being "traditional" isn't enough.
- Emphasis inside a heading uses the same family in bold or italic, never a second face dropped in.
- Sizes come from the theme's scale only: `x-small` to `poster`.

## 6. The section plan, for every page

List every page in the menu (10 or more for a full site: see the kit checklist), and for each one its sections in order, each with the pattern it starts from and its section style:

```
Home
1. Hero: ridge-hero (second-brand): headline, one line, Call button, team photo
2. Proof: ridge-proof (base): licences, insurance, years, Google rating
...
```

Rules for every page:

- **No layout twice in a row**, and a page of six or more sections uses at least four different layouts.
- **At most one small label above a heading for every three sections.** The heading alone is usually enough.
- **No row of three identical cards as a default.** Use the kit's own service list, a split, or a carousel.
- **The hero:** headline of eight words or fewer (two lines at most), one sentence under it, one main button and at most one second button, and a real photo. Nothing else in it: no badges, no rows of icons, no prices.
- **Photos lead most sections.** A page with no photo is unfinished.

## 7. The photo list

One line per photo slot from the section plan: page, section, what it must show, its shape (wide, tall, square). Step 3 of `anypress-site-builder` fills them.

## 8. Every button

List every action on the site with its one wording, used everywhere: "Call 555 0142", "Get a free quote", "Book a visit". One wording per action, never "Contact us" here and "Get in touch" there. Primary buttons are three words or fewer, and say what happens.

## 9. Check the brief before moving on

- Could another business in the same trade use it unchanged? If so, sections 1 and 2 aren't specific enough.
- Is any line vague? Rewrite it as something you'd see.
- Does every page in the menu have a section plan, and every pattern named exist?

Show the owner five lines: the idea, the kit, the colours, the fonts and the page list.

## Where it came from

Made for AnyPress from the design brief and design recipe in Higgsfield's website skill (MIT), rewritten for WordPress, the AnyPress theme's slugs and its kits. Notice in `NOTICE.md`.

---
name: site-design
description: Use before building or restyling anything on the website - new sections, whole pages, colours, fonts, spacing, header or footer. How this site's theme is put together (its colour, font, spacing, radius and shadow slugs, section styles, kits, shared sections and interactive blocks) and how to write block markup that follows it.
---

# Designing on this website

The site runs a block theme (named AnyPress in WordPress; don't name it to the owner). Everything on a page is built from the theme's ready-made sections and its design tokens, so the owner can restyle the whole site later in one place and every page follows.

## The rules

1. **Start from a pattern, not from scratch.** `site_patterns` find by word (`hero`, `services`, `pricing`, `testimonial`, `faq`, `contact`, `team`, `gallery`) or by category (below). Add it, then replace its sample words and pictures with the business's own (from "About this business").
2. **Tokens only.** Colours, font sizes, spacing, radius and shadows always use the slugs below. Never a hex colour, rgb(), px size or a font name in a block: those break when the owner changes the look.
3. **One change at a time.** Copy the section's markup from `site_pages` read (or the open editor), change only what was asked, keep its `metadata.name`, `className` and layout.
4. **Real content.** Real products, prices, booking types, place and phone from the business profile. Never lorem ipsum, never invented reviews, prices, awards or numbers. If something is missing, leave a short clear placeholder the owner will notice, like "[Your opening hours]", and say so.
5. **Pictures** come from `add_image` (a public https link) or the media library. Every image gets alt text that says what it shows.

## Colours (`backgroundColor`, `textColor`, `var:preset|color|<slug>`)

| Slug | Use |
|---|---|
| `base` | Page background |
| `main` | Main text |
| `main-accent` | Muted text on base |
| `secondary` | Supporting text, captions |
| `tertiary` | Soft background panels |
| `primary` | Brand colour: buttons, links, highlights |
| `primary-accent` | Soft brand tint backgrounds |
| `primary-alt` | Second brand colour |
| `primary-alt-accent` | Soft tint of the second brand colour |
| `border-light`, `border-dark` | Lines and borders |

Section styles give a whole section a colour scheme with readable text (WCAG AA in every palette): add `"className":"is-style-section-<name>"` to the section's group. Names: `tint`, `card`, `brand`, `brand-soft`, `second-brand`, `dark`. Prefer these over setting background and text colours by hand.

## Type

Font sizes (`"fontSize":"<slug>"`): `x-small`, `small`, `base`, `medium`, `large`, `x-large`, `xx-large`, `xxx-large`, `poster` (huge display text). Headings: h1 `xxx-large` in a hero, section titles `xx-large` or `x-large`, card titles `large`. Body copy stays `base`; lead sentences `medium`.

The font families are set by the site's style. Don't set `fontFamily` on blocks unless the owner asks for a different font somewhere; to change fonts site-wide use `site_styles_change` with a typography preset or `styles.typography.fontFamily` (`var:preset|font-family|<slug>`).

## Spacing, radius, shadow

- Spacing (`var:preset|spacing|<slug>`): `small`, `medium`, `large`, `x-large`, `xx-large`, `xxx-large`, `xxxx-large`. Sections usually pad `x-large` to `xx-large` top and bottom; gaps between cards `medium` or `large`.
- Radius (`var:preset|border-radius|<slug>`): `none`, `xs`, `sm`, `md`, `lg`, `xl`, `2-xl`, `full`.
- Shadow (`var:preset|shadow|<slug>`): `small-light`, `medium-light`, `large-light`, `medium-dark`.

## Ready-made sections

- **Shared sections** that fit any look, by category: `anypress/blocks-heroes`, `anypress/blocks-about`, `anypress/blocks-services`, `anypress/blocks-proof` (reviews, logos, numbers), `anypress/blocks-calls-to-action`, `anypress/blocks-contact`, `anypress/blocks-blog`.
- **Starter pages** (`anypress/pages`): home pages for each kind of site, about, services, contact and more. Use one for a whole new page, then rewrite every line for the business.
- **Kits**: a complete look for one trade, a style plus its own home page and sections. Ridge (home services, `anypress/kit-home-services`), Hearth (food and drink, `kit-food`), Still (wellness, `kit-wellness`), Ledger (professional services, `kit-professional`), Parcel (online shop, `kit-shop`), Chapter (courses, `kit-courses`), Gloss (salon and beauty, `kit-salon`), Commons (associations, chambers and churches, `kit-community`), Rep (gyms and classes, `kit-fitness`), Frame (portfolios, `kit-portfolio`), Keystone (real estate, `kit-real-estate`), Launch (software, `kit-software`), Byline (blogs and magazines, `kit-magazine`). Suggest the kit that fits the business; applying one changes the whole site's look, so it needs the owner's yes.
- **Colour palettes** (Charcoal and gold, Forest, Night, Ocean, Plum, Rose) and **font pairings** (Editorial, Friendly, Sturdy, Warm serif) are style variations the owner can also pick in Appearance → Editor → Styles.

## Interactive blocks

Four blocks from the site's block plugin, each saving its inner blocks: `anypress/carousel` (slides of photos, reviews or cards), `anypress/counter` (a number that counts up, for real figures only), `anypress/map` (a map of the business's address), `anypress/popup` (a dialog opened by a button, for an offer or a booking form). FAQs use WordPress's own Accordion block (`core/accordion`, one item per question, `is-style-divided`).

## References

- `references/markup.md`: the block markup shapes this theme uses, with tokens, to copy from.
- For deeper WordPress detail load the official skills: `wp-patterns` (block markup, design with tokens, anti-patterns) and `wp-block-themes` (theme.json, styles, templates and parts).

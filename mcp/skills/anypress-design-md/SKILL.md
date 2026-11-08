---
name: anypress-design-md
description: Turn a reference website, brand book or Figma file into a DESIGN.md (colours, fonts, spacing, corners, components and do's and don'ts, in Google's DESIGN.md format), and turn a DESIGN.md into an AnyPress theme style variation or site styles - both ways. Use when an owner says "make it look like this site", hands over brand guidelines, or when a kit needs its own DESIGN.md.
license: GPL-3.0-or-later
---

# DESIGN.md for AnyPress sites

DESIGN.md is a plain-text design system: YAML tokens (colours, typography, rounded, spacing, components) plus prose sections in a fixed order (Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts). The format is Google's (`google-labs-code/design.md`, version `alpha`). Here it's the bridge between "the look the owner wants" and the theme's `theme.json` slugs.

## A. From a reference to a DESIGN.md

1. **Read the reference.** Start with `read_reference` (start, then wait): for a website link, Shopify shop, Figma link or document it answers one bundle with the colours, fonts, sizes, radius and logo (`design`), each page's text and a screenshot, its images, and a shop's products. Use `design` as the first draft of the tokens and the screenshots to check them. Where you also have a browser, open the site (Playwright, or the browser tools you have) at 1440px and 390px, take screenshots, and read the computed styles of: the page background, body text, headings h1 to h3, links, the main button and its hover, a card, a form field, the header and the footer. For a brand book or Figma file, read its colour, type and spacing pages.
2. **Write the tokens** in the DESIGN.md front matter, using the token names below so they map straight onto the theme. Hex colours; sizes in px or rem.
3. **Write the prose**: one short paragraph per section on how the look is used (where the accent goes, how big headings get, how much air between sections), and a Do's and Don'ts list.
4. **Take the look, never the content.** Colours, type, spacing and the kind of layout. Never copy a reference site's words, photos, logo or code.
5. Save it as `DESIGN.md` in the build folder and show the owner the colours and fonts.

## B. From a DESIGN.md to the theme

Map the tokens onto the theme's slugs and apply them as one change:

| DESIGN.md token | theme.json slug |
|---|---|
| `colors.primary` | `primary` (brand) |
| `colors.primary-soft` | `primary-accent` |
| `colors.secondary` | `primary-alt` (second brand) |
| `colors.secondary-deep` | `primary-alt-accent` |
| `colors.on-surface` | `main` (text) |
| `colors.on-surface-soft` | `main-accent` |
| `colors.surface` | `base` (background) |
| `colors.muted` | `secondary` (muted text) |
| `colors.surface-tint` | `tertiary` (tint) |
| `colors.border` / `colors.border-strong` | `border-light` / `border-dark` |
| `typography.headline-*` font family | `styles.elements.heading.typography.fontFamily` (a theme font slug) |
| `typography.body-md` font family | `styles.typography.fontFamily` |
| `typography.*` sizes | the nearest of `x-small` to `poster`; never a new pixel size |
| `spacing.*` | the nearest of the theme's `small` to `xxxx-large` |
| `rounded.*` | button and image radius in `styles.elements.button.border.radius` and `styles.blocks.core/image.border.radius` |
| `components.button-primary` | `styles.elements.button` (colours as `var(--wp--preset--color--<slug>)`) |

Rules:

- **Keep the slugs.** Live pages use them; change their colours, never their names.
- **Fonts:** pick from the theme's fonts first. A font the theme doesn't ship needs the owner's yes, and its licence must allow web use; add it through the Site Editor's font library.
- **Contrast:** every text and background pair must still pass WCAG AA in every section style. Check before applying.
- On a store, apply with `site_styles` update (`settings.color.palette.custom` and `styles`). For a new kit in the theme repo, write `styles/kit-<name>.json` with `tools/generate/` (`wp-block-themes`), and keep the DESIGN.md next to it as `docs/kits/<name>/DESIGN.md`.

## C. From the theme to a DESIGN.md

For a kit or a finished store, read `site_styles` get (or `styles/kit-<name>.json`) and write the DESIGN.md the other way round, so other tools and agents can follow the look. Every kit should have one.

## Template

```yaml
---
version: alpha
name: <Kit or business> 
description: <one line on the look>
colors:
  primary: "#"
  primary-soft: "#"
  secondary: "#"
  secondary-deep: "#"
  on-surface: "#"
  on-surface-soft: "#"
  surface: "#"
  muted: "#"
  surface-tint: "#"
  border: "#"
  border-strong: "#"
typography:
  headline-display: { fontFamily: <font>, fontSize: 72px, fontWeight: 700, lineHeight: 1.0 }
  headline-lg: { fontFamily: <font>, fontSize: 44px, fontWeight: 700, lineHeight: 1.1 }
  body-md: { fontFamily: <font>, fontSize: 18px, fontWeight: 400, lineHeight: 1.6 }
  label-md: { fontFamily: <font>, fontSize: 14px, fontWeight: 600 }
rounded: { sm: 4px, md: 8px, full: 9999px }
spacing: { sm: 16px, md: 24px, lg: 48px, xl: 96px }
components:
  button-primary: { backgroundColor: "{colors.primary}", textColor: "{colors.surface}", rounded: "{rounded.md}" }
---
```

Then `## Overview`, `## Colors`, `## Typography`, `## Layout`, `## Elevation & Depth`, `## Shapes`, `## Components`, `## Do's and Don'ts`, in that order, each a few lines.

## Where it came from

Made for AnyPress from Google's DESIGN.md format (Apache 2.0), mapped onto the AnyPress theme's `theme.json`. Notice and licence in `NOTICE.md` and `LICENSE-Apache-2.0.txt`.

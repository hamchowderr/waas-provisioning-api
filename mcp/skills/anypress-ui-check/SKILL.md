---
name: anypress-ui-check
description: Open a WordPress page in a real browser at desktop and phone width and check what visitors touch - every button and link has a name, every form field a label, keyboard focus shows, tap targets are big enough on a phone, text passes WCAG AA contrast, nothing scrolls sideways, images load with alt text, and the page has its title, description and share image. Use on a WordPress Playground copy of an AnyPress site before it goes live, and as step 6 of anypress-site-builder.
license: GPL-3.0-or-later
---

# The UI check

The slop gate (`anypress-slop-gate`) reads the markup. This check opens the page and uses it the way a visitor does, at 1440x900 and at 390x844, with reduced motion on.

## Run it

Run it against a WordPress Playground copy of the site (the `wp-playground` and `blueprint` skills), never a customer's live store.

```bash
node scripts/ui-check.mjs http://127.0.0.1:9400/ http://127.0.0.1:9400/contact/
node scripts/ui-check.mjs <urls> --json
```

It needs Node 22+ and Playwright (`npm i playwright`; on machines where `require('playwright')` already works, nothing to install). Exit code 2 means at least one FAIL. Run it on the home page, every page with a form, the shop or booking page, and one ordinary inner page.

## What it checks

| Id | Level | What it means | How to fix it on a WordPress site |
|---|---|---|---|
| `lang`, `title`, `zoom-off` | FAIL | No page language or title; zoom turned off | Theme and SEO settings; never block zoom |
| `description`, `share-image` | WARN | No meta description or share image | Rank Math's title and description, and a 1200x630 share image |
| `sideways-scroll` | FAIL | The page is wider than the screen | The named block: give columns a stacking rule, images `max-width:100%`, long words `overflow-wrap` |
| `no-name` | FAIL | A button or link with no name | An icon-only button needs an aria-label (Social Icons and AnyPress Blocks take one in the sidebar) |
| `field-label` | FAIL | A form field with no label | In Fluent Forms, give the field a visible label; a placeholder isn't a label |
| `autocomplete`, `field-type` | WARN | Name, email and phone fields phones can't fill in, or that open the wrong keyboard | Use Fluent Forms' Name, Email and Phone fields rather than a plain text field |
| `tap-size` | WARN | A link or button under 44px on a phone | Bigger padding through the theme's spacing slugs; dots and icons need a bigger hit area |
| `img-alt`, `img-broken`, `img-size` | FAIL, FAIL, WARN | No alt text; a picture that didn't load; no size, so the page jumps | Alt text in the Image block; re-upload with `add_image`; images from the media library carry their size |
| `h1`, `skip-link` | FAIL, WARN | Not exactly one main heading; no skip link | One h1 per page; the theme's header part has the skip link |
| `contrast` | FAIL | Text below WCAG AA on a solid background | Use a section style from the theme (`is-style-section-*`) or a palette pair that passes; never hand-pick a colour |
| `focus-ring`, `focus-covered` | FAIL, WARN | Keyboard focus doesn't show; a focused item sits under the sticky header | The theme's focus style (`settings.custom.focus` in theme.json); `scroll-padding-top` for the header |

Text over photos (cover blocks) isn't measured: look at it in the screenshots, and give the cover a dim overlay if any word is hard to read.

## After it runs

Fix every FAIL and run it again. A WARN left on purpose goes in `check.md` with the reason. A finding that comes from the theme or a plugin rather than the page (the theme's own menu button, a Fluent Forms button style) is reported to the person running the build, with the page and element, so it gets fixed in the theme for every site.

## Where it came from

Made for AnyPress from Vercel's Web Interface Guidelines, rewritten for WordPress block themes, Fluent Forms and a real-browser check. MIT; the notice is in `NOTICE.md`.

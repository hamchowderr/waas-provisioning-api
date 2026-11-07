---
name: anypress-slop-gate
description: Check a WordPress page's block markup for the signs of a rushed or machine-made page before anyone sees it - placeholders, long dashes, fixed colours or pixel sizes, the same layout twice in a row, too many small labels above headings, missing alt text, dead links, mixed button wording and stock marketing words. Use after building or rewriting any page on an AnyPress store, and as step 6 of anypress-site-builder.
license: GPL-3.0-or-later
---

# The slop gate

A script that reads a page's block markup and lists what has to change before the page is shown to anyone. It is a gate, not advice: a page with a FAIL isn't finished.

## Run it

1. Get the page's markup: `site_pages` read on an AnyPress store, `wp post get <id> --field=post_content` on Playground, or the file a build script wrote.
2. Save it to a file and run:

```bash
node scripts/slop-gate.mjs page.html                     # one page
node scripts/slop-gate.mjs pages/*.html --photos photos.txt  # every page, and say which planned photos aren't used
node scripts/slop-gate.mjs page.html --demo              # a demo site: made-up example.com contacts are allowed
node scripts/slop-gate.mjs page.html --json              # for another script
```

It needs Node 22 or newer and nothing else. Exit code 2 means at least one FAIL.

## What it checks

| Id | Level | What it means | How to fix it |
|---|---|---|---|
| `placeholder` | FAIL | Lorem ipsum, `[Your Business Name]`, `{{field}}`, TODO, chatbot leftovers | Write the real text (`anypress-site-copy`) |
| `sample-name`, `sample-contact` | FAIL | Jane Doe, Acme, `hello@example.com` | The business's own name and contacts |
| `placeholder-image`, `empty-image` | FAIL | The theme's grey placeholder, or no picture | A real photo through `add_image` |
| `long-dash` | FAIL | A long dash (— or –) in the copy | A full stop, comma, colon or brackets |
| `fixed-colour`, `fixed-size` | FAIL | A hex or rgb colour, or a px/rem size, in a block | The theme's slugs: `"backgroundColor":"primary"`, `"fontSize":"large"`, `var:preset|spacing|large` |
| `repeated-layout` | FAIL | Two sections in a row with the same layout | Swap one for a different pattern from the kit |
| `few-layouts` | WARN | Six or more sections but fewer than four layouts | Vary the sections |
| `too-many-labels` | FAIL | More small labels above headings than one per three sections | Delete the extra labels; the heading is enough |
| `img-alt` | FAIL | An image with no alt text | Say what the photo shows |
| `photo-repeat`, `photo-unused` | WARN | A photo used twice; a planned photo not used | Use a different photo; place the missing one |
| `dead-link` | FAIL | A link to `#` or nowhere | Link to the real page, phone number or form |
| `cta-labels` | WARN | One action with several wordings | One wording per action, everywhere |
| `vague-button`, `long-button` | WARN | "Learn more", "Submit"; a button over four words | Name the action: "Book a visit" |
| `two-h1`, `heading-order` | FAIL, WARN | Two main headings; a heading level skipped | One h1 per page; go down one level at a time |
| `stock-word`, `stock-phrase` | FAIL | Elevate, seamless, unlock, "look no further", "we've got you covered" | The fact it stands for: the price, the time, the place |
| `invented-figure` | WARN | "40% faster", "3x more" | Keep only figures the business can back up |
| `bad-block` | FAIL | Block attributes WordPress can't read | Rebuild the block from its pattern |

Literal uses are allowed: "bespoke kitchens", "seamless gutters" and "robust steel frames" are descriptions, not slop.

## When a check is wrong

If a FAIL is truly a false alarm (the business is called "Elevate Fitness"), leave it, say so in `check.md` with the reason, and carry on. Never change the page just to quiet the script in a way that makes it worse, and never edit the script to pass a page.

## Where it came from

Made for AnyPress from the mechanical gate in Higgsfield's website skill and the copy lint in Taste Skill, rewritten for WordPress block markup and the AnyPress theme. Both are MIT; the notices are in `NOTICE.md`.

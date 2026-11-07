---
name: anypress-design-critique
description: Review a WordPress page on an AnyPress site the way a design director would - look at it at desktop and phone width, read its blocks, and say whether it looks made for this business or like a template, score it, and list what to fix in terms of the kit's patterns and the theme's slugs. Use after a page is built, when an owner says a page "looks off" or "looks like AI made it", and as step 6 of anypress-site-builder.
license: GPL-3.0-or-later
---

# Design critique

A critique has two parts that must not see each other until the end, so the script doesn't steer your eye:

- **A. Your review**, from screenshots and the page's blocks.
- **B. The checks**: `anypress-slop-gate` on the markup and `anypress-ui-check` on the page.

When you can start a separate agent, run A and B in two separate agents and only combine them at the end. When you can't, do A completely and write it down before running B, and say so on the report's first line ("Reviewed in one pass").

## Get the page

On a WordPress Playground copy: screenshots of the whole page at 1440px and at 390px, with reduced motion on and after waiting for photos and fonts. Read the page's blocks (`site_pages` read on a store) and the design brief if there is one.

## A. The review

Answer these in order, with what you see, never "looks good":

1. **Made for this business?** Could another business in the same trade use this page unchanged, by swapping the name? Which parts are specific (their photos, their prices, their town, their way of talking) and which are generic? This is the most important answer.
2. **First screen.** In five seconds, does a visitor know what's sold, where or for whom, and what to do next? Is the main button visible without scrolling, at both widths?
3. **Hierarchy.** One clear thing per section? Does the eye go headline, then photo or proof, then button?
4. **The signs of a machine-made page.** Small labels above most headings; three identical cards in a row; the same layout twice in a row; a centred stack in every section; icons in circles; vague headlines ("Quality you can trust"); stock phrases; a photo that doesn't show this kind of business; a dark page with a neon or orange glow; purple gradients. Name each one you see and where.
5. **Typography.** Heading sizes from the theme's scale with a clear step between levels; body text easy to read (line length about 60 to 75 characters on desktop); no word dropped in from another font.
6. **Colour.** One accent doing the work; one mood for the whole site; section styles used to give rhythm, not at random.
7. **Photos.** Do they lead? Do they fit the business and each other? Is any one used twice, stretched or blurry?
8. **Phone.** Does each section read well at 390px, in the right order, with the main action one tap away?
9. **Trust.** Real reviews with names, licences, years, guarantees, prices or "from" prices, where the business has them.
10. **Score** it on Nielsen's ten heuristics, 0 to 4 each (a landing page may mark "flexibility and efficiency" and "help and documentation" as n/a). Be honest: most real pages land between 20 and 32 out of 40.

## B. The checks

Run `anypress-slop-gate` and `anypress-ui-check` and keep their findings aside until A is written.

## The report

```
Method: two separate passes (or: Reviewed in one pass, because <reason>)
Made for this business? <yes, partly or no, and why in two lines>
Score: <n>/<max> (<band>)
What works: <2 or 3 things>
Fix first: <3 to 5 things, most important first, each with the fix>
Checks: <FAIL and WARN counts from the slop gate and UI check; where they agree with the review; any false alarm>
Smaller things: <a short list>
```

Every fix names the WordPress change, not a CSS rule: "Swap the second three-card row for `ridge-steps`", "Move Reviews to `is-style-section-tint`", "Drop the labels above Services and FAQ", "Replace the hero photo with one of the team at work", "Raise the hero headline to `poster`".

End by asking the owner (or the person building) which of the "fix first" items to do, unless they asked you to fix everything, in which case fix them and run the checks again.

## Where it came from

Made for AnyPress from Impeccable's critique and audit (Apache 2.0) and Taste Skill's list of the signs of a machine-made page (MIT), rewritten for WordPress pages, the AnyPress kits and the site tools. Notices in `NOTICE.md`; the Apache licence in `LICENSE-Apache-2.0.txt`.

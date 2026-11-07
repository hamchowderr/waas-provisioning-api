---
name: anypress-demo-build
description: Build one AnyPress demo website (an industry and version from the Demo Sites Plan) on WordPress Playground, start to finish, by running anypress-site-builder with the plan entry as the brief's answers - no questions, no live stores. Use when asked to build, rebuild or check a demo site, e.g. "build the HVAC demo" or "demo-build plumbing/clearwater".
license: GPL-3.0-or-later
---

# Building a demo site

A demo shows a seller or a business owner what AnyPress makes for their trade. It must pass the same checks as a customer's site, and it runs **only on WordPress Playground**: never create a store, seller or storefront on the server for a demo.

## Input: the plan entry

The Demo Sites Plan (`Demo Sites Plan.json`) lists every industry and its 3 to 5 versions. Take the one asked for (`<industry id>/<version slug>`). It gives, for the industry: the kit, the plan, the extra pages, the forms, the AnyPress Blocks used, the plugins on show, the must-haves, blog topics and photos to find; and for the version: the business name, town and time zone, its angle, its kit, colours and fonts (`kit` means the kit's own), its plan, its offers with prices, extras, its build folder and the plugins its Playground copy installs. `basePages` are the pages every demo has (Home, About, Contact, FAQ, a blog with 3 posts that open, privacy policy, 404, a thank-you page for each form).

Skip versions marked `done` or `example` unless asked to rebuild them.

## The route

Run `anypress-site-builder` with these changes:

1. **Brief:** no questions. Write `intake.md` from the plan entry; anything the plan doesn't say gets a plausible made-up fact, listed under **Assumed**. Contacts are made up: a 555 phone number, an `example.com` email, a street and town but no house number.
2. **Design:** `anypress-design-brief` as usual. The kit, colours and fonts come from the plan entry. Two versions of the same industry must differ in at least four of: kit or palette, fonts, hero layout, the idea, the photos' subject, the button style.
3. **Photos:** CC0 photos only (Openverse with `license=cc0`, or Pexels and Unsplash where their licence allows), saved in the version's folder with `photos.json` (file, source link, licence, what it shows). No made images unless the owner said yes for this demo.
4. **Pages:** written by the version's build script, `demo/<kit>/<slug>/build.php` in the theme repo (start from `demo/ridge/` and `demo/circuit/`, which build the two finished demos), using the kit's patterns and the business's words, so the demo can be rebuilt from scratch at any time.
5. **Words:** `anypress-site-copy`, with the plan's offers and prices.
6. **Check:** `anypress-slop-gate --demo` on every page, `anypress-ui-check` on the home page, a form page and one inner page, `anypress-design-critique` on the home page, then the theme's `npm run demo -- <kit> --check` and the kit checklist by hand at 1440px and 390px.
7. **Launch:** nothing goes live. Commit the version's folder and blueprint in a pull request on the theme repo, with screenshots (desktop and phone) and the `check.md` summary in the description, and mark the version `done` in the plan.

## Done means

- Every page in the industry's page list and `basePages` exists, is in the menu or footer, and is finished.
- Every form sends and shows its thank-you page; the popup opens once and closes three ways; FAQ, carousel and counters work.
- The slop gate and UI check have no FAIL; any WARN left has a reason in `check.md`.
- The critique says the page is made for this business, and the score is 28/40 or more.
- The blueprint opens the demo on Playground in one click.

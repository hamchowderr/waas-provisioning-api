---
name: anypress-site-builder
description: Build a whole website for a business on an AnyPress store (or a WordPress Playground copy) in seven fixed steps - Brief, Design, Photos, Pages, Words, Check, Launch - each leaving a file the next step uses and each shown to the owner before the next starts. Use when someone asks for a new site, a redesign, a site for a client, or a demo site, rather than a change to one page.
license: GPL-3.0-or-later
---

# Building a website on AnyPress

One fixed route from "I need a website" to a live site. Run the steps in order and don't skip or merge them: a "simple" site is exactly where pages come out looking like templates. Each step writes one file into the build folder (`site-build/<site-slug>/` in the working folder, or the demo's folder for a demo) and ends with a short summary for the owner. Don't start the next step until the owner has said yes, unless they told you to run straight through (a demo build always runs straight through).

Small changes to a site that's already built don't restart this route: read the page, change the part, run the Check step on that page.

| Step | Skill it uses | Writes | Owner sees |
|---|---|---|---|
| 1. Brief | this skill | `intake.md` | The answers, in one list |
| 2. Design | `anypress-design-brief` (and `anypress-design-md` when there's a reference site or brand book) | `design-brief.md` | The look in five lines and the page list |
| 3. Photos | this skill | `photos.md` | Which photo goes where, and the cost of any made image |
| 4. Pages | `anypress-stores` site tools, `wp-patterns`, `wp-block-themes` | draft pages on the store | Preview links |
| 5. Words | `anypress-site-copy` | the pages' text, in place | Preview links |
| 6. Check | `anypress-slop-gate`, `anypress-ui-check`, `anypress-design-critique` | `check.md` | What was found and fixed |
| 7. Launch | `anypress-stores` | (the site goes live) | One line: the address and what's on it |

## Talk about the site, not the work

Say "Your site's pages are ready to look at", not "pushed 12 drafts through page_section". Never mention blocks, markup, tools, slugs, branches or scripts to a business owner. Agencies and resellers can hear more, but still lead with what they'll see.

## Keep it short

Write each file once and whole. Start slow work early (made images, a theme style change) and build around it while it finishes. Ask questions in one round only (step 1), never a second time: anything not answered gets a sensible default that you name in the step's summary.

## 1. Brief: one round of questions

Read first, ask second: `get_site`, `business_profile` read, `site_pages` list and `site_styles` get. Then ask, in one message, only what those didn't answer:

1. **The business:** what it sells or does, for whom, and where (town, area served, or online only).
2. **Offers:** the main 3 to 6 services or products, with prices or "from" prices if they share them.
3. **What visitors should do:** call, book, get a quote, buy, join, donate, visit. One main action.
4. **Brand:** do they have a logo, colours, fonts or photos to use? Or should the site design them?
5. **Plan features they'll use:** bookings (FluentBooking), a shop (FluentCart), a community or courses (FluentCommunity), a newsletter (FluentCRM). Only ask about what their plan includes (`show_store`).
6. **Pages they know they want**, and any site they like the look of (a link is enough).

When the owner gives a reference (a website link, a Shopify shop, a Figma link, a PDF or other document), read it with `read_reference` (start, then wait) before step 2, and keep its bundle beside `intake.md`. A website read takes every page; page through a big bundle with get (offset and limit) and check `coverage` first: every page read, and any that failed retried or named to the owner. Products (Shopify, WooCommerce, Squarespace or found on the pages) and posts (`items`) are in the bundle: offer to add them to the store. A brief or menu as a document gives the facts to write from; someone else's site gives only the look and the kind of layout.

Write `intake.md` with the answers and, under **Assumed**, every default you chose for a missing answer. Save lasting facts with `business_profile` save once the owner confirms them.

## 2. Design: the brief is a contract

Run `anypress-design-brief`. It picks the kit, the colours and fonts (theme slugs), the section plan for every page and the button list, and writes `design-brief.md`. If the owner gave a reference site or brand book, run `anypress-design-md` first and feed its DESIGN.md into the brief.

Later steps may not quietly go against the brief. If something has to change, edit the brief first and say why in the step's summary.

## 3. Photos: real ones first

Every site needs real photos: a page of text and colour blocks is unfinished, not minimal. Fill `photos.md` with one row per photo slot in the brief's section plan (page, section, what the photo must show, its shape), then fill the slots in this order:

1. **The owner's own photos** (their team, their work, their place). Always best.
2. **Free photos with a CC0 or similar licence** (Openverse with `license=cc0`, Pexels, Unsplash), downloaded into the build folder with the source link and licence kept in `photos.md`. The photo must show the kind of thing the business really does; a stock photo is never presented as the business's own staff or premises in the words around it.
3. **A made image** only for a slot nothing else fills (an EV charger in a garage, a van with no logo). Say which slots, what it costs and get a yes first; label it in `photos.md`.

Then the three that every site gets: the logo (or the business name set in the brand font when there's no logo), the site icon, and a share image (1200x630) for links shared on social media.

Upload each photo with `add_image` when the pages are built, and give every one alt text that says what it shows.

## 4. Pages: build to the brief

Build every page in the brief's page list as a **draft**, section by section, from the kit's own patterns (`site_patterns` find with `category: "anypress/kit-<kit>"`, then `anypress/pages` and `anypress/blocks-*`). Re-read the brief's section plan before each page; when your habit and the brief disagree, the brief wins.

- Use only the theme's colour, font-size and spacing slugs (`site_styles` get lists them), never hex colours or pixel sizes, so the owner can restyle the site later in the Site Editor.
- Put each photo from `photos.md` in its slot.
- The header has the main action as its button; every menu item goes to a finished page; nothing links to `#`.
- Forms are Fluent Forms with a thank-you message; every page's footer has the newsletter signup when the plan has FluentCRM.
- Motion is the kit's own and AnyPress Blocks' (Carousel, Counter, Popup). Nothing waits invisible until it's scrolled to, and everything rests under reduced motion.

Share the draft links (`site_pages` create returns a preview link).

## 5. Words: every line written for this business

Run `anypress-site-copy` over every page: headings, button labels, prices, FAQ, reviews (real ones only, or clearly marked samples on a demo), the about story and the contact details. The pattern's sample text never survives this step.

## 6. Check: nothing goes live with a FAIL

On each page, in this order, and don't skip a check because the one before it passed:

1. Built from a reference: `read_reference` check (the store and the reference id; `ownContent` true when the reference is the owner's own site). Every reference page must come back `pass`, or `warn` with the reason written down; a `fail` (a missing page, a heading not carried over, someone else's text copied) is fixed first. Then compare each `referenceScreenshot` with the store page.
2. `anypress-slop-gate` over the page's block markup (`site_pages` read gives it).
3. `anypress-ui-check` on a Playground copy at desktop and phone width.
4. `anypress-design-critique` on the home page and one inner page.
5. By hand, the kit checklist: open every menu item, button and link, send every form, open every FAQ answer and gallery, at desktop and at 390px wide. Bookings: book a slot. Shop: add to cart and reach checkout.

Fix every FAIL, re-run the check that found it, and write `check.md`: what each check found, what was fixed, and any WARN left on purpose with the reason.

## 7. Launch: only on the owner's word

1. Show the owner the preview links one last time with the one-line summary of `check.md`.
2. When they say go: publish each page (`site_pages` update with `status: "publish"`), set the home page, update the menus, and if the site has its own domain follow "Put a store on the customer's own domain" in `anypress-stores`.
3. Tell them in one line: "Your site is live at <address>: <pages>, with <what visitors can do>." Add anything that was skipped and why.

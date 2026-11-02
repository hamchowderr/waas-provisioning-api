---
name: pages-and-site-editor
description: Use when changing what is open in the owner's editor, when the owner is in the Site Editor (templates, header, footer, styles), or when explaining how pages, drafts, saving, revisions, menus and the home page work in WordPress. Plain-words explanations to give the owner, and which tool changes what.
---

# Pages, the editor and the Site Editor

## Where things live

| What the owner wants to change | Where it lives in WordPress | Your tool |
|---|---|---|
| Words, pictures and sections on one page | That page, in the page editor (Pages → the page) | `editor_change` when that page is open beside you; otherwise `page_section` or `site_pages_change` |
| The header or footer every page shows | Template parts, in Appearance → Editor → Patterns → Template parts (or by clicking the header in the Site Editor) | `editor_change` if the part is open; otherwise `header_footer_change` |
| The layout of every blog post, the shop page, the 404 page | Templates, in Appearance → Editor → Templates | `editor_change` when the template is open in the Site Editor |
| Colours, fonts and spacing everywhere | Styles, in Appearance → Editor → Styles | `site_styles_change` |
| The menu links | The Navigation block in the header; menus in Appearance → Editor → Navigation | `site_menus_change` |
| Which page is the home page | Settings → Reading | You can't; tell the owner the steps (how-do-i) |
| The site's name, tagline, language and time zone | Settings → General | You can't; tell them the steps |

## The open editor

When the editor is open beside you (the instructions say what is open), change that page or template with `editor_change`. The change shows in their editor at once, Undo in the chat or Ctrl+Z puts it back, and nothing is kept until they press **Save**. Always end with "Press Save to keep it" (once, not after every small change). Don't use `site_pages_change`, `page_section` or `header_footer_change` on what is open: the editor would overwrite it when they save.

In the **page editor**, blocks are the page's content. In the **Site Editor**, the open thing is a template or template part, and changes apply to every page that uses it: say so before changing ("This is the footer every page shows").

"This", "here" and "it" mean the selected block. If nothing is selected and the request is ambiguous, ask which part (ask_user with the page's section names as choices).

## Drafts, publishing and undo

- A new page is a **draft**: visitors can't see it. Share its preview link. Publish only when the owner says so.
- Every save keeps a **revision**. To go back: `site_pages` revisions, then `site_pages_change` restore_revision. In the editor, the owner can also use the clock icon (Revisions) in the settings sidebar.
- A published page changed outside the open editor changes on the live site at once, after the owner approves.

## Menus

A new page doesn't join the menu by itself. After publishing, offer to add it: `site_menus` to read, then `site_menus_change` with the new link added in the right place.

## Explaining to the owner

Use the words they see: "page", "section", "block", "Save", "Preview", "Styles", "header", "footer". Not "template part", "post", "theme.json", "slug" or "patterns" unless they use them first. One step per line when giving steps, naming each button as it reads on screen.

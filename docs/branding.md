# Dashboard branding

A seller's or reseller's team can see the dashboard under their own name instead of the platform's: their name, logo, a small icon for the browser tab, a main color and a support email address. The dashboard keeps a small "Powered by" line.

Branding belongs to a storefront (a product) or to a reseller:

- **A storefront's branding** is what its own team, and a reseller's team while that storefront is picked in the switcher, sees.
- **A reseller's branding** fills every field a storefront leaves empty. A reseller with several brands sets its common look once, then gives each storefront its own name and logo where they differ. The reseller's name on its stores' "unavailable" page counts as its name when no branding name is set.

A storefront nobody branded shows the platform's own look.

## Fields

| Field | What it is |
|---|---|
| `name` | Shown in place of the platform's name: the browser tab, the sidebar and the sign-in page. Up to 60 characters. |
| `color` | Main color, `#rrggbb`. |
| `supportEmail` | Where the team is told to write for help. |
| `logoUrl` | The logo, up to 256 KB: PNG, JPEG or WebP. |
| `iconUrl` | The small icon for the browser tab, up to 64 KB: PNG, JPEG, WebP or `.ico`. |

The image type is read from the file itself, not from what the upload says. SVG is refused, since it can carry script. Logos and icons are public at `GET /branding/{id}/logo` and `/icon`, because the sign-in page shows them before anyone signs in. Their addresses change whenever the branding does, so browsers may keep them a day.

## Calls

Platform admin (admin token):

- `GET`, `PUT /admin/products/{productId}/branding` and `/admin/resellers/{id}/branding`. `PUT` takes any of `{"name": "…", "color": "#1d4ed8", "supportEmail": "…"}`; fields left out stay, and `null` or `""` clears one.
- `PUT`, `DELETE …/branding/logo` and `…/branding/icon`. The image is the request body.

A signed-in owner or admin brands their own storefront the same way under `/account/products/{productId}/branding`; members may look. A reseller's branding is set by the platform admin.

Every answer has the fields set on that storefront or reseller (null when not set), and `shown`: what the dashboard shows once the reseller's branding fills the gaps.

`GET /account` includes `brand`: the look of the storefront the session acts for, or `null` for the platform's own.

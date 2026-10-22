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

## Your own dashboard address

A storefront can have the dashboard answer at its own address, like `dashboard.janedesigns.com`, so its team never sees the platform's. The server needs `DASHBOARD_DOMAINS` set ([self-hosting](self-hosting.md)); without it `enabled` is false and setting one answers 503.

1. `PUT /admin/products/{productId}/dashboard-domain` `{"domain": "dashboard.janedesigns.com"}` adds the address to the dashboard's host. It must be under the seller's own domain (not a bare domain, and nothing of the platform's), and no store or other dashboard may use it. A new address replaces the one before.
2. The answer's `records` are the DNS records to add at the domain's DNS host: usually one `CNAME`, and a `TXT` record when the host needs proof of ownership. `name` is the full hostname; most DNS hosts want only the part before their domain (`dashboard`).
3. `POST …/dashboard-domain/check` looks again. Addresses still pending are also checked every night. `status` turns `active` once the host serves the address with a certificate, and `error` says why a check failed.
4. `DELETE …/dashboard-domain` stops using it.

On a dashboard hosted by Coolify (`DASHBOARD_DOMAINS=coolify`) the record is always a `CNAME` to the dashboard's own hostname. The address is added to the dashboard application only once that record is in place, and the application is deployed again so its proxy serves it and gets its certificate; the dashboard restarts briefly each time an address is added or removed.

A signed-in seller's or reseller's owner or admin does the same under `/account/products/{productId}/dashboard-domain`. A client's storefront gets its address from the platform admin.

Once an address is `active`, people sign in there with emailed links (GitHub and Google buttons stay on the platform's address, where their callbacks are registered). Sign-in links and redirects use the address the person is on. Only that storefront's team gets in, and only to that storefront: the dashboard sends the address it was opened on as `X-Dashboard-Host`, and `GET /account` then lists just that storefront's membership (none for anyone else). Any other address the dashboard forwards is treated as the platform's own, so a made-up host never ends up in a sign-in link.

Email to a storefront's team comes in its look too: sign-in links asked for on its own address, and invitations to its team, are sent in its brand's name (its own name when it has an address but no brand name), with a small "Powered by" line for the platform. Invitations are accepted on its own address once that is live. The sending address stays the platform's.

`GET /branding/host/{host}` (public) gives the sign-in page on such an address its look before anyone signs in: `{"productName": "…", "brand": {…} | null}`, or 404 for an address that isn't a live dashboard address.

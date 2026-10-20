# Customer accounts

For whoever runs the API: how to let an agency's people sign in to the dashboard.

A storefront's people can sign in to the dashboard and see their own stores, versions, backups, request log, API keys and webhooks. (The API calls a storefront a **product**.) Each product has one **organization**. Its members reach the API as that product, the same way the product's API key does. Signing in is optional: WaaS Host and any other API client keep using the key and secret, and a product nobody signs in for works exactly as before.

Sign-in runs on [Better Auth](https://www.better-auth.com) inside the API. Its tables live in this database's `auth` schema, and the migrations create them.

## Turning it on

| Variable | Value |
|---|---|
| `AUTH_URL` | the dashboard's address, e.g. `https://app.anypress.io`. People sign in there |
| `AUTH_SECRET` | `openssl rand -base64 32`. Signs session cookies. Changing it signs everyone out |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | a GitHub App or OAuth app with callback `<AUTH_URL>/api/auth/callback/github`. A GitHub App needs the account permission "Email addresses: read" |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | optional: a Google OAuth client with callback `<AUTH_URL>/api/auth/callback/google` |
| `AUTH_MAIL_KEY`, `AUTH_MAIL_FROM` | optional: the toSend API key and sender for emailed sign-in links. Default: the stores' `STORE_SMTP_PASSWORD` and `STORE_MAIL_FROM`, so links work wherever stores already send email |
| `AUTH_BRAND` | the name in sign-in emails (default `AnyPress`) |

Without `AUTH_URL` and `AUTH_SECRET`, sign-in is off: `/api/auth/*` answers 404 and session requests get 403.

People can sign in with GitHub or Google (when their keys are set) or with an emailed link (when a toSend key and sender are known): the dashboard posts the address to `/api/auth/sign-in/magic-link`, the API emails a link that works once for 15 minutes, and opening it signs them in. The link proves the address, so it counts as verified, which accepting an invitation needs. Signing in for the first time this way creates the account; it sees nothing until it joins a storefront's organization.

The dashboard serves Better Auth's routes from its own address by passing `/api/auth/*` through to the API. The session cookie therefore belongs to the dashboard alone, and browsers never send it to the API. When the dashboard's server calls the API for a signed-in person, it passes the cookie on with the header `X-Session-Auth: 1`.

## Roles

| Role | Can |
|---|---|
| `owner` | everything the product's API key can do |
| `admin` | the same as an owner |
| `member` | look only: any `GET`. Every change answers 403 |

## Inviting people

The platform admin starts each organization from the admin API:

```sh
curl -X POST "$API/admin/products/$PRODUCT_ID/invitations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"email": "owner@agency.example", "role": "owner"}'
```

The invitation is emailed to them through toSend when sign-in email is set up (the same key and sender as the sign-in links), and the answer's `emailed` says whether it went. Its `acceptUrl` (`<AUTH_URL>/invite/<id>`) is where the person accepts, after signing in with that same email address; send it yourself when `emailed` is false. The address must be verified, which it is for emailed links, GitHub and Google. Invitations last 7 days, and a new one for the same address replaces the old one.

`GET /admin/products/{id}/organization` lists the members and pending invitations. `PATCH /admin/products/{id}/members/{memberId}` with `{"role": "admin"}` changes someone's role, `DELETE /admin/products/{id}/members/{memberId}` removes someone, and `DELETE /admin/products/{id}/invitations/{invitationId}` cancels an invitation. All are in [openapi/admin/admin-api.yaml](../openapi/admin/admin-api.yaml).

After that the team runs itself from the dashboard's Team page, which calls the same endpoints under `/account` for its own product. Owners and admins invite people (as members unless they choose otherwise), change roles and remove people. Only an owner invites, changes or removes an owner. Nobody removes themselves or changes their own role, and a team always keeps at least one owner.

## Applications to sell

People can also apply for an account themselves. The marketing site's form sends `POST /applications` (no sign-in) with their name, email, business, website, who they sell to, how many sites they expect in their first year, and whether they want a ready-made storefront (with its address). Nothing is made yet: the applicant is emailed that it arrived, and the addresses in `APPLICATION_NOTIFY_EMAILS` get an email linking to it on the dashboard (`<AUTH_URL>/applications/<id>`). One application per email address waits at a time, and the API takes 20 an hour from everyone together.

The platform admin reviews them on the dashboard (`GET /admin/applications?status=pending`):

- `POST /admin/applications/{id}/approve` makes the product, named after the business, with 3 stores unless `maxTenants` says otherwise. It invites the applicant as its owner and emails them the link, then builds the ready-made storefront if they asked for one (`storefront` overrides that). If the storefront fails, the approval still stands and `storefrontError` says why. It can be built later from the product's keys page.
- `POST /admin/applications/{id}/decline` emails the applicant that they weren't approved. They may apply again.

## What a signed-in person can call

These calls need the session cookie and `X-Session-Auth: 1`:

- `/v1/*`: the whole provisioning API, as the organization's product.
- `GET /account`: who is signed in, their organizations, and the active one. This works before they belong to any organization.
- `/account/*`: the admin API's endpoints (`/admin/overview` becomes `/account/overview`, and so on), narrowed to the product. Lists hold only that product's records, another product's store, key or webhook answers 404, and the platform-only endpoints (creating products, product limits, plugins, database backups, renaming the organization) answer 404. This is what the dashboard shows a signed-in customer.

## Connecting an AI app as yourself

The MCP server's approve page (`/oauth/authorize`, see [mcp/README.md](../mcp/README.md)) has a **Sign in** button when sign-in is on. It sends the person to the dashboard at `<AUTH_URL>/connect/<id>`, where they sign in, pick one of their storefronts, tick what the app may see and change, and approve. The dashboard's server reads that request with `GET /account/oauth/requests/{id}` and answers it with `POST /account/oauth/requests/{id}` (`{"action": "approve", "productId": "…", "scopes": ["stores:read", "backups:read", "backups:write"]}` or `{"action": "deny"}`), which returns the address to send the browser back to. A request lasts 10 minutes and works once.

The `GET` answer lists the storefronts to pick from, and one entry per area (`stores`, `backups`, `domains`, `email`, `versions`, `site`) with its read and write scope and whether its box starts ticked: every read box, and the write boxes of the areas the app asked to change. Ticking a write box also grants that area's read scope. Someone whose role may only look can only grant read scopes. (An older dashboard's `"allowWrite": true` still works: every read scope, plus the write scopes the app asked for.)

A platform admin can approve for any storefront, without being on its team: the dashboard's server sends the admin token (`Authorization: Bearer <ADMIN_TOKEN>`) with the person's session, so the `GET` lists every storefront (`"asAdmin": true`) and the person may grant what an owner may. Such a grant isn't tied to a team role; it works until it is revoked or the storefront is removed, and can't be refreshed past its first 30 days.

The app's token then acts as that person on that storefront. Its calls are in the request log under their user id, it keeps write access only while their role allows changes, and it stops working once they leave the team.

Changes made through `/account` go into the request log with source `account` and the person's user id. A signed-in person's request log (`GET /account/requests`) is their product's only: its keys' calls, its people's changes, and failed sign-ins with one of its key ids (a wrong or old secret, a revoked key), so an agency can see why its integration is refused. A call that names another product's store shows that store's id but never its name.

Someone who belongs to more than one organization picks one with Better Auth's `POST /api/auth/organization/set-active`. Until then, their requests get 403.

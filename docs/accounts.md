# Customer accounts

A product's people can sign in to the dashboard and see their own stores, versions, backups, request log, API keys and webhooks. Each product has one **organization**. Its members reach the API as that product, the same way the product's API key does. Signing in is optional: WaaS Host and any other API client keep using the key and secret, and a product nobody signs in for works exactly as before.

Sign-in runs on [Better Auth](https://www.better-auth.com) inside the API. Its tables live in this database's `auth` schema, and the migrations create them.

## Turning it on

| Variable | Value |
|---|---|
| `AUTH_URL` | the dashboard's address, e.g. `https://app.anypress.io`. People sign in there |
| `AUTH_SECRET` | `openssl rand -base64 32`. Signs session cookies. Changing it signs everyone out |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | a GitHub App or OAuth app with callback `<AUTH_URL>/api/auth/callback/github`. A GitHub App needs the account permission "Email addresses: read" |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | optional: a Google OAuth client with callback `<AUTH_URL>/api/auth/callback/google` |

Without `AUTH_URL` and `AUTH_SECRET`, sign-in is off: `/api/auth/*` answers 404 and session requests get 403.

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

The answer's `acceptUrl` (`<AUTH_URL>/invite/<id>`) is where the person accepts, after signing in with that same email address. The address must be verified, which it is for GitHub and Google sign-ins. Invitations last 7 days, and a new one for the same address replaces the old one.

`GET /admin/products/{id}/organization` lists the members and pending invitations. `DELETE /admin/products/{id}/members/{memberId}` removes someone, and `DELETE /admin/products/{id}/invitations/{invitationId}` cancels an invitation. All are in [openapi/admin/admin-api.yaml](../openapi/admin/admin-api.yaml).

## What a signed-in person can call

These calls need the session cookie and `X-Session-Auth: 1`:

- `/v1/*`: the whole provisioning API, as the organization's product.
- `GET /account`: who is signed in, their organizations, and the active one. This works before they belong to any organization.
- `/account/*`: the admin API's endpoints (`/admin/overview` becomes `/account/overview`, and so on), narrowed to the product. Lists hold only that product's records, another product's store, key or webhook answers 404, and the platform-only endpoints (creating products, product limits, plugins, database backups, organizations) answer 404. This is what the dashboard shows a signed-in customer.

Changes made through `/account` go into the request log with source `account` and the person's user id.

Someone who belongs to more than one organization picks one with Better Auth's `POST /api/auth/organization/set-active`. Until then, their requests get 403.

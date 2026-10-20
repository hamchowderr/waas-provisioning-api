# Clients

Sometimes the platform admin just wants to give someone a site: a client on a retainer, a friend's
business, a test account. **Add client** on the dashboard's Clients page does it in one step. You give
the client's name and email address and pick a size. That's all.

## What happens

1. **Their own storefront is made**, named after the client, with room for one site. It starts with a
   copy of another storefront's production WordPress version and template. By default that is the
   storefront with the most stores; the API takes `startFrom` to choose another.
2. **The copy builds.** This takes a few minutes. The client shows as *Setting up*.
3. **Their site is made** as soon as the copy is ready. It gets its own address under the stores domain.
4. **The client is emailed an invitation** to their storefront as its owner. They show as *Invited*.
   Once they sign in and accept, they show as *Active* and see only their own site on the dashboard.

If the storefront or the site can't be built, the client shows as *Needs attention* with the reason.

## API

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/admin/clients` | Every client, newest first, with its status |
| `POST` | `/admin/clients` | Adds a client: `{ name, email, size?, startFrom? }` |

Both are for the platform admin only. A client is an ordinary storefront: to give them more sites, raise
its store limit; to invite more people, use its Team page.

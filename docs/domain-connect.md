# Domain Connect

For whoever runs the API. [Domain Connect](https://www.domainconnect.org/) lets a store owner add a store's DNS records with one click: they are sent to their DNS host (Cloudflare, GoDaddy, IONOS, …), approve, and the host adds the records. Without it they copy the records by hand, which still works everywhere.

## The two templates

A DNS host only applies records from a template it has accepted. AnyPress's are in [`domain-connect/`](../domain-connect) (provider id `anypress.io`); if you run your own platform, copy them under your own `PLATFORM_DOMAIN` as the provider id and get them accepted as below. Files are named `<providerId>.<serviceId>.json` as the public [Domain-Connect/Templates](https://github.com/Domain-Connect/Templates) repository requires:

| Template | Records | Variable |
|---|---|---|
| `anypress.io.website` | `A @` → the store server | `ip`: looked up from the stores' wildcard name (`www.<STORES_DOMAIN>`) |
| `anypress.io.email` | DKIM `TXT tosend._domainkey`, `MX send` → toSend's bounce host, SPF on `send` | `dkim`: the sending domain's DKIM key from toSend ([store-email.md](store-email.md)) |

Both are applied to the domain the owner entered: for `shop.example.com` the zone is `example.com` and the host is `shop`. Both pass `dc-template-linter -merge-or-fail` (the templates repository's fast track).

Both set `syncPubKeyDomain`, so a DNS host only applies a link we signed: someone else can't send an owner a link that points their domain at another server.

## How a link is made

`GET /v1/tenants/domain-connect?externalId=…&domainName=…&service=website|email` (storefront, [openapi/store-mail.yaml](../openapi/store-mail.yaml)) and `GET /admin/tenants/{id}/domain-connect?…` (dashboard) return `{ dnsProvider, supported, url }`:

1. Discovery: the `_domainconnect` TXT record of the domain (or its parent) names the DNS host's API; its `/v2/<zone>/settings` gives the consent page and API URLs.
2. Template check: the DNS host answers 200 for `…/domainTemplates/providers/anypress.io/services/<service>` only once it has accepted our template.
3. The apply link carries the zone, host and variable, signed with `DOMAIN_CONNECT_PRIVATE_KEY` (RS256 over the query string, plus `key=<DOMAIN_CONNECT_KEY_HOST>`).

`supported: false` with a `dnsProvider` means the host supports Domain Connect but hasn't accepted our template yet; `dnsProvider: null` means it doesn't support Domain Connect. Either way the caller shows the records to copy. The domain must be the store's own (`website`) or its sending domain (`email`), so a link can't be made for anything else.

## Settings

| Variable | |
|---|---|
| `PLATFORM_DOMAIN` | Turns Domain Connect on; it is the templates' `providerId` (override with `DOMAIN_CONNECT_PROVIDER_ID`). `DOMAIN_CONNECT=off` turns it off. |
| `DOMAIN_CONNECT_PRIVATE_KEY` | PEM RSA private key (or base64 of the PEM) that signs links. Without it links are unsigned, and hosts refuse them because the templates require signatures. |
| `DOMAIN_CONNECT_KEY_HOST` | Where the public key is published under `PLATFORM_DOMAIN`; default `_dck1`. |

Making the key (once):

```sh
openssl genrsa -out dc.pem 2048
openssl rsa -in dc.pem -pubout -outform DER | base64 -w0   # the public key, for DNS
```

The public key goes in TXT records on `_dck1.<PLATFORM_DOMAIN>`, split into pieces of at most 200 characters: `p=1,a=RS256,d=<first part>`, `p=2,a=RS256,d=<second part>`, … The private key goes in `DOMAIN_CONNECT_PRIVATE_KEY` on the API and nowhere else. To rotate, publish the new key under `_dck2`, switch `DOMAIN_CONNECT_KEY_HOST`, then remove `_dck1`.

## Getting DNS hosts to accept the templates

Nothing works until this happens, and it is outside the code:

1. Open a pull request with both files to [Domain-Connect/Templates](https://github.com/Domain-Connect/Templates), with the online editor test links its README asks for. Lint-clean templates are merged on the fast track. Most DNS hosts that support Domain Connect (GoDaddy, IONOS, and others) pick templates up from that repository.
2. Cloudflare onboards each service provider separately: apply through Cloudflare's Domain Connect form with both template names.

# n8n-nodes-anypress

n8n nodes for [AnyPress](https://anypress.io): create a client's WordPress site from a form, a payment or a CRM step, and start a workflow the moment the site is ready.

- **AnyPress**: create, get, suspend, resume and delete sites.
- **AnyPress Trigger**: starts a workflow when a site is ready, fails, is suspended, resumed, deleted, restored or backed up. It registers its own webhook with AnyPress when the workflow is turned on, removes it when the workflow is turned off, and checks the signature on every request.

## Install

In n8n, open **Settings**, **Community nodes**, **Install**, and enter `n8n-nodes-anypress`. See n8n's [community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/) for self-hosted installs.

## Credentials

Add an **AnyPress API** credential:

| Field | What to enter |
|---|---|
| API Key | A key from [app.anypress.io](https://app.anypress.io) under **API keys**, or a partner key for a reseller account |
| API Secret | The secret shown once when the key was made |
| API Address | Leave it as `https://api.anypress.io` |

A storefront's own key works on that storefront. A partner key works on every storefront in a reseller account: pick the storefront on each node.

## Operations

| Operation | What it does |
|---|---|
| Create | Builds a site from your starting site. **Your Reference** (an order or deal number, say) makes a repeat create answer with the site already made, so a retried workflow never builds two. Turn on **Wait Until Ready** to wait for the build, or use the trigger |
| Get | The site, its status and its address, by your reference or its site ID |
| Suspend | Takes the site offline, backing it up first |
| Resume | Brings it back online |
| Delete | Deletes it. Its backups are kept, so it can be restored |

## Trigger

Pick the events to listen for (Site Ready by default). Each item has the event, its id (the same on every retry, so you can drop repeats), the time, and the site with its `url`.

AnyPress only sends to `https://` addresses on the public internet, so the trigger needs an n8n that is reachable from outside, such as n8n Cloud or a self-hosted n8n behind its own domain.

## Help

Step-by-step guides are in the [AnyPress docs](https://shop.anypress.io/docs-category/automation/), and recipes are on [anypress.io/automate](https://anypress.io/automate). Questions: support@anypress.io.

## License

MIT

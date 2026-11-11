# Download my site

Every site's owner can take a full copy of their site with them: WordPress itself, every file under `wp-content` and the whole database, as one zip that restores on any WordPress host. It is not locked to AnyPress in any way.

## Where people find it

| Who | Where |
|---|---|
| The site's administrators | wp-admin, **Tools → Download my site** (AnyPress Client) |
| Sellers and resellers, for their clients' sites | The dashboard, a store's page, **Download site** |
| An app or script | `POST /admin/tenants/{id}/download`, then `GET` the same path until it is Done |

Pressing it starts a new copy. It takes from a few seconds to several minutes, depending on how big the site's uploads are; the site keeps running meanwhile. When it is ready, the button becomes a download link. A second press within 10 minutes of a finished copy, or while one is being made, gives that copy instead of making another.

## What is in the zip

| | |
|---|---|
| `wp-admin/`, `wp-includes/`, `index.php`, `wp-*.php` | WordPress, the same version the site runs |
| `wp-content/` | Themes, plugins, uploads and the site's own must-use plugins |
| `database.sql` | The whole database (a `wp db export`) |
| `wp-config-sample.php` | WordPress's own sample, with the site's table prefix filled in |
| `.htaccess` | WordPress's standard rewrite rules, for Apache hosts |
| `README.txt` | How to put it up on another host, step by step |

Left out on purpose: the site's `wp-config.php` (it holds this server's database login), the server's own must-use plugins and cache drop-ins (they only work on AnyPress servers), and page caches.

To restore it elsewhere: make an empty database, upload the files, import `database.sql`, rename `wp-config-sample.php` to `wp-config.php` and fill in the new database's details. If the site moves to a new address, run `wp search-replace 'https://old-address' 'https://new-address' --all-tables`. The README in the zip says the same with the site's own address filled in.

## Links and how long copies are kept

- A download link works for an hour. Asking for the copy again gives a fresh link.
- Each copy is kept for 7 days, then deleted from storage by the daily maintenance job.
- Nightly backups are separate and unchanged (`docs/store-backups.md`); a download is never used to restore a store.

## API

`GET /admin/tenants/{id}/download` answers `{"download": null}` or the newest copy of the last 7 days:

```json
{
  "download": {
    "id": "3f6d2c1e-8a4b-4f0e-9c7d-5b2a1e0f9d84",
    "statusCode": 1,
    "statusName": "Done",
    "sizeBytes": 184467210,
    "dateCreated": "2026-11-11T07:02:11.204Z",
    "dateDone": "2026-11-11T07:04:40.019Z",
    "expiresAt": "2026-11-18T07:02:11.204Z",
    "fileName": "bakery.example-2026-11-11.zip",
    "url": "https://…"
  }
}
```

`POST` to the same path starts a copy and answers the same shape (statusCode 0, Pending). A copy that fails is Failed; press again to retry. The store itself is never changed.

A store's own AnyPress Client asks at `POST /sites/download` with `{"site": "<its domain>"}` (add `"start": true` to make a copy), signed with the store's site key in `X-AnyPress-Signature`, and gets the same answer.

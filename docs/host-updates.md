# AnyPress Host updates on storefronts

Ready-made storefronts (the stores of the product set in `STOREFRONT_PRODUCT_ID`) don't update AnyPress Host themselves:
WordPress's automatic plugin updates are off on them and their scheduled tasks may not run. The API pushes each
stable release to them instead, so no one has to click Update.

## How it works

Every 15 minutes the API reads the stable channel of the releases bucket (`RELEASES_S3_BUCKET`). For each storefront
that is ready (status Done), hasn't been given that release and whose product has no AnyPress Host pin, it queues a `storefront.update-host` job. The job
has the store's agent:

1. download the release zip and check it against the SHA-256 in its manifest;
2. put the new folder in place, keeping the plugin switched on (an older folder of the plugin from before a rename
   is switched off without running its code, and removed);
3. load WordPress once with every plugin and the theme, which runs the new copy's own upgrade code;
4. if WordPress doesn't load, put back the copy the store had and fail.

A failed push leaves the storefront on the copy it had. The reason is kept with the storefront, the job is listed
with the failed jobs, and the admins get the usual job-failure email. It is not tried again on its own.

Moving, restoring or rolling back a storefront gives it its template's copy again, so the next check pushes the
release once more.

Both settings must be set for any of this to run: `RELEASES_S3_BUCKET` and `STOREFRONT_PRODUCT_ID`.

## Admin API

| Route | What it does |
|---|---|
| `GET /admin/host-updates` | Each storefront's last push: the release, the version it had, `pending`, `done` or `failed`, and why it failed |
| `POST /admin/host-updates` | Runs the check now, and tries the failed storefronts again. Answers the release and how many were queued |

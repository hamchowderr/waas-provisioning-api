# Playground for the demo pages

The dashboard's demo pages (`/demo`) run the AnyPress theme's demo websites on [WordPress Playground](https://wordpress.org/playground/), in the visitor's browser. They embed a copy of Playground served from `demo.anypress.io`. Embedding it from an AnyPress address keeps it working in every browser, which `playground.wordpress.net` no longer does inside another site's page.

- `.github/workflows/playground.yml` builds Playground from its official source at a release tag. It keeps PHP 8.3 and the newest WordPress only (`prune.sh`), and attaches the result to a GitHub release `playground-<tag>`.
- `Dockerfile` serves that release with Caddy. To move to a newer Playground, run the workflow with the new tag, then change `PLAYGROUND` in the Dockerfile.

Playground is free software from the WordPress project, under the GPL.

#!/usr/bin/env bash
# Lists the built Playground site, then removes what the demos never load: every PHP version but 8.3 and every
# WordPress build but the newest stable one. The demo Blueprints ask for PHP 8.3 and "latest" WordPress.
set -euo pipefail
site=$1
echo "Before:"; du -sh "$site"
find "$site" -type f -size +1M -printf '%s\t%P\n' | sort -n | awk -F'\t' '{printf "%8.1f MB  %s\n", $1/1048576, $2}'

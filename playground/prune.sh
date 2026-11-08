#!/usr/bin/env bash
# Removes what the demos never load from the built Playground site: every PHP version but 8.3 (both of its builds,
# one per browser engine), every WordPress build but the newest stable one, source maps and test fixtures. The demo
# Blueprints ask for PHP 8.3 and "latest" WordPress, which this Playground release resolves to its newest stable
# build. Everything else stays, so Playground's own loader finds what it expects.
set -euo pipefail
site=$1
cd "$site"
echo "Before: $(du -sh . | cut -f1)"

# The newest stable WordPress build this release bundles, e.g. 7.1.
wp=$(ls -d wp-[0-9]*.[0-9]* | sed 's/^wp-//' | sort -V | tail -1)
echo "Keeping PHP 8.3 and WordPress $wp"

find assets -maxdepth 1 -name 'php_*.wasm' ! -name 'php_8_3-*' -delete
find assets -maxdepth 1 -name 'wp-*.tar-*.zst' ! -name "wp-$wp.tar-*" -delete
for dir in wp-*/; do
  [ "$dir" = "wp-$wp/" ] || rm -rf "$dir"
done
find . -name '*.map' -delete
rm -rf test-fixtures

test -n "$(ls assets/php_8_3-*.wasm)" && test -d "wp-$wp" && test -f remote.html && test -f index.html
echo "After: $(du -sh . | cut -f1)"

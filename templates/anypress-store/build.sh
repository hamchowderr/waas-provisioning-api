#!/usr/bin/env bash
# Builds the "AnyPress store" base snapshot: WordPress with the WaaS Client plugin, the Fluent suite,
# Rank Math, WP Fusion Lite and AutomatorWP (free wordpress.org versions) and Twenty Twenty-Five,
# packaged as the provisioner restores it (see README).
#
#   templates/anypress-store/build.sh <path to a waas-plugins checkout>
#
# Output: templates/anypress-store/dist/anypress-store.zip (database.sql + wp-content/).
# Needs Docker, curl, unzip, zip and composer. Starts dockerd itself when it isn't running.
set -euo pipefail

# Pinned inputs. Bump these (and the checksums) to rebuild on newer releases.
WP_VERSION=${WP_VERSION:-7.1.3}
WP_SHA256=${WP_SHA256:-eb58a90ed55147f90f7bd55d0d3334960a69b7e8a4cc142c8ddfea8965218227}
# wordpress.org plugins: slug version sha256. All installed and active (roles.json switches them per plan).
PLUGINS="
fluent-cart 1.9.0 0de495740dcdd2e3a2585c2658e5a74c89d98528b24e2c47011294f3cb1b3829
fluent-crm 3.2.6 ae51abf11c083cdab113b19161a9a4a09f47b794b620ec27aa798f066c80b6a4
fluentform 6.2.15 fb689be752ba7d3b18b7cd7ae6d6c6f9d180621c64ef52937501ad19ddae9b80
fluent-booking 2.5.0 1443134ef2f1ae24c17435bab81d6a15ba10136c15095c90e2d07de15f1c0eb0
fluent-support 2.4.5 c695347f5f9df5417971ce2321453079093a48567be8cb61f7427e60f0109399
fluent-affiliate 1.6.5 da885534b9ddfeb24c966ae09191065cbd950195ee3b7238de88ac4c04ab3820
easy-code-manager 10.56 9a5e416defc7392d7eda39c8991dd9af612bbf963ac12dbe2cb4728ab424ed40
seo-by-rank-math 1.0.280 9ae865e3440a96526e6db1d721a7a6f41dca1e46f116630d3bdb9686fa8aa290
wp-fusion-lite 3.48.0 72e480456caff66f25d8b88c63f403c9ba393e4e808d78b81ae48d13cf8976e6
automatorwp 6.0.4 d6fbd08df660df019fd79ce8c7f00612fd571168f763fab8fa38094fec0b7579
fluent-security 3.0.5 304c0c61ef704a16534133211fbd2be820040606b6c0ea6a4d0b28942c697b11
fluent-community 2.12.0 f20ff8b03a7eaf4cfe5aed6a233d07a8b6e3924f7bd978311b6e3d05b44b9861
"
# Plugins that aren't on wordpress.org: slug version sha256, zipped in plugins/<slug>-<version>.zip (GPL, from the vendor).
# FluentToolkit (WPManageNinja's "FluentHub": one dashboard for the Fluent plugins) updates itself from the vendor afterwards.
VENDORED="
fluent-toolkit 2.1.3 e501b6f0abf9bf5db30c4f60b31702b3ffda217de0c85db408ff4ce210f51123
"
THEME=twentytwentyfive
THEME_VERSION=${THEME_VERSION:-1.5}
THEME_SHA256=${THEME_SHA256:-f333ce53aaa4049639298247d03480a4bd9b56fa8f0fea0440da262d7d595ba4}
PHP_VERSION=${PHP_VERSION:-8.3}

# The build site's address. The provisioner rewrites it to each store's domain (wp search-replace),
# so it must be a bare https host without a port.
SITE_URL=https://store.template.invalid
DB_PORT=${DB_PORT:-33061}
CLI_IMAGE=mirror.gcr.io/library/wordpress:cli-php$PHP_VERSION
DB_IMAGE=mirror.gcr.io/library/mariadb:11
DB_CONTAINER=waas-template-db

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGINS_REPO=$(cd "${1:?usage: build.sh <path to a waas-plugins checkout>}" && pwd)
WORK=$HERE/.work
DIST=$HERE/dist
SITE=$WORK/site

fetch() { # url sha256 file
    [ -f "$3" ] && echo "$2  $3" | sha256sum -c --quiet 2>/dev/null && return
    curl -sSfL -o "$3" "$1"
    echo "$2  $3" | sha256sum -c --quiet || { echo "checksum mismatch: $1" >&2; exit 1; }
}

# WP-CLI refuses to run as root; as root, run it as www-data (uid 33, as in the stores) instead. With every plugin
# loaded as an admin (the presets step), WP-CLI needs more than the image's 128 MB.
WP_USER="$(id -u):$(id -g)"
[ "$(id -u)" = 0 ] && WP_USER=33:33
wp() {
    docker run --rm --network host --user "$WP_USER" -e HOME=/tmp \
        -v "$SITE:/var/www/html" "$CLI_IMAGE" php -d memory_limit=512M /usr/local/bin/wp --path=/var/www/html "$@"
}

cleanup() { docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker info >/dev/null 2>&1 || { (dockerd >/tmp/dockerd.log 2>&1 &); for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; }

rm -rf "$SITE" && mkdir -p "$WORK/downloads" "$SITE" "$DIST"
fetch "https://wordpress.org/wordpress-$WP_VERSION.zip" "$WP_SHA256" "$WORK/downloads/wordpress.zip"
while read -r slug version sha; do
    [ -n "$slug" ] || continue
    fetch "https://downloads.wordpress.org/plugin/$slug.$version.zip" "$sha" "$WORK/downloads/$slug.$version.zip"
done <<<"$PLUGINS"
while read -r slug version sha; do
    [ -n "$slug" ] || continue
    echo "$sha  $HERE/plugins/$slug-$version.zip" | sha256sum -c --quiet || { echo "checksum mismatch: plugins/$slug-$version.zip" >&2; exit 1; }
done <<<"$VENDORED"
fetch "https://downloads.wordpress.org/theme/$THEME.$THEME_VERSION.zip" "$THEME_SHA256" "$WORK/downloads/$THEME.zip"

echo "== WordPress $WP_VERSION"
unzip -q "$WORK/downloads/wordpress.zip" -d "$WORK"
cp -a "$WORK/wordpress/." "$SITE/" && rm -rf "$WORK/wordpress"
# Only what the template ships: no bundled plugins, no other themes.
rm -rf "$SITE/wp-content/plugins/akismet" "$SITE/wp-content/plugins/hello.php" "$SITE/wp-content/themes/"*
unzip -q "$WORK/downloads/$THEME.zip" -d "$SITE/wp-content/themes"
while read -r slug version sha; do
    [ -n "$slug" ] || continue
    unzip -q "$WORK/downloads/$slug.$version.zip" -d "$SITE/wp-content/plugins"
done <<<"$PLUGINS"
while read -r slug version sha; do
    [ -n "$slug" ] || continue
    unzip -q "$HERE/plugins/$slug-$version.zip" -d "$SITE/wp-content/plugins"
done <<<"$VENDORED"
SLUGS=$(awk 'NF {print $1}' <<<"$PLUGINS$VENDORED" | sort | tr '\n' ' ')

echo "== WaaS Client from $PLUGINS_REPO"
# Same steps as waas-plugins' scripts/build.sh; the directory must be waas-client (waas-client/index.php).
CLIENT=$SITE/wp-content/plugins/waas-client
cp -a "$PLUGINS_REPO/packages/waas-client" "$CLIENT"
rm -rf "$CLIENT/vendor" "$CLIENT/tests" "$CLIENT/phpunit.xml.dist" "$CLIENT/data"
(cd "$CLIENT" && composer install --no-dev --no-interaction --quiet)
CLIENT_VERSION=$(sed -n 's/^Version: *//p' "$CLIENT/index.php" | head -1)
CLIENT_COMMIT=$(git -C "$PLUGINS_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
# roles.json is what the storefront reads at https://<production version>/wp-content/plugins/waas-client-data/roles.json
# and what the client uses to switch plugins on per role.
mkdir -p "$SITE/wp-content/plugins/waas-client-data"
cp "$HERE/roles.json" "$SITE/wp-content/plugins/waas-client-data/roles.json"
# Template settings kept in code (see mu-plugins/anypress-store.php).
mkdir -p "$SITE/wp-content/mu-plugins"
cp "$HERE/mu-plugins/anypress-store.php" "$SITE/wp-content/mu-plugins/"

[ "$WP_USER" = 33:33 ] && chown -R 33:33 "$SITE"

echo "== Database"
cleanup
DB_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
docker run -d --name "$DB_CONTAINER" --network host -e MARIADB_ROOT_PASSWORD="$DB_PASSWORD" -e MARIADB_DATABASE=wordpress \
    "$DB_IMAGE" --port="$DB_PORT" --bind-address=127.0.0.1 >/dev/null
# The stores' wp-config uses the default table prefix wp_; the dump must match.
wp config create --dbname=wordpress --dbuser=root --dbpass="$DB_PASSWORD" --dbhost="127.0.0.1:$DB_PORT" --dbprefix=wp_ --skip-check --quiet
for _ in $(seq 1 60); do wp db check --quiet >/dev/null 2>&1 && break; sleep 2; done

echo "== Install and configure"
# The same admin the provisioner creates on a fresh install: a random password nobody keeps.
wp core install --url="$SITE_URL" --title="My Store" --admin_user=waas-admin --admin_email=admin@example.invalid \
    --admin_password="$(head -c 24 /dev/urandom | base64)" --skip-email
wp theme activate "$THEME"
# Pretty permalinks before any plugin builds rewrite rules from page links.
wp rewrite structure '/%postname%/'
wp plugin activate waas-client $SLUGS

# Sample content: the post, the page, the privacy policy draft and the comment.
wp post delete $(wp post list --post_type=post,page --post_status=any --format=ids --post_name__in=hello-world,sample-page,privacy-policy) --force
COMMENTS=$(wp comment list --format=ids)
[ -z "$COMMENTS" ] || wp comment delete $COMMENTS --force
wp option update wp_page_for_privacy_policy 0
wp widget reset --all 2>/dev/null || true

# FluentCart's own pages (what its onboarding creates: shop, cart, checkout, receipt, order review,
# account), with the shop as the home page.
wp eval --user=waas-admin '(new \FluentCart\App\CPT\Pages())->createPages();'
wp option update show_on_front page
wp option update page_on_front "$(wp post list --post_type=page --name=shop --field=ID)"

wp option update timezone_string UTC
wp option update gmt_offset 0
wp option update date_format 'F j, Y'
wp option update time_format 'H:i'
# Comments and pingbacks off for new content.
wp option update default_comment_status closed
wp option update default_ping_status closed
wp option update default_pingback_flag 0
# The store owner turns this on at launch.
wp option update blog_public 0
wp option update users_can_register 0

echo "== Presets"
# Settings that are the same for every store (presets.php says what each one is for).
cp "$HERE/presets.php" "$SITE/presets.php"
wp eval-file /var/www/html/presets.php --user=waas-admin
rm "$SITE/presets.php"
wp rewrite flush
wp transient delete --all
wp cache flush 2>/dev/null || true

echo "== Check"
wp plugin list --fields=name,status,version --skip-update-check
wp theme list --fields=name,status,version --skip-update-check
EXPECTED=$(printf '%s\n' $SLUGS waas-client | sort | tr '\n' ' ')
[ "$(wp plugin list --status=active --field=name --skip-update-check | sort | tr '\n' ' ')" = "$EXPECTED" ] || { echo "unexpected active plugins" >&2; exit 1; }
[ "$(wp plugin list --fields=name,status --format=csv --skip-update-check | awk -F, 'NR > 1 && $2 != "must-use" {print $1}' | sort | tr '\n' ' ')" = "$EXPECTED" ] || { echo "unexpected installed plugins" >&2; exit 1; }

# Rank Math's sitemap is only served once its rewrite rules exist. Read the whole list first: grep -q stops at the
# first match, and with pipefail the cut-off wp counts as a failure.
grep -q 'sitemap_index' <<<"$(wp rewrite list --format=csv)" || { echo "Rank Math sitemap rules missing" >&2; exit 1; }
[ "$(wp option get fluent_cart_plugin_once_activated)" = 1 ] || { echo "FluentCart first-activation flag missing" >&2; exit 1; }
[ ! -e "$SITE/wp-content/fluent-snippet-storage" ] || { echo "fluent-snippet-storage must not ship (its secret would be shared)" >&2; exit 1; }

echo "== Package"
rm -rf "$WORK/out" && mkdir -p "$WORK/out"
wp db export /var/www/html/database.sql --add-drop-table --quiet
# The mu-plugin's first-run marker must not ship, or stores would skip their first run.
! grep -q anypress_store_home "$SITE/database.sql" || { echo "anypress_store_home left in the dump" >&2; exit 1; }
mv "$SITE/database.sql" "$WORK/out/database.sql"
cp -a "$SITE/wp-content" "$WORK/out/wp-content"
rm -rf "$WORK/out/wp-content/"{cache,upgrade,upgrade-temp-backup,debug.log}
PLUGINS_JSON=$( (echo "waas-client $CLIENT_VERSION ($CLIENT_COMMIT)"; awk 'NF {print $1, $2}' <<<"$PLUGINS$VENDORED") \
    | jq -Rnc '[inputs | capture("^(?<key>[^ ]+) (?<value>.+)$")] | from_entries')
cat >"$WORK/out/waas-template.json" <<JSON
{
  "name": "AnyPress store",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "wordPress": "$WP_VERSION",
  "php": "$PHP_VERSION",
  "theme": "$THEME $THEME_VERSION",
  "plugins": $PLUGINS_JSON,
  "siteUrl": "$SITE_URL"
}
JSON
rm -f "$DIST/anypress-store.zip"
(cd "$WORK/out" && zip -qr -X "$DIST/anypress-store.zip" database.sql wp-content waas-template.json)
ls -l "$DIST/anypress-store.zip"
sha256sum "$DIST/anypress-store.zip"

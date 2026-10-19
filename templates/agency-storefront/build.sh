#!/usr/bin/env bash
# Builds the "Agency storefront" base snapshot: WordPress with WaaS Host, FluentCart, FluentAuth and
# Twenty Twenty-Five, packaged as the provisioner restores it (see README). A storefront made from it
# is connected to the API when it is created: the API writes its key, secret and address into wp-config
# (POST /admin/products/{productId}/storefront).
#
#   templates/agency-storefront/build.sh <path to a waas-plugins checkout> <WaaS Host version>
#
# The version is stamped into WaaS Host the way a release is (waas-plugins scripts/release/build.sh), so the
# storefront gets later releases from the update channel. Check out the matching tag first.
#
# Output: templates/agency-storefront/dist/agency-storefront.zip (database.sql + wp-content/).
# Needs Docker, curl, unzip, zip and composer. Starts dockerd itself when it isn't running.
set -euo pipefail

# Pinned inputs. Bump these (and the checksums) to rebuild on newer releases.
WP_VERSION=${WP_VERSION:-7.1.3}
WP_SHA256=${WP_SHA256:-eb58a90ed55147f90f7bd55d0d3334960a69b7e8a4cc142c8ddfea8965218227}
# wordpress.org plugins: slug version sha256. All installed and active.
PLUGINS="
fluent-cart 1.9.0 0de495740dcdd2e3a2585c2658e5a74c89d98528b24e2c47011294f3cb1b3829
fluent-security 3.0.5 304c0c61ef704a16534133211fbd2be820040606b6c0ea6a4d0b28942c697b11
"
THEME=twentytwentyfive
THEME_VERSION=${THEME_VERSION:-1.5}
THEME_SHA256=${THEME_SHA256:-f333ce53aaa4049639298247d03480a4bd9b56fa8f0fea0440da262d7d595ba4}
PHP_VERSION=${PHP_VERSION:-8.3}

# The build site's address. The provisioner rewrites it to each storefront's domain (wp search-replace),
# so it must be a bare https host without a port.
SITE_URL=https://storefront.template.invalid
DB_PORT=${DB_PORT:-33062}
CLI_IMAGE=mirror.gcr.io/library/wordpress:cli-php$PHP_VERSION
DB_IMAGE=mirror.gcr.io/library/mariadb:11
DB_CONTAINER=waas-storefront-template-db

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGINS_REPO=$(cd "${1:?usage: build.sh <path to a waas-plugins checkout> <WaaS Host version>}" && pwd)
HOST_VERSION=${2:?usage: build.sh <path to a waas-plugins checkout> <WaaS Host version>}
WORK=$HERE/.work
DIST=$HERE/dist
SITE=$WORK/site

fetch() { # url sha256 file
    [ -f "$3" ] && echo "$2  $3" | sha256sum -c --quiet 2>/dev/null && return
    curl -sSfL -o "$3" "$1"
    echo "$2  $3" | sha256sum -c --quiet || { echo "checksum mismatch: $1" >&2; exit 1; }
}

# WP-CLI refuses to run as root; as root, run it as www-data (uid 33, as in the stores) instead.
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
SLUGS=$(awk 'NF {print $1}' <<<"$PLUGINS" | sort | tr '\n' ' ')

echo "== WaaS Host $HOST_VERSION from $PLUGINS_REPO"
# The release build: production dependencies only, the version stamped, one waas-host/ folder.
"$PLUGINS_REPO/scripts/release/build.sh" waas-host "$HOST_VERSION" "$WORK/downloads" >/dev/null
unzip -q "$WORK/downloads/wpcs-waas-host.zip" -d "$SITE/wp-content/plugins"
HOST_COMMIT=$(git -C "$PLUGINS_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)

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
wp core install --url="$SITE_URL" --title="My Storefront" --admin_user=waas-admin --admin_email=admin@example.invalid \
    --admin_password="$(head -c 24 /dev/urandom | base64)" --skip-email
wp theme activate "$THEME"
# Pretty permalinks before any plugin builds rewrite rules from page links.
wp rewrite structure '/%postname%/'
wp plugin activate waas-host $SLUGS

# Sample content: the post, the page, the privacy policy draft and the comment.
wp post delete $(wp post list --post_type=post,page --post_status=any --format=ids --post_name__in=hello-world,sample-page,privacy-policy) --force
COMMENTS=$(wp comment list --format=ids)
[ -z "$COMMENTS" ] || wp comment delete $COMMENTS --force
wp option update wp_page_for_privacy_policy 0
wp widget reset --all 2>/dev/null || true

# FluentCart's own pages (shop, cart, checkout, receipt, order review, account), with the shop as the home page.
wp eval --user=waas-admin '(new \FluentCart\App\CPT\Pages())->createPages();'
wp option update show_on_front page
wp option update page_on_front "$(wp post list --post_type=page --name=shop --field=ID)"

wp option update timezone_string UTC
wp option update gmt_offset 0
wp option update date_format 'F j, Y'
wp option update time_format 'H:i'
wp option update default_comment_status closed
wp option update default_ping_status closed
wp option update default_pingback_flag 0
# The agency turns this on at launch.
wp option update blog_public 0
wp option update users_can_register 0

echo "== Presets"
cp "$HERE/presets.php" "$SITE/presets.php"
wp eval-file /var/www/html/presets.php --user=waas-admin
rm "$SITE/presets.php"
wp rewrite flush
wp transient delete --all
wp cache flush 2>/dev/null || true

echo "== Check"
wp plugin list --fields=name,status,version --skip-update-check
EXPECTED=$(printf '%s\n' $SLUGS waas-host | sort | tr '\n' ' ')
[ "$(wp plugin list --status=active --field=name --skip-update-check | sort | tr '\n' ' ')" = "$EXPECTED" ] || { echo "unexpected active plugins" >&2; exit 1; }
[ "$(wp plugin list --fields=name,status --format=csv --skip-update-check | awk -F, 'NR > 1 && $2 != "must-use" {print $1}' | sort | tr '\n' ' ')" = "$EXPECTED" ] || { echo "unexpected installed plugins" >&2; exit 1; }
[ "$(wp plugin get waas-host --field=version)" = "$HOST_VERSION" ] || { echo "WaaS Host is not $HOST_VERSION" >&2; exit 1; }
[ "$(wp option get fluent_cart_plugin_once_activated)" = 1 ] || { echo "FluentCart first-activation flag missing" >&2; exit 1; }
# Nothing that connects the storefront may ship: each one gets its own when it is created.
for OPTION in wpcs_credentials_api_key_setting wpcs_credentials_api_secret_setting wpcs_credentials_api_base_url_setting; do
    [ -z "$(wp option get "$OPTION" 2>/dev/null || true)" ] || { echo "$OPTION must not ship" >&2; exit 1; }
done

echo "== Package"
rm -rf "$WORK/out" && mkdir -p "$WORK/out"
wp db export /var/www/html/database.sql --add-drop-table --quiet
mv "$SITE/database.sql" "$WORK/out/database.sql"
cp -a "$SITE/wp-content" "$WORK/out/wp-content"
rm -rf "$WORK/out/wp-content/"{cache,upgrade,upgrade-temp-backup,debug.log}
PLUGINS_JSON=$( (echo "waas-host $HOST_VERSION ($HOST_COMMIT)"; awk 'NF {print $1, $2}' <<<"$PLUGINS") \
    | jq -Rnc '[inputs | capture("^(?<key>[^ ]+) (?<value>.+)$")] | from_entries')
cat >"$WORK/out/waas-template.json" <<JSON
{
  "name": "Agency storefront",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "wordPress": "$WP_VERSION",
  "php": "$PHP_VERSION",
  "theme": "$THEME $THEME_VERSION",
  "plugins": $PLUGINS_JSON,
  "siteUrl": "$SITE_URL"
}
JSON
rm -f "$DIST/agency-storefront.zip"
(cd "$WORK/out" && zip -qr -X "$DIST/agency-storefront.zip" database.sql wp-content waas-template.json)
ls -l "$DIST/agency-storefront.zip"
sha256sum "$DIST/agency-storefront.zip"

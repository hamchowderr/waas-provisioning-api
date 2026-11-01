#!/usr/bin/env bash
# Builds the "AnyPress store" base snapshot: WordPress with the WaaS Client plugin, the Fluent suite,
# Rank Math, WP Fusion Lite and AutomatorWP (free wordpress.org versions) and the AnyPress block theme (a pinned release, theme.sh),
# packaged as the provisioner restores it (see README).
#
#   templates/anypress-store/build.sh <path to a waas-plugins checkout>
#
# Output: templates/anypress-store/dist/anypress-store.zip (database.sql + wp-content/).
# Needs Docker, curl, unzip, zip and composer. Starts dockerd itself when it isn't running.
set -euo pipefail

# Pinned inputs. Bump these (and the checksums) to rebuild on newer releases.
WP_VERSION=${WP_VERSION:-7.1.4}
WP_SHA256=${WP_SHA256:-a147146c159362778ecbbbfb07bb20ddf4e85b130f971c824e656a8f938c5f87}
# wordpress.org plugins: slug version sha256. All installed and active (roles.json switches them per plan).
PLUGINS="
fluent-cart 2.2.0 c065fc837bacbd2ba5999d0967c8f5405e86abe6a0d2cb12f57fa80842bd699e
fluent-crm 3.3.1 3559061805e780c60b5078917b702786f829a8e49e15f0edfc7288d55fc1f63e
fluentform 6.2.16 9ec4fce3857a0c069dcb392f6e0e9bd1a5a1231d94a49a76d9768a40e973a7fd
fluent-booking 2.5.0 1443134ef2f1ae24c17435bab81d6a15ba10136c15095c90e2d07de15f1c0eb0
fluent-support 2.4.7 606b04ca47e8dfddcd241136953ed426fa7e60dcad03b3b1504285fda7be3e10
fluent-affiliate 1.7.0 f1c617715aaae58657b155c75752adab2db42dd1a8a896469823a19a3b3ee8c8
easy-code-manager 10.58 39bfd2fe29b099147949086c42dfe715cedd4ddce3631c9ef33165470ed25667
seo-by-rank-math 1.0.280 9ae865e3440a96526e6db1d721a7a6f41dca1e46f116630d3bdb9686fa8aa290
wp-fusion-lite 3.48.0 72e480456caff66f25d8b88c63f403c9ba393e4e808d78b81ae48d13cf8976e6
automatorwp 6.0.5 541d640bdf4b6f602123e0f1f26a5041f950a13d338f08ca0b665a9a1617144b
fluent-security 3.1.0 8507006b0506f34546a7227823cb77d8d06ab911aaf068b75736984a1e03bf0e
fluent-community 2.12.0 f20ff8b03a7eaf4cfe5aed6a233d07a8b6e3924f7bd978311b6e3d05b44b9861
"
# wordpress.org plugins installed but left off: slug version sha256. The store owner turns them on (WordPress's
# MCP Adapter: Dashboard > Your plan > AI apps, WaaS Client 2.4.0+); not in roles.json.
OFF_PLUGINS="
mcp-adapter 0.7.1 719d81aa1250615acfd8256f0acc8c13f1712f1ae398c3d5883c8b166024fe9b
"
# Plugins that aren't on wordpress.org: slug version sha256, zipped in plugins/<slug>-<version>.zip (GPL, from the vendor).
# FluentToolkit (WPManageNinja's "FluentHub": one dashboard for the Fluent plugins) updates itself from the vendor afterwards.
VENDORED="
fluent-toolkit 2.1.4 2441af4234fa809022962dca0032a7f7fb3d5d1bb79d185ec9f2b1577fad2c6a
"
# Vendored plugins installed but left off. The FluentCart Migrator add-on (FluentCart's own WooCommerce importer, from
# addons-cdn.fluentcart.com) is only for WaaS Client's shop switch, which turns it on when it runs.
OFF_VENDORED="
fluent-cart-migrator 1.1.0-beta 69de5e9033dfad69ccbf4a7c4ece96d5e28f1fc23bb4a2904fea1db653b560ff
"
# AnyPress Blocks (the Popup block and more): a release of github.com/hamchowderr/anypress-blocks, pinned by version
# and checksum (from the release's SHA256SUMS). Active on every site type (roles.json).
BLOCKS_VERSION=${BLOCKS_VERSION:-0.3.0}
BLOCKS_SHA256=${BLOCKS_SHA256:-79721b6151064d97ceb66636a1d9d29470803c18d4377d50cfe47b7e30399c28}
# The AnyPress block theme: a release of github.com/hamchowderr/anypress-theme, pinned in theme.sh.
THEME=anypress
# shellcheck source=theme.sh
. "$(dirname "$0")/theme.sh"
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
done <<<"$PLUGINS$OFF_PLUGINS"
anypress_theme_fetch "$WORK/downloads"
fetch "https://github.com/hamchowderr/anypress-blocks/releases/download/v$BLOCKS_VERSION/anypress-blocks.zip" "$BLOCKS_SHA256" "$WORK/downloads/anypress-blocks.$BLOCKS_VERSION.zip"
while read -r slug version sha; do
    [ -n "$slug" ] || continue
    echo "$sha  $HERE/plugins/$slug-$version.zip" | sha256sum -c --quiet || { echo "checksum mismatch: plugins/$slug-$version.zip" >&2; exit 1; }
done <<<"$VENDORED$OFF_VENDORED"

echo "== WordPress $WP_VERSION"
unzip -q "$WORK/downloads/wordpress.zip" -d "$WORK"
cp -a "$WORK/wordpress/." "$SITE/" && rm -rf "$WORK/wordpress"
# Only what the template ships: no bundled plugins, no other themes.
rm -rf "$SITE/wp-content/plugins/akismet" "$SITE/wp-content/plugins/hello.php" "$SITE/wp-content/themes/"*
cp -a "$WORK/downloads/anypress" "$SITE/wp-content/themes/$THEME"
while read -r slug version sha; do
    [ -n "$slug" ] || continue
    unzip -q "$WORK/downloads/$slug.$version.zip" -d "$SITE/wp-content/plugins"
done <<<"$PLUGINS$OFF_PLUGINS"
while read -r slug version sha; do
    [ -n "$slug" ] || continue
    unzip -q "$HERE/plugins/$slug-$version.zip" -d "$SITE/wp-content/plugins"
done <<<"$VENDORED$OFF_VENDORED"
unzip -q "$WORK/downloads/anypress-blocks.$BLOCKS_VERSION.zip" -d "$SITE/wp-content/plugins"
SLUGS=$( (awk 'NF {print $1}' <<<"$PLUGINS$VENDORED"; echo anypress-blocks) | sort | tr '\n' ' ')
OFF_SLUGS=$(awk 'NF {print $1}' <<<"$OFF_PLUGINS$OFF_VENDORED" | sort | tr '\n' ' ')

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
cp "$HERE/mu-plugins/anypress-store.php" "$HERE/mu-plugins/anypress-patterns.php" "$HERE/mu-plugins/anypress-crm-lifecycle.php" "$SITE/wp-content/mu-plugins/"

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
# Site types without FluentCart hide these pages and show posts on the home page (mu-plugins/anypress-store.php).
for PAGE in $(wp post list --post_type=page --format=ids); do wp post meta update "$PAGE" _anypress_needs fluent-cart/fluent-cart.php --quiet; done

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
# The CRM: lifecycle fields, the contact form's questions, abandoned checkouts, the win-back coupon and the draft
# automations (crm/setup.php; the tags themselves come from mu-plugins/anypress-crm-lifecycle.php).
mkdir -p "$SITE/crm" && cp "$HERE/crm/setup.php" "$HERE/crm/emails.json" "$SITE/crm/"
wp eval-file /var/www/html/crm/setup.php --user=waas-admin
rm -r "$SITE/crm"
wp rewrite flush
wp transient delete --all
wp cache flush 2>/dev/null || true

echo "== Check"
# Starter pages (mu-plugins/anypress-patterns.php) and the theme's AnyPress Blocks register.
[ "$(wp eval 'anypress_register_patterns(); $r = WP_Block_Patterns_Registry::get_instance(); echo $r->is_registered("anypress/home-website") && $r->is_registered("anypress/hero-statement") ? "ok" : "missing";')" = ok ] || { echo "starter pages or theme sections missing"; exit 1; }
[ "$(wp theme list --status=active --field=name)" = "$THEME" ] || { echo "theme $THEME not active" >&2; exit 1; }
wp plugin list --fields=name,status,version --skip-update-check
wp theme list --fields=name,status,version --skip-update-check
EXPECTED=$(printf '%s\n' $SLUGS waas-client | sort | tr '\n' ' ')
[ "$(wp plugin list --status=active --field=name --skip-update-check | sort | tr '\n' ' ')" = "$EXPECTED" ] || { echo "unexpected active plugins" >&2; exit 1; }
INSTALLED=$(printf '%s\n' $SLUGS $OFF_SLUGS waas-client | sort | tr '\n' ' ')
[ "$(wp plugin list --fields=name,status --format=csv --skip-update-check | awk -F, 'NR > 1 && $2 != "must-use" {print $1}' | sort | tr '\n' ' ')" = "$INSTALLED" ] || { echo "unexpected installed plugins" >&2; exit 1; }

# Rank Math's sitemap is only served once its rewrite rules exist. Read the whole list first: grep -q stops at the
# first match, and with pipefail the cut-off wp counts as a failure.
grep -q 'sitemap_index' <<<"$(wp rewrite list --format=csv)" || { echo "Rank Math sitemap rules missing" >&2; exit 1; }
# Synced patterns (presets.php): the notice band, and the call to action and quote with pattern overrides.
[ "$(wp post list --post_type=wp_block --format=count)" = 3 ] || { echo "synced patterns missing" >&2; exit 1; }
[ "$(wp eval '$p = get_posts(["post_type" => "wp_block", "title" => "Call to action"]); $b = $p ? parse_blocks($p[0]->post_content) : []; echo $p && str_contains($p[0]->post_content, "core/pattern-overrides") && $b && $b[0]["blockName"] === "core/group" ? "ok" : "bad";')" = ok ] || { echo "call to action pattern has no overrides" >&2; exit 1; }
[ "$(wp post list --post_type=page --meta_key=_anypress_needs --format=count)" -ge 7 ] || { echo "pages missing their site-type marker" >&2; exit 1; }
# The CRM (crm/setup.php): every automation a draft, the contact form's questions, abandoned checkouts and the coupon.
[ "$(wp eval 'echo \FluentCrm\App\Models\Funnel::where("status", "draft")->count(), " ", \FluentCrm\App\Models\Funnel::where("status", "published")->count();')" = "$(jq length "$HERE/crm/emails.json") 0" ] || { echo "CRM automations missing or published" >&2; exit 1; }
[ "$(wp eval 'echo \FluentCrm\App\Models\Tag::whereIn("title", ["Customer", "Lead", "Subscriber"])->count(), " ", \FluentCrm\App\Models\Lists::count();')" = "0 1" ] || { echo "old CRM tags or lists left" >&2; exit 1; }
[ "$(wp eval '$f = wpFluent()->table("fluentform_forms")->find((int) get_option("anypress_crm_contact_form")); echo $f && str_contains($f->form_fields, "\"customer_group\"") && str_contains($f->form_fields, "\"newsletter\"") ? "ok" : "bad";')" = ok ] || { echo "contact form questions missing" >&2; exit 1; }
[ "$(wp eval '$c = get_option("_fc_ab_cart_settings"); echo ($c["enabled"] ?? "") === "yes" && \FluentCart\App\Models\Coupon::where("code", "COMEBACK20")->exists() ? "ok" : "bad";')" = ok ] || { echo "abandoned checkout or coupon missing" >&2; exit 1; }
[ "$(wp option get fluent_cart_plugin_once_activated)" = 1 ] || { echo "FluentCart first-activation flag missing" >&2; exit 1; }
[ ! -e "$SITE/wp-content/fluent-snippet-storage" ] || { echo "fluent-snippet-storage must not ship (its secret would be shared)" >&2; exit 1; }

echo "== Package"
rm -rf "$WORK/out" && mkdir -p "$WORK/out"
wp db export /var/www/html/database.sql --add-drop-table --quiet
# The mu-plugin's first-run marker must not ship, or stores would skip their first run.
for MARKER in anypress_store_home anypress_site_type_plugins anypress_owner_applied; do
    ! grep -q "$MARKER" "$SITE/database.sql" || { echo "$MARKER left in the dump" >&2; exit 1; }
done
mv "$SITE/database.sql" "$WORK/out/database.sql"
cp -a "$SITE/wp-content" "$WORK/out/wp-content"
rm -rf "$WORK/out/wp-content/"{cache,upgrade,upgrade-temp-backup,debug.log}
PLUGINS_JSON=$( (echo "waas-client $CLIENT_VERSION ($CLIENT_COMMIT)"; awk 'NF {print $1, $2}' <<<"$PLUGINS$VENDORED"; awk 'NF {print $1, $2 " (off)"}' <<<"$OFF_PLUGINS$OFF_VENDORED"; echo "anypress-blocks $BLOCKS_VERSION") \
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

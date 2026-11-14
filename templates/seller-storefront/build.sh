#!/usr/bin/env bash
# Builds the "Seller storefront" base snapshot: WordPress with AnyPress Host, FluentCart, FluentCRM, Fluent Forms, FluentAuth,
# FluentKit, WP Fusion Lite, AnyPress Blocks and the AnyPress theme, packaged as the provisioner restores it (see README). A storefront made from it
# is connected to the API when it is created: the API writes its key, secret and address into wp-config
# (POST /admin/products/{productId}/storefront).
#
#   templates/seller-storefront/build.sh <path to a waas-plugins checkout> <AnyPress Host version>
#
# The version is stamped into AnyPress Host the way a release is (waas-plugins scripts/release/build.sh), so the
# storefront gets later releases from the update channel. Check out the matching tag first.
#
# Output: templates/seller-storefront/dist/seller-storefront.zip (database.sql + wp-content/).
# The shop's design comes from the same checkout (scripts/test-storefront/remote/design, the shop.anypress.io design) with
# this template's brand.json; the plans' prices from this repository's price list (src/pricing.ts).
# Needs Docker, curl, unzip, zip, composer and Node 22.18 or later. Starts dockerd itself when it isn't running.
set -euo pipefail

# Pinned inputs. Bump these (and the checksums) to rebuild on newer releases.
WP_VERSION=${WP_VERSION:-7.1.4}
WP_SHA256=${WP_SHA256:-a147146c159362778ecbbbfb07bb20ddf4e85b130f971c824e656a8f938c5f87}
# wordpress.org plugins: slug version sha256. All installed and active.
PLUGINS="
fluent-cart 2.3.1 dcd1af4986129b61e933bd07d9d71ca04087bbf0a7e947421a2ed065cc9f98c1
fluent-crm 3.3.1 3559061805e780c60b5078917b702786f829a8e49e15f0edfc7288d55fc1f63e
fluentform 6.2.17 e5dda0290afa0232758017ce63c63c76a57c6f000a0861eb43772a88a39909bc
wp-fusion-lite 3.48.2 a4b9a90be710e3d5ffac86a472136d71b1a292d121b6698741d4b19ea5b030d7
fluent-security 3.1.1 e3e21bf941617de72628d0d254435cb87fdf6629ce3e00d847ad627d975c38d8
fluent-booking 2.6.0 83eb315ddb562532ca38a362abae4bc787bd83c3d549e1736739ccb525ddcc34
fluent-support 2.5.0 a9525ca9fdc5e6de34a37b3075db01cd7249818f76e93464d7aec44ac5f04899
fluent-affiliate 1.7.0 f1c617715aaae58657b155c75752adab2db42dd1a8a896469823a19a3b3ee8c8
easy-code-manager 10.58 39bfd2fe29b099147949086c42dfe715cedd4ddce3631c9ef33165470ed25667
betterdocs 4.9.6 36a3e54255eceba29c8ac283e489a91a4f8fb7ad6d992b0bedab974bb9229134
mcp-adapter 0.7.1 719d81aa1250615acfd8256f0acc8c13f1712f1ae398c3d5883c8b166024fe9b
"
# Plugins that aren't on wordpress.org: slug version sha256, the zip shared with the store template
# (../anypress-store/plugins/<slug>-<version>.zip). FluentKit puts the Fluent plugins and AnyPress in one dashboard.
VENDORED="
fluent-toolkit 2.1.4 2441af4234fa809022962dca0032a7f7fb3d5d1bb79d185ec9f2b1577fad2c6a
"
# AnyPress Blocks and the AnyPress theme: the same releases the store template pins (its build.sh and theme.sh).
BLOCKS_VERSION=${BLOCKS_VERSION:-0.4.3}
BLOCKS_SHA256=${BLOCKS_SHA256:-b5c77f49f37908bc545b79db247860330bdc40b5e2211a94ad66d7d2c22915e1}
THEME=anypress
# shellcheck source=../anypress-store/theme.sh
. "$(dirname "$0")/../anypress-store/theme.sh"
PHP_VERSION=${PHP_VERSION:-8.3}

# The build site's address. The provisioner rewrites it to each storefront's domain (wp search-replace),
# so it must be a bare https host without a port.
SITE_URL=https://storefront.template.invalid
DB_PORT=${DB_PORT:-33062}
CLI_IMAGE=mirror.gcr.io/library/wordpress:cli-php$PHP_VERSION
DB_IMAGE=mirror.gcr.io/library/mariadb:11
DB_CONTAINER=waas-storefront-template-db

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGINS_REPO=$(cd "${1:?usage: build.sh <path to a waas-plugins checkout> <AnyPress Host version>}" && pwd)
HOST_VERSION=${2:?usage: build.sh <path to a waas-plugins checkout> <AnyPress Host version>}
WORK=$HERE/.work
DIST=$HERE/dist
SITE=$WORK/site

fetch() { # url sha256 file
    [ -f "$3" ] && echo "$2  $3" | sha256sum -c --quiet 2>/dev/null && return
    anypress_download "$1" "$3"
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
anypress_theme_fetch "$WORK/downloads"
fetch "https://github.com/hamchowderr/anypress-blocks/releases/download/v$BLOCKS_VERSION/anypress-blocks.zip" "$BLOCKS_SHA256" "$WORK/downloads/anypress-blocks.$BLOCKS_VERSION.zip"

echo "== WordPress $WP_VERSION"
unzip -q "$WORK/downloads/wordpress.zip" -d "$WORK"
cp -a "$WORK/wordpress/." "$SITE/" && rm -rf "$WORK/wordpress"
# Only what the template ships: no bundled plugins, no other themes.
rm -rf "$SITE/wp-content/plugins/akismet" "$SITE/wp-content/plugins/hello.php" "$SITE/wp-content/themes/"*
cp -a "$WORK/downloads/anypress" "$SITE/wp-content/themes/$THEME"
while read -r slug version sha; do
    [ -n "$slug" ] || continue
    unzip -q "$WORK/downloads/$slug.$version.zip" -d "$SITE/wp-content/plugins"
done <<<"$PLUGINS"
while read -r slug version sha; do
    [ -n "$slug" ] || continue
    ZIP=$HERE/../anypress-store/plugins/$slug-$version.zip
    echo "$sha  $ZIP" | sha256sum -c --quiet || { echo "checksum mismatch: $ZIP" >&2; exit 1; }
    unzip -q "$ZIP" -d "$SITE/wp-content/plugins"
done <<<"$VENDORED"
unzip -q "$WORK/downloads/anypress-blocks.$BLOCKS_VERSION.zip" -d "$SITE/wp-content/plugins"
SLUGS=$( (awk 'NF {print $1}' <<<"$PLUGINS$VENDORED"; echo anypress-blocks) | sort | tr '\n' ' ')
# Settings kept in code (WP Fusion out of staging mode, the owner's details): mu-plugins/seller-storefront.php. The CRM
# lifecycle (Website: Interested / Active / Past, the lifecycle emails, the weekly numbers) is the store template's plugin.
mkdir -p "$SITE/wp-content/mu-plugins"
cp "$HERE/mu-plugins/seller-storefront.php" "$HERE/mu-plugins/seller-storefront-admin.php" "$HERE/../anypress-store/mu-plugins/anypress-crm-lifecycle.php" "$SITE/wp-content/mu-plugins/"
# The shop design's block styles and plan page shortcodes, which its pages use.
DESIGN=$PLUGINS_REPO/scripts/test-storefront/remote/design
cp "$DESIGN/anypress-shop.php" "$SITE/wp-content/mu-plugins/"

echo "== AnyPress Host $HOST_VERSION from $PLUGINS_REPO"
# The release build: production dependencies only, the version stamped, one anypress-host/ folder.
"$PLUGINS_REPO/scripts/release/build.sh" anypress-host "$HOST_VERSION" "$WORK/downloads" >/dev/null
unzip -q "$WORK/downloads/anypress-host.zip" -d "$SITE/wp-content/plugins"
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
wp plugin activate anypress-host $SLUGS

# Sample content: the post, the page, the privacy policy draft and the comment.
wp post delete $(wp post list --post_type=post,page --post_status=any --format=ids --post_name__in=hello-world,sample-page,privacy-policy) --force
COMMENTS=$(wp comment list --format=ids)
[ -z "$COMMENTS" ] || wp comment delete $COMMENTS --force
wp option update wp_page_for_privacy_policy 0
wp widget reset --all 2>/dev/null || true

# FluentCart's own pages (shop, cart, checkout, receipt, order review, account), with the shop as the home page
# until the presets make Home.
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
# The seller turns this on at launch.
wp option update blog_public 0
wp option update users_can_register 0

echo "== Presets"
cp "$HERE/presets.php" "$SITE/presets.php"
cp "$HERE/../anypress-store/mu-plugins/anypress-patterns.php" "$SITE/anypress-patterns.php"
wp eval-file /var/www/html/presets.php --user=waas-admin
rm "$SITE/presets.php" "$SITE/anypress-patterns.php"
# The CRM, as on stores (../anypress-store/crm/setup.php) with this template's emails (crm-emails.json).
mkdir -p "$SITE/crm" && cp "$HERE/../anypress-store/crm/setup.php" "$SITE/crm/" && cp "$HERE/crm-emails.json" "$SITE/crm/emails.json"
wp eval-file /var/www/html/crm/setup.php --user=waas-admin
rm -r "$SITE/crm"
# A storefront opens with its automations on: nothing for the seller to switch on. The store template leaves them as drafts.
wp eval '\FluentCrm\App\Models\Funnel::query()->update(["status" => "published"]);' 

echo "== Shop"
# The plans at the price list's prices, the shop design in this template's words (brand.json) and the pages around it
# (shop.php says what it makes).
mkdir -p "$SITE/shop"
cp -R "$DESIGN" "$SITE/shop/design"
cp "$HERE/shop.php" "$HERE/pages.php" "$HERE/brand.json" "$HERE/audiences.json" "$HERE/help.json" "$HERE/../anypress-store/roles.json" "$HERE/../anypress-store/mu-plugins/anypress-patterns.php" "$SITE/shop/"
node --input-type=module -e 'const { PRICE_LIST } = await import(process.argv[1]); console.log(JSON.stringify(PRICE_LIST));' \
    "$HERE/../../src/pricing.ts" >"$SITE/shop/pricing.json"
[ "$WP_USER" = 33:33 ] && chown -R 33:33 "$SITE/shop"
wp eval-file /var/www/html/shop/shop.php --user=waas-admin
# What the storefront needs to remake its pages for the seller's site types and customers on its first visit
# (pages.php, run by mu-plugins/seller-storefront.php), kept out of reach of the web.
KIT="$SITE/wp-content/anypress-storefront"
mkdir -p "$KIT"
mv "$SITE/shop/pages.php" "$SITE/shop/brand.json" "$SITE/shop/audiences.json" "$SITE/shop/anypress-patterns.php" "$SITE/shop/design" "$KIT/"
printf 'Require all denied\n' >"$KIT/.htaccess"
printf '<?php\n// Silence is golden.\n' >"$KIT/index.php"
[ "$WP_USER" = 33:33 ] && chown -R 33:33 "$KIT"
rm -r "$SITE/shop"
wp rewrite flush
wp transient delete --all
wp cache flush 2>/dev/null || true

echo "== Check"
wp plugin list --fields=name,status,version --skip-update-check
EXPECTED=$(printf '%s\n' $SLUGS anypress-host | sort | tr '\n' ' ')
[ "$(wp plugin list --status=active --field=name --skip-update-check | sort | tr '\n' ' ')" = "$EXPECTED" ] || { echo "unexpected active plugins" >&2; exit 1; }
[ "$(wp plugin list --fields=name,status --format=csv --skip-update-check | awk -F, 'NR > 1 && $2 != "must-use" {print $1}' | sort | tr '\n' ' ')" = "$EXPECTED" ] || { echo "unexpected installed plugins" >&2; exit 1; }
[ "$(wp plugin get anypress-host --field=version)" = "$HOST_VERSION" ] || { echo "AnyPress Host is not $HOST_VERSION" >&2; exit 1; }
[ "$(wp option get fluent_cart_plugin_once_activated)" = 1 ] || { echo "FluentCart first-activation flag missing" >&2; exit 1; }
[ "$(wp post get "$(wp option get page_on_front)" --field=post_name)" = home ] || { echo "Home is not the front page" >&2; exit 1; }
[ "$(wp theme list --status=active --field=name)" = "$THEME" ] || { echo "theme $THEME not active" >&2; exit 1; }
[ "$(wp eval 'echo implode(",", \FluentCrm\App\Models\Tag::orderBy("title")->pluck("title")->toArray());')" = "Website: Active,Website: Interested,Website: Past" ] || { echo "FluentCRM tags missing" >&2; exit 1; }
[ "$(wp eval 'echo \FluentCrm\App\Models\Funnel::where("status", "draft")->count(), " ", \FluentCrm\App\Models\Funnel::where("status", "published")->count();')" = "0 $(jq length "$HERE/crm-emails.json")" ] || { echo "CRM automations missing or not published" >&2; exit 1; }
[ "$(wp eval '$f = wpFluent()->table("fluentform_forms")->find((int) get_option("anypress_crm_contact_form")); echo $f && str_contains($f->form_fields, "\"customer_group\"") ? "ok" : "bad";')" = ok ] || { echo "contact form questions missing" >&2; exit 1; }
[ "$(wp eval '$c = get_option("_fc_ab_cart_settings"); echo ($c["enabled"] ?? "") === "yes" && \FluentCart\App\Models\Coupon::where("code", "COMEBACK20")->exists() ? "ok" : "bad";')" = ok ] || { echo "abandoned checkout or coupon missing" >&2; exit 1; }
[ "$(wp post list --post_type=page --post_status=publish --post_name__in=home,about,questions,contact,plans,terms,privacy,refund-policy,support,affiliates,book-a-call,website-care --format=count)" = 12 ] || { echo "storefront pages missing" >&2; exit 1; }
# Every site type in three sizes, published, at the price list's prices.
[ "$(wp post list --post_type=fluent-products --post_status=publish --format=count)" = 24 ] || { echo "the 15 plans, 2 packs and 7 care products are missing" >&2; exit 1; }
EXPECTED_PRICE=$(jq '.siteTypes[] | select(.key == "community") | .monthly.small * 100' <(node --input-type=module -e 'const { PRICE_LIST } = await import(process.argv[1]); console.log(JSON.stringify(PRICE_LIST));' "$HERE/../../src/pricing.ts"))
[ "$(wp eval 'echo (int) \FluentCart\App\Models\ProductVariation::where("post_id", get_page_by_path("community-small", OBJECT, "fluent-products")->ID)->min("item_price");')" = "$EXPECTED_PRICE" ] || { echo "plan prices don't match src/pricing.ts" >&2; exit 1; }
[ "$(wp option get anypress_shop_brand --format=json | jq -r .whiteLabel)" = true ] || { echo "the shop design isn't in the storefront's own name" >&2; exit 1; }
[ "$(wp eval 'global $wpdb; echo (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_status = \"publish\" AND (post_content LIKE \"%support@anypress.io%\" OR post_content LIKE \"%anypress.site%\" OR post_content LIKE \"%Otaku%\")");')" = 0 ] || { echo "AnyPress's own name or address on a storefront page" >&2; exit 1; }
PRICES=$(node --input-type=module -e 'const { PRICE_LIST } = await import(process.argv[1]); console.log(JSON.stringify(PRICE_LIST));' "$HERE/../../src/pricing.ts")
# Help, support, referrals and a call, as on AnyPress's own shop.
[ "$(wp post list --post_type=docs --post_status=publish --format=count)" = "$(jq '.articles | length' "$HERE/help.json")" ] || { echo "help pages missing" >&2; exit 1; }
[ "$(wp eval 'echo (int) (new \FluentSupport\App\Services\EmailNotification\Settings())->globalBusinessSettings(false)["portal_page_id"] === get_page_by_path("support")->ID ? "ok" : "bad";')" = ok ] || { echo "Support page isn't Fluent Support's portal" >&2; exit 1; }
[ "$(wp eval 'echo (int) \FluentAffiliate\App\Helper\Utility::getReferralSetting("dashboard_page_id") === get_page_by_path("affiliates")->ID ? "ok" : "bad";')" = ok ] || { echo "Referrals page isn't FluentAffiliate's dashboard" >&2; exit 1; }
[ "$(wp eval 'echo \FluentBooking\App\Models\CalendarSlot::where("status", "active")->count();')" = 1 ] || { echo "Book a call event missing" >&2; exit 1; }
# The packs, at the price list's prices, and the free trial on every plan.
[ "$(wp eval 'echo (int) \FluentCart\App\Models\ProductVariation::where("post_id", get_page_by_path("email-pack-10000", OBJECT, "fluent-products")->ID)->value("item_price"), " ", (int) \FluentCart\App\Models\ProductVariation::where("post_id", get_page_by_path("25-gb-more-storage", OBJECT, "fluent-products")->ID)->value("item_price");')" = "$(jq -r '"\(.packs.email.price * 100) \(.packs.storage.monthly * 100)"' <<<"$PRICES")" ] || { echo "packs missing or not at the price list's prices" >&2; exit 1; }
[ "$(wp eval '$v = \FluentCart\App\Models\ProductVariation::where("post_id", get_page_by_path("website-small", OBJECT, "fluent-products")->ID)->first(); echo (int) $v->other_info["trial_days"];')" = "$(jq .trialDays <<<"$PRICES")" ] || { echo "plans have no free trial" >&2; exit 1; }
[ "$(wp option get anypress_domains_enabled) $(wp option get anypress_volume_discount_enabled)" = "on on" ] || { echo "domains or volume saving off" >&2; exit 1; }
HUB=$(wp post list --post_type=page --name=who-we-help --field=ID)
[ -n "$HUB" ] && [ "$(wp post list --post_type=page --post_status=publish --post_parent="$HUB" --format=count)" = 8 ] || { echo "Who we help pages missing" >&2; exit 1; }
[ "$(wp eval 'echo var_export(WPF_STAGING_MODE, true), " ", wpf_get_option("crm"), wpf_get_option("connection_configured") ? " connected" : "";')" = "false fluentcrm connected" ] || { echo "WP Fusion must ship connected to FluentCRM and out of staging mode" >&2; exit 1; }
# Nothing that connects the storefront may ship: each one gets its own when it is created.
for OPTION in anypress_api_key anypress_api_secret anypress_api_base_url; do
    # get_option with an explicit default skips AnyPress Host's registered default (the AnyPress API address), so
    # this only finds a value that was saved.
    [ -z "$(wp eval "echo get_option('$OPTION', '');" 2>/dev/null || true)" ] || { echo "$OPTION must not ship" >&2; exit 1; }
done

echo "== Package"
rm -rf "$WORK/out" && mkdir -p "$WORK/out"
wp db export /var/www/html/database.sql --add-drop-table --quiet
mv "$SITE/database.sql" "$WORK/out/database.sql"
cp -a "$SITE/wp-content" "$WORK/out/wp-content"
rm -rf "$WORK/out/wp-content/"{cache,upgrade,upgrade-temp-backup,debug.log}
PLUGINS_JSON=$( (echo "anypress-host $HOST_VERSION ($HOST_COMMIT)"; awk 'NF {print $1, $2}' <<<"$PLUGINS$VENDORED"; echo "anypress-blocks $BLOCKS_VERSION") \
    | jq -Rnc '[inputs | capture("^(?<key>[^ ]+) (?<value>.+)$")] | from_entries')
cat >"$WORK/out/waas-template.json" <<JSON
{
  "name": "Seller storefront",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "wordPress": "$WP_VERSION",
  "php": "$PHP_VERSION",
  "theme": "$THEME $THEME_VERSION",
  "plugins": $PLUGINS_JSON,
  "siteUrl": "$SITE_URL"
}
JSON
rm -f "$DIST/seller-storefront.zip"
(cd "$WORK/out" && zip -qr -X "$DIST/seller-storefront.zip" database.sql wp-content waas-template.json)
ls -l "$DIST/seller-storefront.zip"
sha256sum "$DIST/seller-storefront.zip"

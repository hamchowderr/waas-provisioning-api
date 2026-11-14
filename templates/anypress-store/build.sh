#!/usr/bin/env bash
# Builds the "AnyPress store" base snapshot: WordPress with the AnyPress Client plugin, the Fluent suite (FluentPlayer and FluentSMTP included),
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
# wordpress.org plugins: slug version sha256, in the order AnyPress lists them. All installed and active (roles.json
# switches them per site type).
PLUGINS="
fluent-security 3.1.1 e3e21bf941617de72628d0d254435cb87fdf6629ce3e00d847ad627d975c38d8
fluent-smtp 2.4.5 f495ffcf3c61c4f2b0e20af1092bae256e2a666b9453c8402eb621bc4e444f00
fluent-crm 3.3.1 3559061805e780c60b5078917b702786f829a8e49e15f0edfc7288d55fc1f63e
fluentform 6.2.17 e5dda0290afa0232758017ce63c63c76a57c6f000a0861eb43772a88a39909bc
fluent-booking 2.6.0 83eb315ddb562532ca38a362abae4bc787bd83c3d549e1736739ccb525ddcc34
fluent-cart 2.3.1 dcd1af4986129b61e933bd07d9d71ca04087bbf0a7e947421a2ed065cc9f98c1
fluent-community 2.14.0 79c5f804ce12cfa19e58ff2b200a2d661b7ddb8c56c3828e9d675aa78a1ec53a
fluent-player 1.4.0 edba3f48662136605564bb040fda0b51d50c154c167c699cca47ce3f43f20f1c
fluent-affiliate 1.7.0 f1c617715aaae58657b155c75752adab2db42dd1a8a896469823a19a3b3ee8c8
fluent-support 2.5.0 a9525ca9fdc5e6de34a37b3075db01cd7249818f76e93464d7aec44ac5f04899
easy-code-manager 10.58 39bfd2fe29b099147949086c42dfe715cedd4ddce3631c9ef33165470ed25667
seo-by-rank-math 1.0.282 d4434c5726c62cdd819f0129cac3df5fea0c8efafbcd812856cf87f5e05691a3
automatorwp 6.1.1 5b63d943831bd90e7df4576cf9ac9dbf5afd054d590eedd2b6cb4c9262eff082
wp-fusion-lite 3.48.2 a4b9a90be710e3d5ffac86a472136d71b1a292d121b6698741d4b19ea5b030d7
"
# wordpress.org plugins installed but left off: slug version sha256. AnyPress Client turns the MCP Adapter on on every
# store (always on since AnyPress Client 2.18.0; not in roles.json).
# LeadConnector (HighLevel's own plugin: its forms, chat widget and calendars) is on only for the highlevel site type.
# Polylang is on only while the owner has Languages on (AnyPress Client 2.22.0 or later; not in roles.json).
# Redis Object Cache stays off: only its object-cache.php and Predis client are used, by the drop-in the provisioner's
# agent installs, on stores that have their own Redis (community and everything; not in roles.json).
OFF_PLUGINS="
mcp-adapter 0.7.1 719d81aa1250615acfd8256f0acc8c13f1712f1ae398c3d5883c8b166024fe9b
leadconnector 4.0.7 03854dce113adde9f792a0b2bd397eb139902c16d08328bcd9c57d6c96a41dbc
polylang 3.9.2 90d695711f642efd942d9b7ce25698827b7332a7b26222dfd21719c300e5f9cb
redis-cache 3.0.0 7a03342d3defbe94cac8d0470b42dc1a1c34331b19c47205df20ceccd3c8f54a
"
# Plugins that aren't on wordpress.org: slug version sha256, zipped in plugins/<slug>-<version>.zip (GPL, from the vendor).
# FluentToolkit (WPManageNinja's "FluentHub": one dashboard for the Fluent plugins) updates itself from the vendor afterwards.
# FluentCart Customer Rights (FluentCart's free add-on, from addons-cdn.fluentcart.com: the EU's 14-day cancellation form,
# on the "Withdraw from contract" page FluentCart makes with its other pages) updates itself from FluentCart too.
VENDORED="
fluent-toolkit 2.1.4 2441af4234fa809022962dca0032a7f7fb3d5d1bb79d185ec9f2b1577fad2c6a
fluent-cart-customer-rights 0.1.3 55b0f9307a8cc98e29d492d8bd7842b3a80b0f3be2e3b79bde72cdfd7734e7d3
"
# Vendored plugins installed but left off. The FluentCart Migrator add-on (FluentCart's own WooCommerce importer, from
# addons-cdn.fluentcart.com) is only for AnyPress Client's shop switch, which turns it on when it runs.
OFF_VENDORED="
fluent-cart-migrator 1.1.0-beta 69de5e9033dfad69ccbf4a7c4ece96d5e28f1fc23bb4a2904fea1db653b560ff
"
# AnyPress Blocks (the Popup block and more): a release of github.com/hamchowderr/anypress-blocks, pinned by version
# and checksum (from the release's SHA256SUMS). Active on every site type (roles.json).
BLOCKS_VERSION=${BLOCKS_VERSION:-0.4.3}
BLOCKS_SHA256=${BLOCKS_SHA256:-b5c77f49f37908bc545b79db247860330bdc40b5e2211a94ad66d7d2c22915e1}
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
    anypress_download "$1" "$3"
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

echo "== AnyPress Client from $PLUGINS_REPO"
# Same steps as waas-plugins' scripts/build.sh; the directory must be anypress-client (anypress-client/anypress-client.php).
CLIENT=$SITE/wp-content/plugins/anypress-client
cp -a "$PLUGINS_REPO/packages/anypress-client" "$CLIENT"
rm -rf "$CLIENT/vendor" "$CLIENT/tests" "$CLIENT/phpunit.xml.dist" "$CLIENT/data"
(cd "$CLIENT" && composer install --no-dev --no-interaction --quiet)
CLIENT_VERSION=$(sed -n 's/^Version: *//p' "$CLIENT/anypress-client.php" | head -1)
CLIENT_COMMIT=$(git -C "$PLUGINS_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
# roles.json is what the storefront reads at https://<production version>/wp-content/plugins/anypress-client-data/roles.json
# and what the client uses to switch plugins on per role.
mkdir -p "$SITE/wp-content/plugins/anypress-client-data"
cp "$HERE/roles.json" "$SITE/wp-content/plugins/anypress-client-data/roles.json"
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
wp plugin activate anypress-client $SLUGS

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
EXPECTED=$(printf '%s\n' $SLUGS anypress-client | sort | tr '\n' ' ')
[ "$(wp plugin list --status=active --field=name --skip-update-check | sort | tr '\n' ' ')" = "$EXPECTED" ] || { echo "unexpected active plugins" >&2; exit 1; }
INSTALLED=$(printf '%s\n' $SLUGS $OFF_SLUGS anypress-client | sort | tr '\n' ' ')
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
# FluentSMTP sends wp_mail() but, with no connection of its own, still runs phpmailer_init, where AnyPress's mail
# service (the store's waas-mail.php) sets the relay. Sent here to a no-op sendmail (a real address: the template drops
# reserved ones before any mailer); any log row is removed.
MAIL_CHECK=$(wp eval 'add_action("phpmailer_init", function ($m) { $GLOBALS["anypress_mail_init"] = true; $m->isSendmail(); $m->Sendmail = "/bin/true"; }, PHP_INT_MAX); wp_mail("check@anypress.io", "Check", "Check"); global $wpdb; $wpdb->query("DELETE FROM {$wpdb->prefix}" . FLUENT_MAIL_DB_PREFIX . "email_logs"); echo function_exists("fluentMailSend") && !empty($GLOBALS["anypress_mail_init"]) ? "ok" : "bad";' 2>&1)
[ "${MAIL_CHECK##*$'\n'}" = ok ] || { echo "FluentSMTP skips phpmailer_init, so AnyPress mail would not send: $MAIL_CHECK" >&2; exit 1; }

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
PLUGINS_JSON=$( (echo "anypress-client $CLIENT_VERSION ($CLIENT_COMMIT)"; awk 'NF {print $1, $2}' <<<"$PLUGINS$VENDORED"; awk 'NF {print $1, $2 " (off)"}' <<<"$OFF_PLUGINS$OFF_VENDORED"; echo "anypress-blocks $BLOCKS_VERSION") \
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

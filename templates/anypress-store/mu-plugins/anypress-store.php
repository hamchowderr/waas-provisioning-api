<?php
/*
 * Plugin Name: AnyPress store defaults
 * Description: Settings the AnyPress store template keeps in code: telemetry and upgrade nags off, WP Fusion kept out of staging mode, and per-store first-run steps. Part of the store template.
 */

// The plugins that were on when this request started, before WaaS Client switches any on or off for the site type.
$GLOBALS['anypress_boot_plugins'] = (array) get_option('active_plugins', []);
function anypress_boot_plugins(): array
{
    return (array) ($GLOBALS['anypress_boot_plugins'] ?? []);
}

// WP Fusion compares the site URL with the one it was set up on and stops syncing when they differ. Every
// store is a clone of the template, and stores change domain, so that check would switch it off for real stores.
if (!defined('WPF_STAGING_MODE')) {
    define('WPF_STAGING_MODE', false);
}

// Usage stats that would go to the plugin vendors, if an owner ever opted in.
add_filter('fluent_booking/allow_share_stats', '__return_false');
add_filter('fluentsupport_allow_share_essential', '__return_false');
add_filter('wp_fusion_hide_upgrade_nags', '__return_true');

// The template ships without Akismet and Hello Dolly, but the WordPress image puts WordPress's bundled copies back
// when a store's container first starts. Nobody chose them and store owners can't manage plugins, so delete them
// (only while they're switched off). Checked on admin and WP-CLI requests only; two file_exists calls when gone.
function anypress_remove_bundled_plugins(): void
{
    if (!function_exists('is_plugin_active')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    foreach (['hello.php' => 'hello.php', 'akismet/akismet.php' => 'akismet'] as $file => $on_disk) {
        $target = WP_PLUGIN_DIR . '/' . $on_disk;
        if (!file_exists($target) || is_plugin_active($file)) {
            continue;
        }
        if (is_file($target)) {
            wp_delete_file($target);
            continue;
        }
        $items = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($target, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($items as $item) {
            // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- empty folders only, once, while setting up a new store.
            $item->isDir() ? @rmdir($item->getPathname()) : wp_delete_file($item->getPathname());
        }
        @rmdir($target); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- as above.
    }
}
add_action('admin_init', 'anypress_remove_bundled_plugins');
if (defined('WP_CLI') && WP_CLI) {
    add_action('init', 'anypress_remove_bundled_plugins');
}

// When a store gets its owner's email, WordPress mails the old address about the change. The template's old address
// is admin@example.invalid, so that notice can't be delivered; don't send it.
add_filter('send_site_admin_email_change_email', function ($send, $old_email) {
    return $send && substr((string) $old_email, -8) !== '.invalid';
}, 10, 2);

// FluentAffiliate's tracking script loads on every page once an integration is on (the template switches on
// FluentCart's), so hold it back until the store has an active affiliate whose links could bring visitors.
add_filter('fluent_affiliate/will_load_tracker_js', function ($load) {
    if (!$load || !class_exists('\FluentAffiliate\App\Models\Affiliate')) {
        return $load;
    }
    return !empty(\FluentAffiliate\App\Helper\Utility::getReferralSetting('enabled_integrations'))
        && \FluentAffiliate\App\Models\Affiliate::where('status', 'active')->exists();
});

// A new store has no products yet, and FluentCart's product list (the Shop page's block, the store home page's
// shortcode) would show visitors "No results found" with an empty filter bar. Until the first product is published,
// show a short note instead. Owners see the same note in the editor preview, so they know where products will go.
function anypress_store_has_products(): bool
{
    static $has = null;
    return $has ??= (bool) get_posts(['post_type' => 'fluent-products', 'post_status' => 'publish', 'numberposts' => 1, 'fields' => 'ids', 'suppress_filters' => true]);
}
function anypress_no_products_note(): string
{
    return '<p class="has-text-align-center has-secondary-color has-text-color">' . esc_html__('New products are on their way. Check back soon.', 'anypress') . '</p>';
}
add_filter('pre_do_shortcode_tag', function ($output, $tag) {
    return $tag === 'fluent_cart_products' && !anypress_store_has_products() ? anypress_no_products_note() : $output;
}, 10, 2);
add_filter('pre_render_block', function ($output, $block) {
    return ($block['blockName'] ?? '') === 'fluent-cart/products' && !is_admin() && !anypress_store_has_products() ? anypress_no_products_note() : $output;
}, 10, 2);

// Once per store, and again whenever the store's address changes: the template's dates and rewrite rules
// belong to the build, not to the store.
// Web requests only, so the template build (WP-CLI) never records its own address.
add_action('init', function () {
    if (defined('WP_CLI') && WP_CLI) {
        return;
    }
    $home = home_url();
    $seen = get_option('anypress_store_home');
    if ($seen === $home) {
        return;
    }
    if ($seen === false) {
        // Install dates drive review and upgrade notices; the template's would show them on day one. Each in the
        // plugin's own format: AutomatorWP parses its date with new DateTime(), which throws on a bare timestamp
        // (on every wp-admin page, whenever its review notice isn't hidden).
        update_option('rank_math_install_date', time());
        update_option('automatorwp_install_date', date('Y-m-d H:i:s'));
    }
    // Rank Math's sitemap and FluentCart's product links are rewrite rules built for the old address.
    flush_rewrite_rules(false);
    if (class_exists('\RankMath\Sitemap\Cache')) {
        \RankMath\Sitemap\Cache::invalidate_storage();
    }
    update_option('anypress_store_home', $home, true);
}, 9999);

/*
 * The owner's details. The platform sets the site title and admin email from the purchase when it creates the
 * store, and `waas_store_owner` (JSON: name, country). The plugins keep their own copies of a business name and
 * country, so fill those in once per plugin, the first time a real admin email is there and the plugin is on.
 * Owners change them later in each plugin's settings; a step never runs twice. Each plugin's email sender is the
 * provisioner's waas-mail mu-plugin's job: it follows the store's sending address.
 */
add_action('init', function () {
    // The platform writes these options one WP-CLI call at a time; wait for a web request, when all are there.
    if (defined('WP_CLI') && WP_CLI) {
        return;
    }
    // The plugins each step fills in. A store's site type switches some of them off, and an upgrade switches them
    // on later, so each step runs once, the first time its plugin is on.
    $files = [
        'fluent-cart' => 'fluent-cart/fluent-cart.php',
        'fluent-crm' => 'fluent-crm/fluent-crm.php',
        'fluent-affiliate' => 'fluent-affiliate/fluent-affiliate.php',
        'fluent-booking' => 'fluent-booking/fluent-booking.php',
        'fluent-support' => 'fluent-support/fluent-support.php',
        'wp-fusion-lite' => 'wp-fusion-lite/wp-fusion-lite.php',
        'rank-math' => 'seo-by-rank-math/rank-math.php',
    ];
    $applied = get_option('anypress_owner_applied');
    if (is_string($applied)) {
        // Stores from before site types ran every step at once, with every plugin on.
        return;
    }
    $applied = is_array($applied) ? $applied : [];
    // Plugins on when this request started. One the site type switched on during it hasn't loaded yet.
    $due = array_diff(array_keys(array_intersect($files, anypress_boot_plugins())), $applied);
    if (!$due) {
        return;
    }
    $email = (string) get_option('admin_email');
    if (!is_email($email) || substr($email, -8) === '.invalid') {
        return;
    }
    // Two requests at once: only one applies. A lock older than a minute was left by a request that died.
    $lock = get_option('anypress_owner_lock');
    if ($lock !== false && time() - (int) $lock < 60) {
        return;
    }
    if ($lock !== false) {
        delete_option('anypress_owner_lock');
    }
    if (!add_option('anypress_owner_lock', time(), '', false)) {
        return;
    }
    $name = wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES);
    $owner = json_decode((string) get_option('waas_store_owner', ''), true);
    $country = is_array($owner) ? strtoupper(substr((string) ($owner['country'] ?? ''), 0, 2)) : '';
    $steps = [
        // FluentCart: store name and country (tax, address forms).
        'fluent-cart' => function () use ($name, $country) {
            $settings = ['store_name' => $name];
            if ($country !== '') {
                $settings['store_country'] = $country;
            }
            (new \FluentCart\Api\StoreSettings())->save($settings);
        },
        // FluentCRM: business name and email (email footers).
        'fluent-crm' => function () use ($name, $email) {
            $crm = get_option('fluentcrm-global-settings', []);
            $crm['business_settings'] = array_merge($crm['business_settings'] ?? ['business_address' => '', 'logo' => ''], [
                'business_name' => $name,
                'admin_email' => $email,
            ]);
            update_option('fluentcrm-global-settings', $crm);
        },
        // FluentAffiliate: where its admin notices go.
        'fluent-affiliate' => function () use ($email) {
            $utility = '\FluentAffiliate\App\Helper\Utility';
            $settings = $utility::getOption('global_email_settings', $utility::defaultEmailSettings());
            $utility::updateOption('global_email_settings', array_merge($utility::defaultEmailSettings(), (array) $settings, [
                'admin_email' => $email,
            ]));
        },
        'fluent-booking' => function () use ($country) {
            if ($country === '') {
                return;
            }
            $settings = get_option('_fluent_booking_settings', []);
            $settings['administration']['default_country'] = strtolower($country);
            update_option('_fluent_booking_settings', $settings, false);
        },
        // Fluent Support: its first mailbox, which tickets need, under the store's name, with its notices to the owner.
        // waas-mail gives it the store's sending address.
        'fluent-support' => function () use ($name, $email) {
            if (\FluentSupport\App\Models\MailBox::first()) {
                return;
            }
            $admin = get_user_by('email', $email);
            \FluentSupport\App\Models\MailBox::create([
                'name' => $name,
                'email' => $email,
                'box_type' => 'web',
                'is_default' => 'yes',
                'created_by' => $admin ? $admin->ID : 0,
                'settings' => ['admin_email_address' => $email],
            ]);
        },
        // WP Fusion: connected to FluentCRM on this site, which is all its Connect button does, plus the default
        // field map and the tag and list cache it loads next. Left unconnected in the template, so the tags come
        // from this store's FluentCRM.
        'wp-fusion-lite' => function () {
            if (!function_exists('wp_fusion') || !class_exists('WPF_FluentCRM') || !defined('FLUENTCRM') || wpf_get_option('connection_configured')) {
                return;
            }
            $fields = (array) wpf_get_option('contact_fields', []);
            foreach ([
                'first_name' => ['first_name', 'First Name', true],
                'last_name' => ['last_name', 'Last Name', true],
                'user_email' => ['email', 'Email', true],
                'phone_number' => ['phone', 'Phone', false],
                'billing_address_1' => ['address_line_1', 'Address 1', false],
                'billing_address_2' => ['address_line_2', 'Address 2', false],
                'billing_city' => ['city', 'City', false],
                'billing_state' => ['state', 'State', false],
                'billing_postcode' => ['postal_code', 'Zip', false],
                'billing_country' => ['country', 'Country', false],
            ] as $meta => [$crmField, $label, $active]) {
                $fields[$meta] = array_merge((array) ($fields[$meta] ?? []), ['crm_field' => $crmField, 'crm_label' => $label, 'active' => $active]);
            }
            wp_fusion()->settings->set_multiple([
                'crm' => 'fluentcrm',
                'connection_configured' => true,
                // New users become FluentCRM contacts, "transactional" (an account isn't a newsletter sign-up), and
                // profile changes follow them.
                'create_users' => true,
                'default_status' => 'transactional',
                'push' => true,
                'contact_fields' => $fields,
            ]);
            (new \WPF_FluentCRM())->sync();
        },
        'rank-math' => function () use ($name) {
            $titles = get_option('rank-math-options-titles', []);
            $titles['knowledgegraph_name'] = $name;
            $titles['website_name'] = $name;
            update_option('rank-math-options-titles', $titles);
        },
    ];
    foreach ($due as $plugin) {
        try {
            $steps[$plugin]();
        } catch (\Throwable $e) {
            error_log("AnyPress store: owner details for $plugin: " . $e->getMessage()); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- one plugin's setup failing must not stop the rest; the store's log is where it is looked into.
        }
        $applied[] = $plugin;
    }
    update_option('anypress_owner_applied', $applied, false);
    delete_option('anypress_owner_lock');
}, 9999);

/** Bookings sites: FluentBooking on and FluentCommunity off (Everything has both). They have FluentCart for paid bookings. */
function anypress_is_bookings_site(array $active): bool
{
    return in_array('fluent-booking/fluent-booking.php', $active, true) && !in_array('fluent-community/fluent-community.php', $active, true);
}

/*
 * Site types. Each store's plan role (roles.json) switches the template's plugins on or off, and WaaS Client does
 * that on `init`. Pages that only work with one plugin (FluentCart's shop, cart and checkout, Fluent Support's
 * portal) carry `_anypress_needs`: they go back to draft while their plugin is off and come back when it's on, so
 * menus and the home page never show an empty shop. With the shop hidden, the home page shows the latest posts.
 * Bookings sites have FluentCart only to take payment for bookings, so they get its checkout, receipt and account
 * pages but not the Shop or Cart page. Runs only when the set of active plugins changes.
 */
add_action('init', function () {
    if (defined('WP_CLI') && WP_CLI) {
        return;
    }
    $active = array_values((array) get_option('active_plugins', []));
    sort($active);
    $seen = md5(implode(',', $active));
    if (get_option('anypress_site_type_plugins') === $seen) {
        return;
    }
    $pages = get_posts([
        'post_type' => 'page',
        'post_status' => ['publish', 'draft'],
        'meta_key' => '_anypress_needs', // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key -- runs only when the set of active plugins changes.
        'numberposts' => -1,
        'suppress_filters' => true,
    ]);
    foreach ($pages as $page) {
        $on = in_array(get_post_meta($page->ID, '_anypress_needs', true), $active, true)
            && !(in_array($page->post_name, ['shop', 'cart'], true) && anypress_is_bookings_site($active));
        if (!$on && $page->post_status === 'publish') {
            update_post_meta($page->ID, '_anypress_hidden', 1);
            wp_update_post(['ID' => $page->ID, 'post_status' => 'draft']);
        } elseif ($on && $page->post_status === 'draft' && get_post_meta($page->ID, '_anypress_hidden', true)) {
            // Only pages hidden here: a page the owner drafted stays a draft.
            delete_post_meta($page->ID, '_anypress_hidden');
            wp_update_post(['ID' => $page->ID, 'post_status' => 'publish']);
        }
    }
    $front = (int) get_option('page_on_front');
    $saved = (int) get_option('anypress_front_page');
    if (get_option('show_on_front') === 'page' && $front && get_post_status($front) !== 'publish') {
        update_option('show_on_front', 'posts');
        update_option('anypress_front_page', $front, false);
    } elseif (get_option('show_on_front') === 'posts' && $saved && get_post_status($saved) === 'publish') {
        update_option('show_on_front', 'page');
        delete_option('anypress_front_page');
    }
    update_option('anypress_site_type_plugins', $seen, true);
}, 9999);

/*
 * FluentCart's emails open with its store logo. Keep it the site's own logo (Site Editor or Customizer), so receipts
 * carry the owner's brand; with no logo they show the store name. Runs only when the logo changes.
 */
function anypress_sync_fluentcart_logo(): void {
    if (!class_exists('\FluentCart\Api\StoreSettings')) {
        return;
    }
    $id = (int) (get_option('site_logo') ?: get_theme_mod('custom_logo'));
    $url = $id ? (string) wp_get_attachment_image_url($id, 'medium') : '';
    (new \FluentCart\Api\StoreSettings())->save(['store_logo' => ['id' => $id ?: '', 'url' => $url]]);
}
add_action('update_option_site_logo', 'anypress_sync_fluentcart_logo');
add_action('add_option_site_logo', 'anypress_sync_fluentcart_logo');
add_action('delete_option_site_logo', 'anypress_sync_fluentcart_logo');
add_action('customize_save_after', 'anypress_sync_fluentcart_logo');

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
        // Install dates drive review and upgrade notices; the template's would show them on day one.
        foreach (['rank_math_install_date', 'automatorwp_install_date'] as $option) {
            update_option($option, time());
        }
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
                // New users become FluentCRM contacts, and profile changes follow them.
                'create_users' => true,
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
            error_log("AnyPress store: owner details for $plugin: " . $e->getMessage());
        }
        $applied[] = $plugin;
    }
    update_option('anypress_owner_applied', $applied, false);
    delete_option('anypress_owner_lock');
}, 9999);

/*
 * Site types. Each store's plan role (roles.json) switches the template's plugins on or off, and WaaS Client does
 * that on `init`. Pages that only work with one plugin (FluentCart's shop, cart and checkout, Fluent Support's
 * portal) carry `_anypress_needs`: they go back to draft while their plugin is off and come back when it's on, so
 * menus and the home page never show an empty shop. With the shop hidden, the home page shows the latest posts.
 * Runs only when the set of active plugins changes.
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
        'meta_key' => '_anypress_needs',
        'numberposts' => -1,
        'suppress_filters' => true,
    ]);
    foreach ($pages as $page) {
        $on = in_array(get_post_meta($page->ID, '_anypress_needs', true), $active, true);
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

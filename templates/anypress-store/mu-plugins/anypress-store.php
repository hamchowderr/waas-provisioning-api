<?php
/*
 * Plugin Name: AnyPress store defaults
 * Description: Settings the AnyPress store template keeps in code: telemetry and upgrade nags off, WP Fusion kept out of staging mode, and per-store first-run steps. Part of the store template.
 */

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
 * store, and `waas_store_owner` (JSON: name, country). The plugins keep their own copies of a sender and a
 * business name, so fill those in once, the first time a real admin email is there. Owners change them later in
 * each plugin's settings; this never runs again.
 */
add_action('init', function () {
    // The platform writes these options one WP-CLI call at a time; wait for a web request, when all are there.
    if ((defined('WP_CLI') && WP_CLI) || get_option('anypress_owner_applied') !== false) {
        return;
    }
    $email = (string) get_option('admin_email');
    if (!is_email($email) || substr($email, -8) === '.invalid') {
        return;
    }
    // Two first requests at once: only one applies.
    if (!add_option('anypress_owner_applied', gmdate('c'), '', false)) {
        return;
    }
    $name = wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES);
    $owner = json_decode((string) get_option('waas_store_owner', ''), true);
    $country = is_array($owner) ? strtoupper(substr((string) ($owner['country'] ?? ''), 0, 2)) : '';
    $steps = [
        // FluentCart: store name and country (tax, address forms), and the sender on its emails.
        'fluent-cart' => function () use ($name, $email, $country) {
            $settings = ['store_name' => $name];
            if ($country !== '') {
                $settings['store_country'] = $country;
            }
            (new \FluentCart\Api\StoreSettings())->save($settings);
            \FluentCart\App\Services\Email\EmailNotifications::updateSettings(['from_name' => $name, 'from_email' => $email]);
        },
        // FluentCRM: business name (email footers) and sender. FluentBooking uses FluentCRM's sender.
        'fluent-crm' => function () use ($name, $email) {
            $crm = get_option('fluentcrm-global-settings', []);
            $crm['business_settings'] = array_merge($crm['business_settings'] ?? ['business_address' => '', 'logo' => ''], [
                'business_name' => $name,
                'admin_email' => $email,
            ]);
            $crm['email_settings'] = array_merge(\FluentCrm\App\Services\Helper::getGlobalEmailSettings(), [
                'from_name' => $name,
                'from_email' => $email,
            ]);
            update_option('fluentcrm-global-settings', $crm);
        },
        'fluent-affiliate' => function () use ($name, $email) {
            $utility = '\FluentAffiliate\App\Helper\Utility';
            $settings = $utility::getOption('global_email_settings', $utility::defaultEmailSettings());
            $utility::updateOption('global_email_settings', array_merge($utility::defaultEmailSettings(), (array) $settings, [
                'send_from_name' => $name,
                'send_from_email' => $email,
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
        // Fluent Support: its first mailbox, which tickets need, under the store's name and the owner's email.
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
    foreach ($steps as $plugin => $step) {
        try {
            $step();
        } catch (\Throwable $e) {
            error_log("AnyPress store: owner details for $plugin: " . $e->getMessage());
        }
    }
}, 9999);

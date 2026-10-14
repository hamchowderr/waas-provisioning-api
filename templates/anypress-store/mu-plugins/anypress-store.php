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

// FluentAffiliate's tracking script loads on every page, even with no affiliate programme switched on.
add_filter('fluent_affiliate/will_load_tracker_js', function ($load) {
    if (!class_exists('\FluentAffiliate\App\Helper\Utility')) {
        return $load;
    }
    return $load && !empty(\FluentAffiliate\App\Helper\Utility::getReferralSetting('enabled_integrations'));
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

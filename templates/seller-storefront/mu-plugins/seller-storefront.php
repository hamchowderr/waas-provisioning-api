<?php
/*
 * Plugin Name: Seller storefront defaults
 * Description: Settings the seller storefront template keeps in code: WP Fusion kept out of staging mode and the owner's details filled in once. Buyers and leads are tagged by the AnyPress CRM lifecycle plugin. Part of the storefront template.
 */

// WP Fusion compares the site URL with the one it was set up on and stops syncing when they differ. Every
// storefront is a clone of the template and can change domain, so that check would switch it off.
if (!defined('WPF_STAGING_MODE')) {
    define('WPF_STAGING_MODE', false);
}
add_filter('wp_fusion_hide_upgrade_nags', '__return_true');

/*
 * The owner's details, filled in once. The API sets the site title and admin email after the storefront is made from
 * the template, so FluentCRM's business name and email (its email footers) wait for the first web request that has a
 * real admin email.
 */
add_action('init', function () {
    if ((defined('WP_CLI') && WP_CLI) || get_option('seller_storefront_owner_applied') || !defined('FLUENTCRM')) {
        return;
    }
    $email = (string) get_option('admin_email');
    if (!is_email($email) || substr($email, -8) === '.invalid') {
        return;
    }
    if (!add_option('seller_storefront_owner_applied', time(), '', false)) {
        return;
    }
    $crm = get_option('fluentcrm-global-settings', []);
    $crm['business_settings'] = array_merge($crm['business_settings'] ?? ['business_address' => '', 'logo' => ''], [
        'business_name' => wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES),
        'admin_email' => $email,
    ]);
    update_option('fluentcrm-global-settings', $crm);
}, 9999);

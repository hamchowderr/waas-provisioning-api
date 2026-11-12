<?php
/*
 * Plugin Name: Seller storefront defaults
 * Description: Settings the seller storefront template keeps in code: WP Fusion kept out of staging mode and the owner’s details filled in once (FluentCRM, FluentCart, Fluent Support, FluentBooking, FluentAffiliate). Buyers and leads are tagged by the AnyPress CRM lifecycle plugin. Part of the storefront template.
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
 * real admin email. The other plugins' copies of the owner's name and email follow in the same step.
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

    $name = wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES);
    $owner = get_user_by('email', $email);
    $steps = [
        // FluentCart: the store's name on receipts and invoices.
        'fluent-cart' => static fn() => (new \FluentCart\Api\StoreSettings())->save(['store_name' => $name]),
        // Fluent Support: its first mailbox, which the Support page's requests need, under the owner's name and email.
        'fluent-support' => static function () use ($name, $email, $owner) {
            if (!\FluentSupport\App\Models\MailBox::first()) {
                \FluentSupport\App\Models\MailBox::create(['name' => $name, 'email' => $email, 'box_type' => 'web', 'is_default' => 'yes', 'created_by' => $owner ? $owner->ID : 0, 'settings' => ['admin_email_address' => $email]]);
            }
        },
        // FluentBooking: the Book a call calendar, made for the template's admin, moves to the owner.
        'fluent-booking' => static function () use ($owner, $name) {
            if ($owner) {
                \FluentBooking\App\Models\Calendar::query()->update(['user_id' => $owner->ID, 'title' => $name]);
                \FluentBooking\App\Models\CalendarSlot::query()->update(['user_id' => $owner->ID]);
            }
        },
        // FluentAffiliate: where its notices about new referrers go.
        'fluent-affiliate' => static function () use ($email) {
            $utility = '\FluentAffiliate\App\Helper\Utility';
            $utility::updateOption('global_email_settings', array_merge($utility::defaultEmailSettings(), (array) $utility::getOption('global_email_settings', []), ['admin_email' => $email]));
        },
    ];
    foreach ($steps as $plugin => $step) {
        try {
            $step();
        } catch (\Throwable $e) {
            error_log("Seller storefront: owner details for $plugin: " . $e->getMessage()); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- one plugin's setup failing must not stop the rest.
        }
    }

    // The shop narrowed to what the seller said they sell and who they sell to (the API's anypress_storefront_setup,
    // from their application): the template's pages made again with only those plans and Who we help pages.
    $kit = WP_CONTENT_DIR . '/anypress-storefront/pages.php';
    if (get_option('anypress_storefront_setup') && is_readable($kit)) {
        // Remaking the pages takes longer than an ordinary page load; let it finish even if the visitor leaves.
        ignore_user_abort(true);
        if (function_exists('set_time_limit')) {
            set_time_limit(300);
        }
        $before = get_current_user_id();
        if ($owner) {
            wp_set_current_user($owner->ID);
        }
        ob_start();
        try {
            (static function () use ($kit) {
                require $kit;
            })();
            update_option('seller_storefront_pages_made', time(), false);
        } catch (\Throwable $e) {
            error_log('Seller storefront: pages for the seller\'s site types not made: ' . $e->getMessage()); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- the template's full shop stays; the store's log is where it is looked into.
        }
        ob_end_clean();
        wp_set_current_user($before);
    }
}, 9999);

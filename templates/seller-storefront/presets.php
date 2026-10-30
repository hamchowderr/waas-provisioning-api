<?php
/**
 * Settings that are the same for every seller storefront, applied once on the template build:
 *   wp eval-file presets.php --user=waas-admin
 * Each block says which plugin screen it stands in for. Per-storefront values (site title, the owner's email,
 * the API key and secret) are not set here; the API sets them when it creates the storefront.
 */

// FluentCart. Its first admin visit runs "first activation", which blanks the store name and opens the
// onboarding wizard; the build already did what that wizard does (pages, currency).
update_option('fluent_cart_plugin_once_activated', '1');
delete_option('fluent_cart_do_activation_redirect');
(new \FluentCart\Api\StoreSettings())->save([
    'show_cart_icon_in_nav' => 'yes',
    // Settings → Reminders: the seller's customers pay monthly, so they hear 7 days before each charge.
    'reminders_enabled' => 'yes',
    'monthly_renewal_reminders_enabled' => 'yes',
]);
// Settings → Email notifications → Settings: a footer that tells customers how to reach the owner (replies go to the
// site's sending address; waas-mail sets that). The store logo at the top of each email follows the site logo
// (WaaS Host), so emails carry the owner's brand and nothing of AnyPress.
\FluentCart\App\Services\Email\EmailNotifications::updateSettings([
    'email_footer' => '<p>Questions? Just reply to this email.</p>',
]);
// Settings → Email notifications: one email per moment. WaaS Host's own emails already cover a cancelled plan
// ("stays online until"), websites aren't shipped, and the store-managed renewal emails (renewal invoice, upcoming
// charge, charge failed, overdue reminders) repeat the card-renewal ones a storefront sends (waas-api-mi4).
foreach (['order_shipped_customer', 'order_delivered_customer', 'subscription_canceled_customer', 'renewal_created_customer',
    'renewal_created_admin', 'system_upcoming_charge_customer', 'system_charge_failed_customer', 'renewal_reminder_due_customer',
    'renewal_overdue_first_customer', 'renewal_overdue_followup_customer', 'renewal_overdue_final_customer'] as $name) {
    \FluentCart\App\Services\Email\EmailNotifications::updateNotification(
        $name,
        array_merge(\FluentCart\App\Services\Email\EmailNotifications::getNotificationConfig($name), ['active' => 'no'])
    );
}
// Settings → Checkout fields: a terms checkbox buyers must tick.
$fields = \FluentCart\App\Services\Renderer\CheckoutFieldsSchema::getFieldsSettings();
$fields['agree_terms'] = ['enabled' => 'yes', 'required' => 'yes', 'text' => 'I agree to the terms and conditions.'];
fluent_cart_update_option('_fc_checkout_fields', $fields);

// FluentAuth. Saving its settings once is what its first-run wizard does. Its defaults stay (5 failed logins locks
// an address for 30 minutes, a monthly login digest to the admin email); XML-RPC is off, since a storefront doesn't
// use it and it is the usual target for password guessing. A storefront holds the API key that creates websites,
// so its admin login matters more than most.
update_option('__fls_auth_settings', array_merge(\FluentAuth\App\Helpers\Helper::getAuthSettings(), ['disable_xmlrpc' => 'yes']));

// FluentKit (FluentHub → Settings): one dashboard for FluentCart, FluentAuth and AnyPress, with the WordPress menu items
// merged into it and each app's own top bar hidden.
update_option('_fluent_kit_settings', array_merge((array) get_option('_fluent_kit_settings', []), [
    'uinified_ui' => 'yes',
    'merge_admin_menus' => 'yes',
    'hide_app_headers' => 'yes',
]));

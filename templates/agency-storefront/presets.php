<?php
/**
 * Settings that are the same for every agency storefront, applied once on the template build:
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
    // Settings → Reminders: the agency's customers pay monthly, so they hear 7 days before each charge.
    'reminders_enabled' => 'yes',
    'monthly_renewal_reminders_enabled' => 'yes',
]);
// Settings → Checkout fields: a terms checkbox buyers must tick.
$fields = \FluentCart\App\Services\Renderer\CheckoutFieldsSchema::getFieldsSettings();
$fields['agree_terms'] = ['enabled' => 'yes', 'required' => 'yes', 'text' => 'I agree to the terms and conditions.'];
fluent_cart_update_option('_fc_checkout_fields', $fields);

// FluentAuth. Saving its settings once is what its first-run wizard does. Its defaults stay (5 failed logins locks
// an address for 30 minutes, a monthly login digest to the admin email); XML-RPC is off, since a storefront doesn't
// use it and it is the usual target for password guessing. A storefront holds the API key that creates websites,
// so its admin login matters more than most.
update_option('__fls_auth_settings', array_merge(\FluentAuth\App\Helpers\Helper::getAuthSettings(), ['disable_xmlrpc' => 'yes']));

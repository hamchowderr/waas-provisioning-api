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

// FluentCRM. Its setup wizard can send the owner's details to the vendor; the tags it would ask for are made here.
// Buyers are tagged by the seller-storefront.php mu-plugin ("Website: Active", then "Website: Past").
fluentcrm_update_option('fluentcrm_setup_wizard_ran', 'yes');
fluentcrm_update_option('_fluentcrm_share_essential', 'no');
$newsletter = \FluentCrm\App\Models\Lists::firstOrCreate(['slug' => 'newsletter'], ['title' => 'Newsletter']);
foreach (['Website: Active', 'Website: Past'] as $title) {
    \FluentCrm\App\Models\Tag::firstOrCreate(['slug' => sanitize_title($title)], ['title' => $title]);
}
// Settings → SmartCodes & Integrations: an unticked newsletter box at FluentCart checkout (double opt-in, into
// Newsletter), and WordPress users kept in sync with their contacts.
fluentcrm_update_option('fluent_cart_checkout_form_subscribe_settings', array_merge(
    (new \FluentCrm\App\Services\AutoSubscribe())->getFluentCartCheckoutSettings(),
    ['status' => 'yes', 'auto_checked' => 'no', 'double_optin' => 'yes', 'show_only_new' => 'yes', 'target_list' => (string) $newsletter->id]
));
fluentcrm_update_option('user_syncing_settings', ['status' => 'yes', 'delete_contact_on_user_delete' => 'no']);
// Email speed: 10 caps it at 7 a second (FluentCRM keeps 3 in reserve), well inside the mail relay's limit.
$crm = get_option('fluentcrm-global-settings', []);
unset($crm['campaign'], $crm['email']);
$crm['email_settings'] = array_merge(\FluentCrm\App\Services\Helper::getGlobalEmailSettings(), ['emails_per_second' => 10]);
update_option('fluentcrm-global-settings', $crm);
// Email styles: a white card on an off-white page with dark text and links, so the owner's words and logo carry
// the brand (the same look as AnyPress stores).
fluentcrm_update_option('global_email_style_config', array_merge((array) fluentcrm_get_option('global_email_style_config', []), [
    'content_width' => 600,
    'content_border_radius' => '12px',
    'content_padding_top' => '28px',
    'content_padding_right' => '32px',
    'content_padding_bottom' => '20px',
    'content_padding_left' => '32px',
    'body_bg_color' => '#f6f5f2',
    'content_bg_color' => '#ffffff',
    'headings_color' => '#141414',
    'text_color' => '#1f1f1f',
    'link_color' => '#141414',
    'footer_text_color' => '#6b6b6b',
]));
// Settings → Compliance.
update_option('_fluentcrm_compliance_settings', array_merge((array) get_option('_fluentcrm_compliance_settings', []), \FluentCrm\App\Services\Helper::getComplianceSettings(), [
    'anonymize_ip' => 'yes',
    'one_click_unsubscribe' => 'yes',
    'enable_gravatar' => 'no',
    'gravatar_fallback' => 'no',
]));

// WP Fusion Lite: connected to FluentCRM on this site, which is all its setup screen's Connect button does, plus the
// default field map and the tag and list cache it loads next. Profile changes follow the contact. It doesn't make
// contacts itself (create_users off): buyers become contacts through the mu-plugin, which keeps unsubscribes, while
// WP Fusion would mark every new user subscribed. A seller who uses HighLevel or another CRM switches it in
// Settings → WP Fusion → Setup and turns on "Create contacts". The mu-plugin keeps it out of staging mode.
$wpfFields = (array) wpf_get_option('contact_fields', []);
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
    $wpfFields[$meta] = array_merge((array) ($wpfFields[$meta] ?? []), ['crm_field' => $crmField, 'crm_label' => $label, 'active' => $active]);
}
wp_fusion()->settings->set_multiple([
    'crm' => 'fluentcrm',
    'connection_configured' => true,
    'push' => true,
    'contact_fields' => $wpfFields,
]);
// Saved as an explicit 0: set_multiple() skips false values, and the settings screen shows an unsaved box as ticked.
wp_fusion()->settings->set('create_users', 0);
(new \WPF_FluentCRM())->sync();

// AnyPress theme. A home page built from the theme's own sections (the store template's starter-page builders in
// anypress-patterns.php, copied in for the build only), so a new storefront opens on a finished-looking page the owner
// rewrites in the Site Editor. The plans section lists FluentCart's products: the website plans WaaS Host makes.
require __DIR__ . '/anypress-patterns.php';
$pageId = static fn(string $slug): int => (int) get_page_by_path($slug)?->ID;
$account = get_permalink($pageId('account'));
// FluentCart's shop lists the website plans, so it is called Plans.
wp_update_post(['ID' => $pageId('shop'), 'post_title' => 'Plans']);
kses_remove_filters();
$home = wp_insert_post([
    'post_type' => 'page',
    'post_status' => 'publish',
    'post_title' => 'Home',
    'post_name' => 'home',
    'comment_status' => 'closed',
    'ping_status' => 'closed',
    'page_template' => 'page-no-title',
    'post_content' => anypress_hero(
        'Your website, ready in minutes',
        'Pick a plan and your new website is ready to make your own. Hosting, security, backups and updates are included, so you can get on with your business.',
        [['See the plans', '#plans'], ['Sign in', $account]]
    )
        . anypress_features('Everything a website needs', [
            ['Ready to edit', 'Your website starts with real pages. Change the words, photos and colours yourself, no code needed.'],
            ['Your own domain', 'Start on a free address, then connect a domain you own whenever you are ready.'],
            ['Safe and backed up', 'Secure connections, automatic updates and a backup every night.'],
            ['Grows with you', 'Add a shop, bookings or courses when you need them by moving to a bigger plan.'],
            ['Fast everywhere', 'Pages are built to load quickly on phones as well as computers.'],
            ['Help when you need it', 'Ask us anything about your website from your account.'],
        ])
        . anypress_features('How it works', [
            ['1. Pick a plan', 'Choose the plan that fits what your business needs today.'],
            ['2. Check out', 'Pay securely by card. You can cancel at any time.'],
            ['3. Make it yours', 'Sign in to your new website and add your words, photos and logo.'],
        ], 'tint')
        . anypress_embed('Plans', '[fluent_cart_products per_page="12" paginator="numbers"]', 'plans')
        . anypress_faq('Questions', [
            ['Do I need to know how to build websites?', 'No. Your website comes with pages ready to edit, and you change them with simple blocks.'],
            ['Can I use my own domain?', 'Yes. Every website starts on a free address, and you can connect your own domain from your account.'],
            ['Can I change plans or cancel?', 'Yes. Move to another plan or cancel from your account at any time.'],
            ['What is included?', 'Hosting, security, nightly backups and updates come with every plan.'],
        ])
        . anypress_call_to_action('Ready to get online?', 'Your website can be ready today.', [['See the plans', '#plans']]),
], true);
kses_init();
if (is_wp_error($home)) {
    throw new RuntimeException($home->get_error_message());
}
update_option('show_on_front', 'page');
update_option('page_on_front', $home);
// Without a menu the header's navigation lists every page (Receipt, Review Your Order...), so make one; the header and
// footer navigation blocks use the newest menu.
$link = static function (string $label, int $id): string {
    $attrs = wp_json_encode(['label' => $label, 'type' => 'page', 'id' => $id, 'url' => get_permalink($id), 'kind' => 'post-type']);
    return "<!-- wp:navigation-link $attrs /-->";
};
$menu = wp_insert_post([
    'post_type' => 'wp_navigation',
    'post_status' => 'publish',
    'post_title' => 'Main menu',
    'post_content' => $link('Plans', $pageId('shop')) . $link('Account', $pageId('account')),
], true);
if (is_wp_error($menu)) {
    throw new RuntimeException($menu->get_error_message());
}

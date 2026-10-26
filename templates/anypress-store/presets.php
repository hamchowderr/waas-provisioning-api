<?php
/**
 * Settings that are the same for every AnyPress store, applied once on the template build:
 *   wp eval-file presets.php --user=waas-admin
 * Each block says which plugin screen it stands in for. Per-store values (site title, the owner's email,
 * country) are not set here; they come from the purchase.
 */

$merge = static function (string $option, array $values): void {
    $current = get_option($option, []);
    update_option($option, array_merge(is_array($current) ? $current : [], $values));
};

// Rank Math. It loads none of its modules (sitemap, meta, schema) until the site is connected to a Rank
// Math account or that step is skipped, so skip it, and mark its setup wizard done.
update_option('rank_math_registration_skip', 1);
update_option('rank_math_is_configured', true, false);
delete_transient('_rank_math_activation_redirect');
// Modules that need a Rank Math account stay off; IndexNow sends every new page to search engines even
// before launch, so the owner turns it on then. Redirections and the 404 log help when products move.
\RankMath\Helper::update_modules([
    'analytics' => 'off',
    'content-ai' => 'off',
    'ai-visibility' => 'off',
    'instant-indexing' => 'off',
    'redirections' => 'on',
    '404-monitor' => 'on',
]);
// FluentCart's product type and taxonomies didn't exist when Rank Math set up, so it has no settings for
// them. Same keys and values the Rank Math installer writes for other types.
$titles = get_option('rank-math-options-titles', []);
$titles = array_merge($titles, [
    'knowledgegraph_type' => 'company',
    'opening_hours' => [],
    'disable_author_archives' => 'on',
    'pt_fluent-products_title' => '%title% %sep% %sitename%',
    'pt_fluent-products_description' => '%excerpt%',
    'pt_fluent-products_robots' => ['index'],
    'pt_fluent-products_custom_robots' => 'off',
    // FluentCart prints its own Product schema; a second one from Rank Math would duplicate it.
    'pt_fluent-products_default_rich_snippet' => 'off',
    'pt_fluent-products_default_article_type' => 'Article',
    'pt_fluent-products_archive_title' => '%title% %page% %sep% %sitename%',
    'pt_fluent-products_add_meta_box' => 'on',
    'pt_fluent-products_bulk_editing' => 'editing',
    'pt_fluent-products_link_suggestions' => 'on',
    'pt_fluent-products_ls_use_fk' => 'titles',
    'pt_fluent-products_primary_taxonomy' => 'product-categories',
]);
$sitemap = get_option('rank-math-options-sitemap', []);
$sitemap['pt_fluent-products_sitemap'] = 'on';
$sitemap['authors_sitemap'] = 'off';
foreach (['product-categories', 'product-brands'] as $taxonomy) {
    $titles += [
        "tax_{$taxonomy}_title" => '%term% %sep% %sitename%',
        "tax_{$taxonomy}_robots" => ['index'],
        "tax_{$taxonomy}_custom_robots" => 'off',
        "tax_{$taxonomy}_description" => '%term_description%',
        "tax_{$taxonomy}_add_meta_box" => 'on',
    ];
    $sitemap["tax_{$taxonomy}_sitemap"] = 'on';
}
update_option('rank-math-options-titles', $titles);
update_option('rank-math-options-sitemap', $sitemap);
update_option('rank_math_known_post_types', \RankMath\Helper::get_accessible_post_types());
delete_option('rank_math_flush_rewrite');

// FluentCart. Its first admin visit runs "first activation", which blanks the store name and opens the
// onboarding wizard; the build already did what that wizard does (pages, currency).
update_option('fluent_cart_plugin_once_activated', '1');
delete_option('fluent_cart_do_activation_redirect');
(new \FluentCart\Api\StoreSettings())->save([
    'show_cart_icon_in_nav' => 'yes',
    // Settings → Reminders. Nothing is sent while the master switch is off; monthly plans (the usual kind) get
    // a reminder 7 days before each charge, on top of the yearly and trial-end ones that are already on.
    'reminders_enabled' => 'yes',
    'monthly_renewal_reminders_enabled' => 'yes',
]);
// Settings → Checkout fields: a terms checkbox buyers must tick.
$fields = \FluentCart\App\Services\Renderer\CheckoutFieldsSchema::getFieldsSettings();
$fields['agree_terms'] = ['enabled' => 'yes', 'required' => 'yes', 'text' => 'I agree to the terms and conditions.'];
fluent_cart_update_option('_fc_checkout_fields', $fields);

// FluentCRM. Its setup wizard can send the owner's details to the vendor; the lists and tags it would ask
// for are made here.
fluentcrm_update_option('fluentcrm_setup_wizard_ran', 'yes');
fluentcrm_update_option('_fluentcrm_share_essential', 'no');
$lists = [];
foreach (['Newsletter', 'Customers'] as $title) {
    $list = \FluentCrm\App\Models\Lists::firstOrCreate(['slug' => sanitize_title($title)], ['title' => $title]);
    $lists[$title] = $list->id;
}
foreach (['Customer', 'Lead', 'Subscriber'] as $title) {
    \FluentCrm\App\Models\Tag::firstOrCreate(['slug' => sanitize_title($title)], ['title' => $title]);
}
// Settings → SmartCodes & Integrations: an unticked newsletter box at FluentCart checkout (double opt-in, into
// Newsletter), and WordPress users kept in sync as contacts, so customers who make accounts show up in the CRM.
fluentcrm_update_option('fluent_cart_checkout_form_subscribe_settings', array_merge(
    (new \FluentCrm\App\Services\AutoSubscribe())->getFluentCartCheckoutSettings(),
    ['status' => 'yes', 'auto_checked' => 'no', 'double_optin' => 'yes', 'show_only_new' => 'yes', 'target_list' => (string) $lists['Newsletter']]
));
fluentcrm_update_option('user_syncing_settings', ['status' => 'yes', 'delete_contact_on_user_delete' => 'no']);
// Email speed. The value saved on activation sits under a key nothing reads; the real default is 15 a
// second. 10 caps it at 7 a second (FluentCRM keeps 3 in reserve), well inside the relay's limit.
$crm = get_option('fluentcrm-global-settings', []);
unset($crm['campaign'], $crm['email']);
$crm['email_settings'] = array_merge(\FluentCrm\App\Services\Helper::getGlobalEmailSettings(), ['emails_per_second' => 10]);
update_option('fluentcrm-global-settings', $crm);
// Settings → Compliance.
$merge('_fluentcrm_compliance_settings', array_merge(\FluentCrm\App\Services\Helper::getComplianceSettings(), [
    'anonymize_ip' => 'yes',
    'one_click_unsubscribe' => 'yes',
    'enable_gravatar' => 'no',
    'gravatar_fallback' => 'no',
]));

// Fluent Forms. Global settings → Security: the honeypot and token checks, off by default.
$forms = get_option('_fluentform_global_form_settings', []);
$forms['misc'] = array_merge($forms['misc'] ?? [], ['honeypotStatus' => 'yes', 'tokenBasedProtectionStatus' => 'yes']);
update_option('_fluentform_global_form_settings', $forms);
// The two forms Fluent Forms makes on activation. The contact form gets the email it never had; the
// subscription form puts people on the Newsletter list once they confirm.
$formIds = [];
foreach (wpFluent()->table('fluentform_forms')->get() as $form) {
    $formIds[$form->title] = (int) $form->id;
}
$setMeta = static function (int $formId, string $key, array $value): void {
    wpFluent()->table('fluentform_form_meta')->where('form_id', $formId)->where('meta_key', $key)->delete();
    wpFluent()->table('fluentform_form_meta')->insert(['form_id' => $formId, 'meta_key' => $key, 'value' => wp_json_encode($value)]);
};
if (isset($formIds['Contact Form Demo'])) {
    $setMeta($formIds['Contact Form Demo'], 'notifications', [
        'name' => 'Admin Notification Email',
        'sendTo' => ['type' => 'email', 'email' => '{wp.admin_email}', 'field' => 'email', 'routing' => []],
        'fromName' => '',
        'fromEmail' => '',
        'replyTo' => '{inputs.email}',
        'bcc' => '',
        'subject' => 'New message: {inputs.subject}',
        'message' => '<p>{all_data}</p><p>Sent from: {embed_post.permalink}</p>',
        'conditionals' => ['status' => false, 'type' => 'all', 'conditions' => []],
        'enabled' => true,
        'email_template' => '',
    ]);
}
if (isset($formIds['Subscription Form'])) {
    $setMeta($formIds['Subscription Form'], 'fluentcrm_feeds', [
        'name' => 'Newsletter',
        'first_name' => '',
        'last_name' => '',
        'full_name' => '',
        'email' => '{inputs.email}',
        'other_fields' => [],
        'company_fields' => [],
        'list_id' => $lists['Newsletter'],
        'tag_ids' => [],
        'tag_ids_selection_type' => 'simple',
        'tag_routers' => [],
        'skip_if_exists' => false,
        'double_opt_in' => true,
        'force_subscribe' => false,
        'skip_primary_data' => false,
        'conditionals' => ['conditions' => [], 'status' => false, 'type' => 'all'],
        'run_events_only' => [],
        'remove_tags' => [],
        'enabled' => true,
    ]);
}

// Fluent Support. Settings → Business: show the owner's booking links inside tickets (FluentBooking).
$support = new \FluentSupport\App\Services\EmailNotification\Settings();
$business = $support->globalBusinessSettings(false);
$business['enable_fluent_booking_integration'] = 'yes';
// The customer portal page its setup would create. The mailbox needs the owner's email, so it's made per store.
$business['portal_page_id'] = wp_insert_post([
    'post_title' => 'Support Portal',
    'post_name' => 'support',
    'post_status' => 'publish',
    'post_type' => 'page',
    'comment_status' => 'closed',
    'ping_status' => 'closed',
    'post_content' => '<!-- wp:shortcode -->[fluent_support_portal]<!-- /wp:shortcode -->',
    // Hidden on site types without Fluent Support (mu-plugins/anypress-store.php).
    'meta_input' => ['_anypress_needs' => 'fluent-support/fluent-support.php'],
]);
$support->save('global_business_settings', $business);

// FluentAffiliate. Integrations → FluentCart on, so referrals are tracked from store orders once the owner opens a
// programme. Same two writes as its integration switch.
\FluentAffiliate\App\Helper\Utility::updateOption('_fluent_cart_connector_config', ['is_enabled' => 'yes']);
$referral = \FluentAffiliate\App\Helper\Utility::getReferralSettings(false);
\FluentAffiliate\App\Helper\Utility::updateReferralSettings([
    'enabled_integrations' => array_values(array_unique(array_merge((array) ($referral['enabled_integrations'] ?? []), ['fluent_cart']))),
]);

// AutomatorWP. Settings: clear its logs after 30 days (they hold form entries and email recipients) and
// hide the Pro suggestions; no review nag.
$merge('automatorwp_settings', ['auto_logs_cleanup_days' => '30', 'disable_pro_recommendations' => 'on']);
update_option('automatorwp_hide_review_notice', 'yes');
// Its tables are only created when wp-admin first loads (admin_init), and a store's cron runs before anyone signs
// in, so its log clean-up failed on a missing table. Create them now, with each table's meta table.
foreach ($GLOBALS['ct_registered_tables'] ?? [] as $table) {
    $table->db->maybe_upgrade();
    $table->meta?->db->maybe_upgrade();
}

// FluentAuth. Saving its settings once is what its first-run wizard does. Its defaults stay (5 failed logins locks
// an address for 30 minutes, a monthly login digest to the admin email); XML-RPC is off, since no store uses it and
// it is the usual target for password guessing. Two-factor stays off for the owner to switch on.
update_option('__fls_auth_settings', array_merge(\FluentAuth\App\Helpers\Helper::getAuthSettings(), ['disable_xmlrpc' => 'yes']));

// Theme (AnyPress). Without a menu the header's navigation lists every page (Receipt, Review Your Order...), so make
// one; the header and footer navigation blocks use the newest menu. Links to pages a site type hides
// (mu-plugins/anypress-store.php) render nothing while those pages are drafts.
$pageId = static fn(string $slug): int => (int) get_page_by_path($slug)?->ID;
$link = static function (string $label, int $id): string {
    $attrs = wp_json_encode(['label' => $label, 'type' => 'page', 'id' => $id, 'url' => get_permalink($id), 'kind' => 'post-type']);
    return "<!-- wp:navigation-link $attrs /-->";
};
$menu = wp_insert_post([
    'post_type' => 'wp_navigation',
    'post_status' => 'publish',
    'post_title' => 'Main menu',
    'post_content' => implode('', [
        $link('Shop', $pageId('shop')),
        $link('Cart', $pageId('cart')),
        $link('Account', $pageId('account')),
        $link('Support', $pageId('support')),
    ]),
], true);
if (is_wp_error($menu)) {
    throw new RuntimeException($menu->get_error_message());
}

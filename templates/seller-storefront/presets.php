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
// (AnyPress Host), so emails carry the owner's brand and nothing of AnyPress.
\FluentCart\App\Services\Email\EmailNotifications::updateSettings([
    'email_footer' => '<p>Questions? Just reply to this email.</p>',
]);
// Settings → Email notifications → Store digest: off (FluentCart's own design and a Pro ad, which settings can't change).
$digest = \FluentCart\App\Services\Email\StoreDigestService::getSettings();
foreach (['daily', 'weekly', 'monthly'] as $cadence) {
    $digest[$cadence]['enabled'] = 'no';
}
\FluentCart\App\Services\Email\StoreDigestService::saveSettings($digest);
// Settings → Email notifications: one email per moment. AnyPress Host's own emails already cover a cancelled plan
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

// FluentCRM. Its setup wizard can send the owner's details to the vendor; what it would ask for is made here. A
// storefront sells one thing, website plans, so the CRM lifecycle plugin calls every offering "Website": a visitor who
// asks a question or leaves checkout is "Website: Interested", a buyer "Website: Active", and when their last plan ends
// "Website: Past". The fields, the contact form's questions and the draft automations come from crm/setup.php.
update_option('anypress_crm_offerings', ['subscription' => 'Website', 'order' => 'Website', 'enquiry' => 'Website']);
fluentcrm_update_option('fluentcrm_setup_wizard_ran', 'yes');
fluentcrm_update_option('_fluentcrm_share_essential', 'no');
$newsletter = \FluentCrm\App\Models\Lists::firstOrCreate(['slug' => 'newsletter'], ['title' => 'Newsletter']);
foreach (['Website: Interested', 'Website: Active', 'Website: Past'] as $title) {
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

// Fluent Forms. Global settings → Security: the honeypot and token checks, off by default. Its contact form (the
// Contact page) emails the owner each message; the newsletter sign-up form it also makes isn't used here.
$forms = get_option('_fluentform_global_form_settings', []);
$forms['misc'] = array_merge($forms['misc'] ?? [], ['honeypotStatus' => 'yes', 'tokenBasedProtectionStatus' => 'yes']);
update_option('_fluentform_global_form_settings', $forms);
foreach (wpFluent()->table('fluentform_forms')->get() as $form) {
    if ($form->title === 'Subscription Form') {
        wpFluent()->table('fluentform_form_meta')->where('form_id', $form->id)->delete();
        wpFluent()->table('fluentform_forms')->where('id', $form->id)->delete();
    } elseif ($form->title === 'Contact Form Demo') {
        wpFluent()->table('fluentform_form_meta')->where('form_id', $form->id)->where('meta_key', 'notifications')->delete();
        wpFluent()->table('fluentform_form_meta')->insert(['form_id' => $form->id, 'meta_key' => 'notifications', 'value' => wp_json_encode([
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
        ])]);
        update_option('anypress_crm_contact_form', (int) $form->id, true);
    }
}

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
    // For a seller who turns "Create contacts" on: new users arrive transactional, not subscribed.
    'default_status' => 'transactional',
    'contact_fields' => $wpfFields,
]);
// Saved as an explicit 0: set_multiple() skips false values, and the settings screen shows an unsaved box as ticked.
wp_fusion()->settings->set('create_users', 0);
(new \WPF_FluentCRM())->sync();

// AnyPress theme. A whole website built from the theme's own sections (the store template's starter-page builders in
// anypress-patterns.php, copied in for the build only), so a new storefront opens finished-looking and the owner
// rewrites it in the Site Editor: Home, How it works, Plans (FluentCart's shop: the website plans AnyPress Host makes),
// About, Questions and Contact, with the contact form.
require __DIR__ . '/anypress-patterns.php';
$pageId = static fn(string $slug): int => (int) get_page_by_path($slug)?->ID;
$account = get_permalink($pageId('account'));
$url = static fn(string $slug): string => home_url("/$slug/");
// FluentCart's shop lists the website plans, so it is called Plans.
wp_update_post(['ID' => $pageId('shop'), 'post_title' => 'Plans', 'post_name' => 'plans']);
$plans = get_permalink($pageId('plans'));
$questions = [
    ['Do I need to know how to build websites?', 'No. Your website comes with pages ready to edit, and you change them with simple blocks.'],
    ['Can I use my own domain?', 'Yes. Every website starts on a free address, and you can connect your own domain from your account.'],
    ['Can I change plans or cancel?', 'Yes. Move to another plan or cancel from your account at any time.'],
    ['What is included?', 'Hosting, security, nightly backups and updates come with every plan.'],
];
$steps = [
    ['1. Pick a plan', 'Choose the plan that fits what your business needs today.'],
    ['2. Check out', 'Pay securely by card. You can cancel at any time.'],
    ['3. Make it yours', 'Sign in to your new website and add your words, photos and logo.'],
];
$pages = [
    'home' => ['Home', anypress_hero(
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
        . anypress_features('How it works', $steps, 'tint')
        . anypress_embed('Plans', '[fluent_cart_products per_page="12" paginator="numbers"]', 'plans')
        . anypress_faq('Questions', $questions)
        . anypress_call_to_action('Ready to get online?', 'Your website can be ready today. Not sure which plan fits? Ask us.', [['See the plans', '#plans'], ['Ask a question', $url('contact')]])],
    'how-it-works' => ['How it works', anypress_hero(
        'From plan to website in minutes',
        'No setup, no installs and nothing to look after. Pick a plan, check out and start making the website your own.',
        [['See the plans', $plans]]
    )
        . anypress_features('Three steps', $steps, 'tint')
        . anypress_features('After you check out', [
            ['Your website is built', 'We make your website straight away and email you when it is ready, usually within a few minutes.'],
            ['You sign in', 'One click from your account takes you into your website, signed in.'],
            ['You make it yours', 'Change the words, photos, colours and logo. Add pages whenever you need them.'],
            ['We look after the rest', 'Hosting, security, backups and updates keep running in the background.'],
        ])
        . anypress_call_to_action('Ready when you are', 'Pick the plan that fits today. You can move to another one at any time.', [['See the plans', $plans]])],
    'about' => ['About', anypress_story('About us', [
        'Say in a sentence or two who you are and who you make websites for.',
        'Tell visitors what you care about getting right for them, and why they can trust you with their website.',
    ])
        . anypress_features('What you can count on', [
            ['A real website from day one', 'Every plan starts with finished pages, not a blank screen.'],
            ['Straight answers', 'Clear prices, no long contracts, and a person to ask when you are stuck.'],
            ['Looked after', 'Hosting, security, backups and updates, all included.'],
        ], 'tint')
        . anypress_call_to_action('We would love to hear from you', '', [['Contact us', $url('contact')]])],
    'questions' => ['Questions', anypress_hero('Questions', 'What people ask most before they pick a plan.', [['Ask us something else', $url('contact')]])
        . anypress_faq('Common questions', array_merge($questions, [
        ['How long does it take?', 'Your website is usually ready a few minutes after you check out. We email you when it is.'],
        ['Is there a contract?', 'No. Plans renew each month or year and you can cancel from your account.'],
        ['Can I get help?', 'Yes. Ask us from your account or through the contact page.'],
    ]))
        . anypress_call_to_action('Still have a question?', 'Ask us and we will get back to you.', [['Contact us', $url('contact')]])],
    'contact' => ['Contact', anypress_hero('Get in touch', 'Ask about the plans, your website or anything else. We will get back to you by email.', [['See the plans', $plans]])
        . anypress_contact_form()],
];
// Who we help: a landing page for each kind of customer the seller's Sales Kit plays to, under one hub page, each
// written in the seller's own voice from the kit's pitch: their problem, the answer, three things they get, the
// questions they ask, then the plans. Sellers delete the ones they don't sell to.
$groups = [
    'shops' => ['Shops and makers', 'Your own shop, on your own domain',
        'Stop paying marketplace fees on every sale. Sell from a shop with your name on it, keep every customer and email them again whenever you like.',
        [
            ['Paid straight to you', 'Checkout uses your own payment account, so the money goes to you, not through a marketplace.'],
            ['Your buyers, your list', 'Every buyer lands in your own email list, with follow-up emails already written.'],
            ['Change it yourself', 'Products, shipping and discounts you can update any time, no developer needed.'],
        ],
        [
            ['I already sell on a marketplace. Do I have to leave?', 'No. Keep it if it works for you. Your own shop sits beside it, and every customer who finds you there is yours to keep.'],
            ['Can I use my own payment account?', 'Yes. You connect the payment account you already use, and payments go straight to it.'],
        ]],
    'specialty' => ['Specialty retailers', 'A shop that stays open',
        'If big platforms have closed your shop or frozen your payments before, sell from your own site on your own domain, with the payment account you choose.',
        [
            ['Bring your own processor', 'Checkout works with the payment account you already have, including processors that accept your industry.'],
            ['Age check and terms', 'Add an age check and your own terms pages, so the shop fits the rules you sell under.'],
            ['Your customers stay yours', 'Your customer list and order history stay with you, with follow-up emails ready to go.'],
        ],
        [
            ['Will my shop be closed without warning?', 'Your shop runs on your own site and domain, so it doesn\'t depend on a marketplace\'s product rules.'],
            ['Which payment processors work?', 'You connect your own account. Ask us about yours before you start and we\'ll tell you how it connects.'],
        ]],
    'courses' => ['Course creators', 'Your courses, community and list in one place',
        'Stop paying for several tools and giving a platform its cut. Teach on a site with your name on it, for one monthly price.',
        [
            ['Courses that track progress', 'Lessons, quizzes and progress for every student.'],
            ['Your own community', 'A members\' area on your own site instead of a separate app.'],
            ['Email from the same place', 'Write to students and new leads without another tool.'],
        ],
        [
            ['Can I move my courses over?', 'Yes. We can help you move your first course in so you can see how it works.'],
            ['Do you take a cut of my sales?', 'No. You pay one monthly price and keep what you sell.'],
        ]],
    'associations' => ['Chambers and associations', 'Members, events and dues on one site',
        'Bring your member directory, event sign-ups and dues together on one site your staff can run, without a developer.',
        [
            ['Member directory', 'Profiles each member can keep up to date themselves.'],
            ['Events with sign-up', 'Members sign up and pay for events online.'],
            ['Dues paid online', 'Renewals paid by card, with reminder emails sent for you.'],
        ],
        [
            ['Can we keep our current domain?', 'Yes. Your site moves to your own domain whenever you are ready.'],
            ['Can our members get websites too?', 'Yes. You can offer every member business its own website as a member benefit.'],
        ]],
    'churches' => ['Churches', 'A church website that runs itself',
        'Events, online giving, small groups and your weekly email on one simple site, and nobody at church has to run the tech.',
        [
            ['Online giving', 'One-time and recurring gifts, paid into your church\'s own account.'],
            ['Events and groups', 'People sign up for events and small groups online.'],
            ['Sermons and a weekly email', 'Post sermons and send your weekly email from the same place.'],
        ],
        [
            ['Who keeps it up to date?', 'Anyone on your team can change the words and photos. We look after hosting, updates and backups.'],
            ['Where does giving go?', 'Straight to your church\'s own payment account.'],
        ]],
    'locations' => ['Franchises and multi-location businesses', 'One look for every location',
        'Give every location the same site, each with its own bookings, hours and domain, all managed from one place.',
        [
            ['New locations in minutes', 'Each new location starts from your brand\'s own design.'],
            ['Bookings per location', 'Every location takes bookings with its own staff and hours.'],
            ['One bill', 'One monthly bill for every location\'s website.'],
        ],
        [
            ['Can each location change its own site?', 'Yes, within your brand. Locations update their hours, staff and offers; the look stays yours.'],
            ['Can every location have its own domain?', 'Yes. Each site can use its own domain or a page of yours.'],
        ]],
    'agencies' => ['Agencies and freelancers', 'Websites for your clients, under your name',
        'Say yes when clients ask for a website. We host, update and back them up; you keep the client and add a monthly line to every invoice.',
        [
            ['Live in minutes', 'Each client site starts from a ready-made design you make their own.'],
            ['Looked after for you', 'Updates, security, backups and support are handled.'],
            ['Your price on top', 'Charge your own price, so every site adds monthly income.'],
        ],
        [
            ['Will my clients see your name?', 'No. Your clients deal with you, and the sites carry your brand.'],
            ['Do I have to look after the sites?', 'No. Hosting, updates and backups are handled. You stay the person your client talks to.'],
        ]],
    'software' => ['Software companies', 'A website for every customer, from inside your product',
        'When a customer signs up, their website is made automatically under your brand, and removed when they leave.',
        [
            ['Made on sign-up', 'Connect our API, Zapier, Make, n8n or HighLevel, and each new customer gets a site.'],
            ['Tidy when they leave', 'Sites are suspended or removed automatically when a customer cancels.'],
            ['One bill', 'One monthly bill for every customer\'s website.'],
        ],
        [
            ['How do we connect it?', 'Through our API, or with Zapier, Make, n8n or HighLevel if you\'d rather not write code.'],
            ['Whose name do customers see?', 'Yours. The websites carry your brand.'],
        ]],
];
$hubSlug = 'who-we-help';
kses_remove_filters();
$made = [];
foreach ($pages as $slug => [$title, $content]) {
    $id = wp_insert_post([
        'post_type' => 'page',
        'post_status' => 'publish',
        'post_title' => $title,
        'post_name' => $slug,
        'comment_status' => 'closed',
        'ping_status' => 'closed',
        'page_template' => 'page-no-title', // each page opens with its own big heading
        'post_content' => $content,
    ], true);
    if (is_wp_error($id)) {
        throw new RuntimeException($id->get_error_message());
    }
    $made[$slug] = $id;
}
$groupLink = static fn(string $slug): string => $url("$hubSlug/$slug");
$hubCards = '';
foreach ($groups as $slug => [$name, , $lead]) {
    $hubCards .= '<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} --><div class="wp-block-group">'
        . '<!-- wp:separator {"className":"is-style-wide"} --><hr class="wp-block-separator has-alpha-channel-opacity is-style-wide"/><!-- /wp:separator -->'
        . '<!-- wp:heading {"level":3,"fontSize":"medium"} --><h3 class="wp-block-heading has-medium-font-size"><a href="' . esc_url($groupLink($slug)) . '">' . esc_html($name) . '</a></h3><!-- /wp:heading -->'
        . '<!-- wp:paragraph {"textColor":"secondary"} --><p class="has-secondary-color has-text-color">' . esc_html($lead) . '</p><!-- /wp:paragraph -->'
        . '</div><!-- /wp:group -->';
}
$hub = wp_insert_post([
    'post_type' => 'page',
    'post_status' => 'publish',
    'post_title' => 'Who we help',
    'post_name' => $hubSlug,
    'comment_status' => 'closed',
    'ping_status' => 'closed',
    'page_template' => 'page-no-title',
    'post_content' => anypress_hero('Who we help', 'Websites made for the way your kind of business works. Pick yours to see what you get.', [['See the plans', $plans], ['Ask a question', $url('contact')]])
        . anypress_section('Features', anypress_titles('Find your kind of business')
            . '<!-- wp:group {"align":"wide","style":{"spacing":{"blockGap":"var:preset|spacing|x-large"}},"layout":{"type":"grid","columnCount":4,"minimumColumnWidth":"15rem"}} --><div class="wp-block-group alignwide">'
            . $hubCards . '</div><!-- /wp:group -->')
        . anypress_call_to_action('Don\'t see yours?', 'Tell us about your business and we\'ll say which plan fits.', [['Contact us', $url('contact')]]),
], true);
if (is_wp_error($hub)) {
    throw new RuntimeException($hub->get_error_message());
}
$made[$hubSlug] = $hub;
foreach ($groups as $slug => [$name, $title, $lead, $points, $asks]) {
    $id = wp_insert_post([
        'post_type' => 'page',
        'post_status' => 'publish',
        'post_title' => $name,
        'post_name' => $slug,
        'post_parent' => $hub,
        'comment_status' => 'closed',
        'ping_status' => 'closed',
        'page_template' => 'page-no-title',
        'post_content' => anypress_hero($title, $lead, [['See the plans', '#plans'], ['Talk to us', $url('contact')]])
            . anypress_features('What you get', $points, 'tint')
            . anypress_features('How it works', $steps)
            . anypress_embed('Plans', '[fluent_cart_products per_page="12" paginator="numbers"]', 'plans', 'tint')
            . anypress_faq('Questions', array_merge($asks, array_slice($questions, 2, 2)))
            . anypress_call_to_action('Ready to get started?', 'Pick a plan, or tell us about your ' . ($slug === 'churches' ? 'church' : 'business') . ' and we\'ll help you choose.', [['See the plans', '#plans'], ['Talk to us', $url('contact')]]),
    ], true);
    if (is_wp_error($id)) {
        throw new RuntimeException($id->get_error_message());
    }
}
kses_init();
update_option('show_on_front', 'page');
update_option('page_on_front', $made['home']);
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
    'post_content' => $link('How it works', $made['how-it-works']) . $link('Who we help', $made[$hubSlug]) . $link('Plans', $pageId('plans')) . $link('About', $made['about'])
        . $link('Questions', $made['questions']) . $link('Contact', $made['contact']) . $link('Account', $pageId('account')),
], true);
if (is_wp_error($menu)) {
    throw new RuntimeException($menu->get_error_message());
}

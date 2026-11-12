<?php
/**
 * The storefront's shop, made once on the template build after presets.php:
 *   wp eval-file shop.php --user=waas-admin
 * with, next to it, anypress-patterns.php, audiences.json, design/ (the shop design from waas-plugins scripts/test-storefront/remote/design, plus this template's
 * brand.json), roles.json (the store template's site types) and pricing.json (the API's price list, src/pricing.ts).
 *
 * 1. The website plans: one FluentCart product per site type and size, monthly and yearly, at the price list's prices,
 *    made by AnyPress Host's own "Create my plans", each with a picture of that kind of site. A storefront made from the
 *    template opens with them published, so its owner never sees an empty Plans page.
 * 2. The shop design: home, plans, a page per plan, cart, checkout, account, header and footer, in the brand.json words.
 * 3. The pages around it, built with the design's builders: About, Questions, Contact, the legal pages the footer and the
 *    checkout's terms box point to, and Who we help with a page per kind of customer (audiences.json).
 */

use AnyPressHost\Commerce\FluentCart\FluentCartStarterPlans;
use AnyPressHost\Features\PluginBootstrap;

require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

$here    = __DIR__;
require_once "$here/anypress-patterns.php";
$pricing = json_decode((string) file_get_contents("$here/pricing.json"), true);
$roles   = json_decode((string) file_get_contents("$here/roles.json"));
if (!is_array($pricing['siteTypes'] ?? null) || !is_object($roles)) {
    throw new RuntimeException('pricing.json or roles.json missing');
}

// 1. Plans. The roles are the store template's site types, as AnyPress Host stores them when it loads them from the API.
update_option(PluginBootstrap::ROLES_WP_OPTION, $roles);
$prices = [];
foreach ($pricing['siteTypes'] as $type) {
    $prices[$type['key']] = (int) round($type['monthly']['small'] * 100);
}
// AnyPress Host stores the price list's Small monthly prices in cents, as it does when it loads them from the API.
update_option(FluentCartStarterPlans::PRICES_OPTION, $prices, false);
// create() reads only FluentCart and the roles; the API client the constructor takes is for loading them, done above.
$made = (new ReflectionClass(FluentCartStarterPlans::class))->newInstanceWithoutConstructor()->create();
update_option(FluentCartStarterPlans::AUTO_DONE_OPTION, 'template', false);
echo "Plans: $made made\n";

// A picture of each kind of site on its plans, from the design's example sites.
$design = json_decode((string) file_get_contents("$here/design/shop.json"), true);
foreach ($design['types'] as $type) {
    $tmp = wp_tempnam($type['image']);
    copy("$here/design/images/{$type['image']}", $tmp);
    $media = media_handle_sideload(['name' => $type['image'], 'tmp_name' => $tmp], 0, $type['name']);
    if (is_wp_error($media)) {
        throw new RuntimeException($media->get_error_message());
    }
    foreach (['small', 'medium', 'large'] as $size) {
        $plan = get_page_by_path("{$type['slug']}-$size", OBJECT, 'fluent-products');
        if ($plan) {
            set_post_thumbnail($plan->ID, $media);
        }
    }
}

// FluentCart's shop lists the website plans, so it is called Plans, at /plans/.
$shopPage = (int) (new \FluentCart\Api\StoreSettings())->get('shop_page_id');
wp_update_post(['ID' => $shopPage, 'post_title' => 'Plans', 'post_name' => 'plans']);

// 2. The shop design, in this template's words (design/brand.json): home, plans, a page per plan, cart, checkout,
// account, header, footer and menu. Its builders (ap_*) make the pages below too, so every page has the same look.
require "$here/design/design.php";

// 3. The pages around the shop, all written, which the owner can reword in the Site Editor.
kses_remove_filters();
$plansUrl = get_permalink($shopPage);
$hero = static fn(string $note, string $title, string $lead, array $buttons = [], string $drawing = '') => ap_band(
    $drawing
        ? ap_columns([
            [ap_p(ap_e($note), ['className' => 'is-style-hand']) . "\n\n" . ap_h(ap_e($title), 1, ['fontSize' => 'xx-large']) . "\n\n" . ap_p(ap_e($lead), ['textColor' => 'secondary', 'fontSize' => 'medium']) . ($buttons ? "\n\n" . ap_buttons($buttons) : ''), '62%'],
            [ap_img(ap_asset("$drawing.svg"), '', '220px', 'anypress-centered'), '38%'],
        ], ['verticalAlignment' => 'center'])
        : ap_group(ap_p(ap_e($note), ['align' => 'center', 'className' => 'is-style-hand']) . "\n\n" . ap_h(ap_e($title), 1, ['textAlign' => 'center', 'fontSize' => 'xx-large']) . "\n\n" . ap_p(ap_e($lead), ['align' => 'center', 'textColor' => 'secondary', 'fontSize' => 'medium']) . ($buttons ? "\n\n" . ap_buttons($buttons, 'center') : ''), ['layout' => ['type' => 'constrained', 'contentSize' => '46rem']]),
    '', '', 'x-large', 'x-large'
);
$cards = static fn(array $items, string $min = '15rem', int $cols = 3) => ap_grid(array_map(
    static fn($i) => ap_card(ap_h(ap_e($i[0]), 3, ['fontSize' => 'medium']) . "\n\n" . ap_p(ap_e($i[1]), ['textColor' => 'secondary']), 'card-line', 'medium'),
    $items
), $min, 'medium', $cols);
$prose = static fn(array $paragraphs) => ap_group(implode("\n\n", array_map(static fn($t) => ap_p($t), $paragraphs)), ['layout' => ['type' => 'constrained', 'contentSize' => '46rem']]);

// About.
ap_page('about', 'About', $hero('About us', 'Websites for small businesses, set up and looked after.', 'You tell us what you need. We set it up, keep it running and answer when you have a question.', [['See the plans', $plansUrl], ['Send us a message', home_url('/contact/'), 'outline']], 'paint')
    . "\n\n" . ap_band($prose([
        'We set up websites for small businesses, and then we look after them. You tell us what you need, a website, bookings, a shop or a members’ area, and it’s ready to use the same day.',
        'Most people don’t want to become a web developer to get online. So we keep the tech out of your way: hosting, security, backups and updates are handled, and when you have a question, a person answers it.',
    ]), '', '', 'large', 'large')
    . "\n\n" . ap_band(ap_head('Why people pick us', 'What you can count on') . "\n\n" . $cards([
        ['A real website from day one', 'Every plan starts with finished pages, not a blank screen.'],
        ['Straight answers', 'Clear prices, no long contracts, and a person to ask when you’re stuck.'],
        ['Looked after', 'Hosting, security, backups and updates, all included.'],
    ]), 'tint')
    . "\n\n" . ap_help_band(), 'page-no-title');

// Questions: the shop's questions and a few more.
ap_page('questions', 'Questions', $hero('Good to know', 'Questions people ask', 'What people ask most before they pick a plan. Can’t find yours? Send us a message.')
    . "\n\n" . ap_faq($ap_data, array_merge($ap_data['faq'], [
        ['Do I need to know how to build websites?', 'No. Your website comes with pages ready to edit, and you change the words and pictures with simple blocks.'],
        ['Is there a contract?', 'No. Plans renew each month or year, and you can cancel from your account.'],
        ['Can I move my current website over?', 'Yes. Send us a message with its address and we’ll tell you how.'],
    ]), 'tint')
    . "\n\n" . ap_help_band(), 'page-no-title');

// Contact, with the contact form that feeds the CRM (crm/setup.php names it).
ap_page('contact', 'Contact', $hero('We read every message', 'Get in touch', 'Ask about the plans, your website or anything else. A person writes back, usually the same business day.', [], 'mailbox')
    . "\n\n" . ap_band(ap_group(anypress_contact_form(), ['layout' => ['type' => 'constrained', 'contentSize' => '46rem']]), 'tint', '', 'large', 'xx-large'), 'page-no-title');

// Legal pages: plain starting points, which the owner checks against their own business before launch.
$contact = home_url('/contact/');
$legal = [
    'terms' => ['Terms of service', [
        'These terms cover the website plans you buy from us. By checking out you agree to them.',
        'Your plan gives you a website that we host, back up and keep up to date for as long as your plan is paid. You own the words, pictures and data you put on it.',
        'Plans renew each month or year until you cancel. You can cancel any time from your account; your website stays online until the end of the period you have paid for.',
        'Please don\'t use your website for anything illegal, for spam, or to harm other people\'s sites. We may pause a website that does, and we\'ll tell you why.',
        'We work hard to keep every website online, but we can\'t promise it will never be down. If something goes wrong, we\'ll fix it as fast as we can.',
        'We may update these terms. If a change matters to you, we\'ll email you before it starts. Questions? <a href="' . esc_url($contact) . '">Send us a message</a>.',
    ]],
    'privacy' => ['Privacy policy', [
        'We collect what we need to sell you a plan and run your website: your name, email address, billing details and the messages you send us.',
        'Card payments are handled by our payment provider; we never see or store your full card number.',
        'We use your details to set up and look after your website, send you receipts and important notices, and answer your questions. If you tick the newsletter box, we also send you news, and every email has an unsubscribe link.',
        'We don\'t sell your details. We share them only with the services that run your website and payments, and only what they need.',
        'You can ask for a copy of your details, or ask us to correct or delete them, at any time: <a href="' . esc_url($contact) . '">send us a message</a>.',
    ]],
    'refund-policy' => ['Refund policy', [
        'You can cancel any plan from your account at any time, and you won\'t be charged again.',
        'Your website stays online until the end of the period you have already paid for.',
        'If something isn\'t right with your first payment, <a href="' . esc_url($contact) . '">send us a message</a> and we\'ll work it out with you.',
    ]],
];
foreach ($legal as $slug => [$title, $paragraphs]) {
    ap_page($slug, $title, $hero('Last updated ' . wp_date('F j, Y'), $title, 'Please read this before you buy a plan.')
        . "\n\n" . ap_band($prose($paragraphs), '', '', 'large', 'xx-large'), 'page-no-title');
}
// The checkout's terms box links to the terms page.
$fields = \FluentCart\App\Services\Renderer\CheckoutFieldsSchema::getFieldsSettings();
$fields['agree_terms']['text'] = 'I agree to the <a href="' . esc_url(home_url('/terms/')) . '" target="_blank">terms of service</a>.';
fluent_cart_update_option('_fc_checkout_fields', $fields);

// Who we help: a hub and a page per kind of customer (audiences.json), each pointing at the plan that fits it.
$audiences = json_decode((string) file_get_contents("$here/audiences.json"), true);
$hub = ap_page('who-we-help', 'Who we help', $hero('Made for your kind of business', 'Who we help', 'Websites set up for the way your business works. Pick yours to see what you get.', [['See the plans', $plansUrl]])
    . "\n\n" . ap_band(ap_grid(array_map(
        static fn($slug, $a) => ap_card(
            ap_img(ap_asset($a['drawing'] . '.svg'), '', '96px') . "\n\n" . ap_h('<a href="' . esc_url(home_url("/who-we-help/$slug/")) . '">' . ap_e($a['name']) . '</a>', 3, ['fontSize' => 'medium']) . "\n\n" . ap_p(ap_e($a['lead']), ['textColor' => 'secondary']),
            'card-line', 'medium', 'anypress-centered'
        ),
        array_keys($audiences), $audiences
    ), '15rem', 'medium', 4), 'tint', 'groups')
    . "\n\n" . ap_help_band(), 'page-no-title');
foreach ($audiences as $slug => $a) {
    $type = $ap_type_by_id[$a['type']];
    $from = $ap_from($a['type']);
    $page = $hero($type['name'] . ' plan', $a['title'], $a['lead'], [['See the ' . $type['short'] . ' plans', $plansUrl . '#' . $type['id']], ['Talk to us', home_url('/contact/'), 'outline']], $a['drawing'])
        . "\n\n" . ap_band(ap_head('What you get', 'Made for ' . lcfirst($a['name'])) . "\n\n" . $cards($a['points']), 'tint')
        . "\n\n" . ap_band(ap_head('The plan that fits', $type['name'] . ($from ? ', from ' . ap_money($from) . ' a month' : ''), $type['pitch']) . "\n\n"
            . ap_group(ap_list(array_map('ap_e', $type['inBox'])), ['layout' => ['type' => 'constrained', 'contentSize' => '30rem']]) . "\n\n"
            . ap_sizes_table($ap_data, $ap_plans, $type['id']), '', 'plan')
        . "\n\n" . ap_faq($ap_data, array_merge($a['questions'], array_slice($ap_data['faq'], 0, 3)), 'tint')
        . "\n\n" . ap_help_band();
    $id = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => $a['name'], 'post_name' => $slug, 'post_parent' => $hub, 'page_template' => 'page-no-title', 'post_content' => wp_slash($page)], true);
    if (is_wp_error($id)) {
        throw new RuntimeException($id->get_error_message());
    }
}

// 4. Help, support, referrals and a call, as on AnyPress's own shop.
// Each is a heading band ($note, $headline, $lead and a drawing) above the plugin's own block, which does the work.
$shortcodePage = static fn(string $slug, string $title, string $note, string $headline, string $lead, string $shortcode, string $drawing) => ap_page(
    $slug,
    $title,
    $hero($note, $headline, $lead, [], $drawing)
        . "\n\n" . ap_band(ap_group("<!-- wp:shortcode -->\n$shortcode\n<!-- /wp:shortcode -->", ['layout' => ['type' => 'constrained', 'contentSize' => '46rem']]), 'tint', '', 'large', 'xx-large'),
    'page-no-title'
);

// Support: Fluent Support's portal, where customers open and follow requests. Its mailbox, under the owner's name and
// email, is made when the storefront first opens (mu-plugins/seller-storefront.php).
$supportPage = $shortcodePage('support', 'Support', 'A person answers', 'Ask for help with your website', 'Sign in with the email address you bought your plan with, then open a request. You can follow it and reply here, and we email you each answer.', '[fluent_support_portal]', 'mailbox');
$supportSettings = new \FluentSupport\App\Services\EmailNotification\Settings();
$supportSettings->save('global_business_settings', ['portal_page_id' => $supportPage] + $supportSettings->globalBusinessSettings(false));

// Referrals: FluentAffiliate's program, sign-up form and dashboard, paying the price list's affiliate share of a new
// customer's first payment, approved by the owner.
$referrals = $shortcodePage('affiliates', 'Referrals', 'Earn by recommending us', 'Refer a business, get paid', 'Earn ' . (int) $pricing['affiliatePercent'] . '% of every new customer’s first payment. Sign up below, or sign in to see your link and earnings.', '[fluent_affiliate_portal]', 'paint');
$utility = '\FluentAffiliate\App\Helper\Utility';
$utility::updateReferralSettings([
    'rate_type' => 'percentage',
    'rate' => (int) $pricing['affiliatePercent'],
    'cookie_duration' => 30,
    'payout_method' => 'paypal',
    'credit_last_referrer' => 'yes',
    'self_referral_disabled' => 'yes',
    'exclude_tax' => 'yes',
    'exclude_discount' => 'yes',
    'dashboard_page_id' => $referrals,
]);
$utility::updateOption('_fluent_cart_connector_config', array_merge((array) $utility::getOption('_fluent_cart_connector_config', []), ['is_enabled' => 'yes']));
$utility::updateOption('_registration_settings', ['enabled' => 'yes', 'require_approval' => 'yes']);

// Book a call: a 30-minute call in FluentBooking, weekdays 9 to 5, made through its own create-calendar route as its
// start screen does it. The template's admin hosts it until the storefront first opens, when it moves to the owner.
$calendarRequest = new WP_REST_Request('POST', '/fluent-booking/v2/calendars');
$calendarRequest->set_body_params(['calendar' => [
    'type' => 'simple',
    'author_timezone' => 'UTC',
    'slot' => [
        'title' => 'Talk to us',
        'duration' => 30,
        'event_type' => 'single',
        'status' => 'active',
        'availability_type' => 'existing_schedule',
        'schedule_type' => 'weekly_schedules',
        'weekly_schedules' => \FluentBooking\App\Services\Helper::getWeeklyScheduleSchema(),
        'location_type' => 'phone_guest',
        'location_settings' => [['type' => 'phone_guest', 'title' => '', 'display_on_booking' => '']],
    ],
]]);
$calendar = rest_do_request($calendarRequest);
$event = \FluentBooking\App\Models\CalendarSlot::query()->orderBy('id', 'desc')->first();
if ($calendar->is_error() || !$event) {
    throw new RuntimeException('FluentBooking call not made: ' . wp_json_encode($calendar->get_data()));
}
$event->description = 'A short call about what you need. We suggest the plan that fits, and answer your questions.';
$event->save();
$shortcodePage('book-a-call', 'Book a call', 'Pick a time that suits you', 'Talk to a person', 'A short call about your business and what you need. We suggest the plan that fits and answer your questions. Nothing is charged.', '[fluent_booking id="' . (int) $event->id . '"]', 'bookings');

// Help pages (BetterDocs): articles for the people who buy a website, in topics, and the questions on the help home.
$help = json_decode((string) file_get_contents("$here/help.json"), true);
$order = 0;
$topicIds = [];
foreach ($help['topics'] as $slug => [$name, $description]) {
    $term = wp_insert_term($name, 'doc_category', ['slug' => $slug, 'description' => $description]);
    if (is_wp_error($term)) {
        throw new RuntimeException($term->get_error_message());
    }
    $topicIds[$slug] = (int) $term['term_id'];
    update_term_meta($topicIds[$slug], 'doc_category_order', ++$order);
}
$blocks = static function (array $body): string {
    $out = [];
    foreach ($body as [$kind, $value]) {
        $out[] = match ($kind) {
            'h' => ap_h($value, 2),
            'p' => ap_p($value),
            'ul' => ap_list($value, ''),
            'ol' => '<!-- wp:list {"ordered":true} -->' . "\n<ol class=\"wp-block-list\">" . implode("\n\n", array_map(static fn($i) => "<!-- wp:list-item -->\n<li>$i</li>\n<!-- /wp:list-item -->", $value)) . "</ol>\n<!-- /wp:list -->",
        };
    }
    return implode("\n\n", $out);
};
foreach ($help['articles'] as $i => $article) {
    // BetterDocs lists a topic's newest article first, so each article is dated a minute before the one above it.
    $date = gmdate('Y-m-d H:i:s', time() - $i * 60);
    $id = wp_insert_post(['post_type' => 'docs', 'post_status' => 'publish', 'post_title' => $article['title'], 'post_name' => $article['slug'], 'menu_order' => $i, 'post_date_gmt' => $date, 'post_date' => get_date_from_gmt($date), 'post_content' => wp_slash($blocks($article['body']))], true);
    if (is_wp_error($id)) {
        throw new RuntimeException($id->get_error_message());
    }
    wp_set_object_terms($id, $topicIds[$article['topic']], 'doc_category');
}
foreach ($help['faq'] as $group => $questions) {
    $term = wp_insert_term($group, 'betterdocs_faq_category');
    if (is_wp_error($term)) {
        throw new RuntimeException($term->get_error_message());
    }
    foreach ($questions as $q => [$question, $answer]) {
        $id = wp_insert_post(['post_type' => 'betterdocs_faq', 'post_status' => 'publish', 'post_title' => $question, 'post_content' => wp_slash(ap_p(ap_e($answer))), 'menu_order' => $q], true);
        if (is_wp_error($id)) {
            throw new RuntimeException($id->get_error_message());
        }
        wp_set_object_terms($id, (int) $term['term_id'], 'betterdocs_faq_category');
        update_post_meta($id, '_betterdocs_faq_scope', 'general');
    }
}
// The help home in the storefront's own words: the design's says the help pages are also about selling websites.
ap_template('wp_template', 'archive-docs', 'Docs', '<!-- wp:template-part {"slug":"header","tagName":"header"} /-->' . "\n\n"
    . '<!-- wp:group {"tagName":"main","style":{"spacing":{"margin":{"top":"0"}}},"layout":{"type":"constrained"}} -->' . "\n" . '<main class="wp-block-group" style="margin-top:0">'
    . ap_band(ap_group(
        ap_p(ap_e('We’re here to help'), ['align' => 'center', 'className' => 'is-style-hand']) . "\n\n"
        . ap_h(ap_e('Help pages'), 1, ['textAlign' => 'center', 'fontSize' => 'xx-large']) . "\n\n"
        . ap_p(ap_e('Short answers about your website and your plan. Search, or pick a topic.'), ['align' => 'center', 'textColor' => 'secondary', 'fontSize' => 'medium']) . "\n\n"
        . '<!-- wp:betterdocs/searchbox {"blockId":"anypress-docs-search"} /-->',
        ['layout' => ['type' => 'constrained', 'contentSize' => '44rem']]
    ), 'tint', '', 'x-large', 'x-large') . "\n\n"
    . ap_band('<!-- wp:betterdocs/categorygrid {"blockId":"anypress-docs-topics"} /-->' . "\n\n" . '<!-- wp:betterdocs/faq {"blockId":"anypress-docs-faq"} /-->', '', 'topics', 'x-large', 'x-large', ['className' => 'anypress-docs', 'layout' => ['type' => 'constrained', 'contentSize' => '72rem']])
    . "\n\n" . ap_help_band()
    . "</main>\n<!-- /wp:group -->\n\n" . '<!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->');
kses_init();

// 5. What else the shop sells and how, as on AnyPress's own shop: the price list's free trial on every plan, an email
// pack and a storage pack for a live website, domains at checkout, and the volume saving.
foreach (\FluentCart\App\Models\ProductVariation::query()->whereIn('post_id', get_posts(['post_type' => 'fluent-products', 'post_status' => 'publish', 'fields' => 'ids', 'numberposts' => -1]))->get() as $variation) {
    $info = (array) $variation->other_info;
    if (($info['payment_type'] ?? '') === 'subscription') {
        $variation->other_info = array_merge($info, ['trial_days' => (int) $pricing['trialDays']]);
        $variation->save();
    }
}
$pack = static function (string $slug, string $title, string $excerpt, int $cents, array $info, array $feed) {
    $result = (new \FluentCart\App\Services\BulkProductInsertService())->insertChunk([[
        '_cid' => $slug,
        'post_title' => $title,
        'post_status' => 'published',
        'post_excerpt' => $excerpt,
        'post_content' => $excerpt,
        'detail' => ['fulfillment_type' => 'digital', 'variation_type' => 'simple_variations'],
        'variants' => [['variation_title' => $title, 'item_price' => $cents, 'other_info' => $info]],
    ]]);
    $id = (int) ($result['created'][0]['id'] ?? 0);
    if (!$id) {
        throw new RuntimeException("$title not made: " . wp_json_encode($result['errors'] ?? $result));
    }
    wp_update_post(['ID' => $id, 'post_name' => $slug]);
    $type = \AnyPressHost\Commerce\FluentCart\AnyPressProvisioningIntegration::class;
    $data = \FluentCart\App\Modules\Integrations\IntegrationHelper::validateAndFormatIntegrationFeedSettings(array_merge([
        'enabled' => 'yes', 'emails_per_pack' => '', 'care_minutes' => '', 'care_answer' => '', 'care_priority' => $type::PRIORITY_NORMAL,
        'care_call_url' => '', 'service_minutes' => '', 'service_care_only' => 'no', 'role' => '', 'group_name' => '', 'size' => '',
        'event_trigger' => $type::DEFAULT_TRIGGERS, 'watch_on_access_revoke' => 'no',
    ], $feed), ['provider' => $type::KEY, 'scope' => 'product', 'product_id' => $id, 'integration_id' => null]);
    if (is_wp_error($data)) {
        throw new RuntimeException($data->get_error_message());
    }
    \FluentCart\App\Models\ProductMeta::create(['object_id' => $id, 'object_type' => 'product_integration', 'meta_key' => $type::KEY, 'meta_value' => $data]);
};
$emails = (int) $pricing['packs']['email']['emails'];
$pack('email-pack-' . $emails, number_format($emails) . ' more emails', 'Adds ' . number_format($emails) . ' emails to one website. They never expire, and are used once the month’s included emails run out.', (int) round($pricing['packs']['email']['price'] * 100), ['payment_type' => 'onetime'], ['name' => 'Email pack', 'product_type' => 'email_pack', 'emails_per_pack' => (string) $emails]);
$gb = (int) $pricing['packs']['storage']['gb'];
$pack("$gb-gb-more-storage", "$gb GB more storage", "Adds $gb GB of storage to one website, every month until you cancel. Add more than one for more room.", (int) round($pricing['packs']['storage']['monthly'] * 100), ['payment_type' => 'subscription', 'repeat_interval' => 'monthly', 'times' => '', 'trial_days' => 0, 'manage_setup_fee' => 'no'], ['name' => 'Storage pack', 'product_type' => 'storage_pack']);
// Customers buy the packs from their website's card in the account (AnyPress Host links them there).
update_option(\AnyPressHost\Commerce\FluentCart\FluentCartDomains::ENABLED_OPTION, 'on');
update_option(\AnyPressHost\Features\VolumeDiscount::ENABLED_OPTION, 'on');
echo "Help: " . count($help['articles']) . " articles; support, referrals and a call; packs, trial, domains and volume saving on\n";

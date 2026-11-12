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
kses_init();

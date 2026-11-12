<?php
/**
 * The storefront's pages, in the shop design: home, plans, a page per plan, cart, checkout, account, header, footer and
 * menu (design/design.php, from waas-plugins scripts/test-storefront/remote/design), then About, Questions, Contact,
 * the legal pages, Who we help with a page per kind of customer (audiences.json), Support, Referrals, Book a call and
 * the help pages' home, all in brand.json's words, which the owner can reword in the Site Editor.
 *
 * shop.php runs it on the template build. The storefront runs it again once, on its first visit
 * (mu-plugins/seller-storefront.php), when the seller's application said which site types they sell and which kinds of
 * customers they serve (the option anypress_storefront_setup, JSON: siteTypes and audiences, each null for all): the
 * shop then shows only those plans and Who we help pages, and the others are taken off as drafts.
 *
 * Next to it: anypress-patterns.php, audiences.json, brand.json and design/.
 */

defined('ABSPATH') || exit;

require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

$here = __DIR__;
require_once "$here/anypress-patterns.php";
$setup = json_decode((string) get_option('anypress_storefront_setup', ''), true);
$keepTypes = is_array($setup['siteTypes'] ?? null) ? $setup['siteTypes'] : null;
$keepAudiences = is_array($setup['audiences'] ?? null) ? $setup['audiences'] : null;

// The design's words: brand.json, with only the kinds of site this storefront sells, and no Who we help links when no
// kind of customer it serves has a page.
$brand = json_decode((string) file_get_contents("$here/brand.json"), true);
$shopTypes = json_decode((string) file_get_contents("$here/design/shop.json"), true)['types'];
$types = array_values(array_filter($shopTypes, static fn($t) => $keepTypes === null || in_array($t['slug'], $keepTypes, true)));
if ($keepTypes !== null) {
    $brand['data']['types'] = $types;
}
$typeIds = array_column($types, 'id');
$audienceList = json_decode((string) file_get_contents("$here/audiences.json"), true);
$served = array_filter($audienceList, static fn($a, $slug) => in_array($a['type'], $typeIds, true) && ($keepAudiences === null || in_array($slug, $keepAudiences, true)), ARRAY_FILTER_USE_BOTH);
if (!$served) {
    $notWho = static fn($link) => !str_contains($link[1], 'who-we-help');
    $brand['menu'] = array_values(array_filter($brand['menu'], $notWho));
    $brand['footerMore'][1] = array_values(array_filter($brand['footerMore'][1], $notWho));
}
file_put_contents("$here/design/brand.json", wp_json_encode($brand, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

// Plans of the kinds it doesn't sell come off the shop as drafts; the seller can publish them again in FluentCart.
foreach ($shopTypes as $t) {
    if (!in_array($t['id'], $typeIds, true)) {
        foreach (['small', 'medium', 'large'] as $size) {
            $plan = get_page_by_path("{$t['slug']}-$size", OBJECT, 'fluent-products');
            if ($plan && $plan->post_status === 'publish') {
                wp_update_post(['ID' => $plan->ID, 'post_status' => 'draft']);
            }
        }
    }
}

// FluentCart's shop lists the website plans, so it is called Plans, at /plans/.
$shopPage = (int) (new \FluentCart\Api\StoreSettings())->get('shop_page_id');
wp_update_post(['ID' => $shopPage, 'post_title' => 'Plans', 'post_name' => 'plans']);

// The shop design, in this template's words (design/brand.json): home, plans, a page per plan, cart, checkout,
// account, header, footer and menu. Its builders (ap_*) make the pages below too, so every page has the same look.
require "$here/design/design.php";
// The design counts five kinds of website; a storefront that sells fewer says how many it has.
if (count($types) < count($shopTypes)) {
    $kinds = ['One kind', 'Two kinds', 'Three kinds', 'Four kinds'][count($types) - 1] ?? 'Five kinds';
    foreach ([get_option('page_on_front'), $ap_plans_page] as $pageId) {
        $content = str_replace(
            ['Five kinds of website.', 'Five kinds, three sizes', '"columnCount":5'],
            [count($types) === 1 ? 'One kind of website.' : "$kinds of website.", "$kinds, three sizes", '"columnCount":' . count($types)],
            (string) get_post_field('post_content', (int) $pageId)
        );
        wp_update_post(['ID' => (int) $pageId, 'post_content' => wp_slash($content)]);
    }
}

// The pages around the shop, all written, which the owner can reword in the Site Editor.
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
        'Most people don’t want to become a web developer to get online. So we keep the tech out of your way: hosting, security, backups and updates are handled, and when you have a question, we answer it.',
    ]), '', '', 'large', 'large')
    . "\n\n" . ap_band(ap_head('Why choose us', 'What you get with us') . "\n\n" . $cards([
        ['A real website from day one', 'Every plan starts with finished pages, not a blank screen.'],
        ['Straight answers', 'Clear prices, no long contracts, and help when you’re stuck.'],
        ['Looked after', 'Hosting, security, backups and updates, all included.'],
    ]), 'tint')
    . "\n\n" . ap_help_band(), 'page-no-title');

// Questions: the shop's questions and a few more.
ap_page('questions', 'Questions', $hero('Questions', 'Frequently asked questions', 'What people ask most before they pick a plan. Can’t find yours? Send us a message.')
    . "\n\n" . ap_faq($ap_data, array_merge($ap_data['faq'], [
        ['Do I need to know how to build websites?', 'No. Your website comes with pages ready to edit, and you change the words and pictures with simple blocks.'],
        ['Is there a contract?', 'No. Plans renew each month or year, and you can cancel from your account.'],
        ['Can I move my current website over?', 'Yes. Send us a message with its address and we’ll tell you how.'],
    ]), 'tint')
    . "\n\n" . ap_help_band(), 'page-no-title');

// Contact, with the contact form that feeds the CRM (crm/setup.php names it).
ap_page('contact', 'Contact', $hero('Contact us', 'Get in touch', 'Ask about the plans, your website or anything else. We usually reply the same business day.', [], 'mailbox')
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
$audiences = array_filter(
    $audienceList,
    static fn($a, $slug) => isset($ap_type_by_id[$a['type']]) && ($keepAudiences === null || in_array($slug, $keepAudiences, true)),
    ARRAY_FILTER_USE_BOTH
);
// No kind of customer fits: no Who we help pages (the menu and footer already leave them out).
if (!$audiences) {
    foreach (get_posts(['post_type' => 'page', 'name' => 'who-we-help', 'post_status' => 'any', 'numberposts' => 1]) as $old) {
        foreach (array_merge([$old->ID], get_children(['post_parent' => $old->ID, 'post_type' => 'page', 'fields' => 'ids'])) as $id) {
            wp_update_post(['ID' => $id, 'post_status' => 'draft']);
        }
    }
} else {
$hub = ap_page('who-we-help', 'Who we help', $hero('Who we help', 'Websites for your kind of business', 'Pick your kind of business to see what your website comes with.', [['See the plans', $plansUrl]])
    . "\n\n" . ap_band(ap_grid(array_map(
        static fn($slug, $a) => ap_card(
            ap_img(ap_asset($a['drawing'] . '.svg'), '', '96px') . "\n\n" . ap_h('<a href="' . esc_url(home_url("/who-we-help/$slug/")) . '">' . ap_e($a['name']) . '</a>', 3, ['fontSize' => 'medium']) . "\n\n" . ap_p(ap_e($a['lead']), ['textColor' => 'secondary']),
            'card-line', 'medium', 'anypress-centered'
        ),
        array_keys($audiences), $audiences
    ), '15rem', 'medium', 4), 'tint', 'groups')
    . "\n\n" . ap_help_band(), 'page-no-title');
// The kinds of customers this storefront doesn't serve, first: it's quick, and the pages below take longer.
foreach (get_children(['post_parent' => $hub, 'post_type' => 'page', 'post_status' => 'publish']) as $child) {
    if (!isset($audiences[$child->post_name])) {
        wp_update_post(['ID' => $child->ID, 'post_status' => 'draft']);
    }
}
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
    $old = get_posts(['post_type' => 'page', 'name' => $slug, 'post_parent' => $hub, 'post_status' => 'any', 'numberposts' => 1, 'fields' => 'ids']);
    $id = wp_insert_post(['ID' => $old[0] ?? 0, 'post_type' => 'page', 'post_status' => 'publish', 'post_title' => $a['name'], 'post_name' => $slug, 'post_parent' => $hub, 'page_template' => 'page-no-title', 'post_content' => wp_slash($page)], true);
    if (is_wp_error($id)) {
        throw new RuntimeException($id->get_error_message());
    }
}
}

// Website care: AnyPress Host's care packages and one-time services (shop.php makes them), at their prices in FluentCart.
$careItems = [];
foreach (['care', 'care-plus', 'care-pro', 'set-up-my-site', 'move-my-site-in', 'one-hour'] as $slug) {
    $product = get_page_by_path($slug, OBJECT, 'fluent-products');
    $price = $product ? \FluentCart\App\Models\ProductVariation::query()->where('post_id', $product->ID)->min('item_price') : null;
    if ($product && $product->post_status === 'publish' && $price !== null) {
        $careItems[$slug] = [$product, (int) $price];
    }
}
$careCards = static fn(array $slugs, string $per) => ap_grid(array_map(
    static fn($slug) => ap_card(
        ap_h(ap_e($careItems[$slug][0]->post_title), 3, ['fontSize' => 'medium']) . "\n\n"
        . ap_p('<strong>' . ap_money($careItems[$slug][1]) . '</strong>' . $per) . "\n\n"
        . ap_p(ap_e($careItems[$slug][0]->post_excerpt), ['textColor' => 'secondary']) . "\n\n"
        . ap_buttons([[$per === ' a month' ? 'Choose ' . $careItems[$slug][0]->post_title : 'Buy', get_permalink($careItems[$slug][0])]]),
        'card-line', 'medium'
    ),
    array_values(array_filter($slugs, static fn($slug) => isset($careItems[$slug])))
), '15rem', 'medium', 3);
if (isset($careItems['care'])) {
    ap_page('website-care', 'Website care', $hero('Website care', 'Changes to your website, done for you', 'Add a care package to any website and send us the changes you want: new pages, products, courses or fixes. Pay yearly and get two months free.', [['See the care packages', '#packages']], 'paint')
        . "\n\n" . ap_band(ap_head('Monthly packages', 'Pick how much help you need') . "\n\n" . $careCards(['care', 'care-plus', 'care-pro'], ' a month'), 'tint', 'packages')
        . "\n\n" . ap_band(ap_head('One-time services', 'Or pay once for a single job') . "\n\n" . $careCards(['set-up-my-site', 'move-my-site-in', 'one-hour'], ' once'))
        . "\n\n" . ap_band(ap_head('How it works', 'Ask for a change, we make it') . "\n\n" . $cards([
            ['Add care to your website', 'Choose a package, then pick the website it’s for at checkout or from your account.'],
            ['Send your request', 'Open a request on the Support page and tell us what you’d like changed.'],
            ['We make the change', 'We let you know when it’s done and show the time used in your account.'],
        ]), 'tint')
        . "\n\n" . ap_help_band(), 'page-no-title');
} else {
    foreach (get_posts(['post_type' => 'page', 'name' => 'website-care', 'post_status' => 'publish', 'numberposts' => 1]) as $old) {
        wp_update_post(['ID' => $old->ID, 'post_status' => 'draft']);
    }
}

// Help, support, referrals and a call.
// Each is a heading band ($note, $headline, $lead and a drawing) above the plugin's own block, which does the work.
$shortcodePage = static fn(string $slug, string $title, string $note, string $headline, string $lead, string $shortcode, string $drawing) => ap_page(
    $slug,
    $title,
    $hero($note, $headline, $lead, [], $drawing)
        . "\n\n" . ap_band(ap_group("<!-- wp:shortcode -->\n$shortcode\n<!-- /wp:shortcode -->", ['layout' => ['type' => 'constrained', 'contentSize' => '46rem']]), 'tint', '', 'large', 'xx-large'),
    'page-no-title'
);

// Support: Fluent Support's portal, where customers open and follow requests.
$shortcodePage('support', 'Support', 'Support', 'Get help with your website', 'Sign in with the email address you bought your plan with, then open a request. You can follow it and reply here, and we email you each answer.', '[fluent_support_portal]', 'mailbox');

// Referrals: FluentAffiliate's sign-up form and dashboard, at its rate (shop.php sets the program up).
$shortcodePage('affiliates', 'Referrals', 'Referral program', 'Refer a business and earn', 'Earn ' . (int) \FluentAffiliate\App\Helper\Utility::getReferralSetting('rate', 30) . '% of every new customer’s first payment. Sign up below, or sign in to see your link and earnings.', '[fluent_affiliate_portal]', 'paint');

// Book a call: FluentBooking's call (shop.php makes it).
$event = \FluentBooking\App\Models\CalendarSlot::query()->orderBy('id')->first();
if ($event) {
    $shortcodePage('book-a-call', 'Book a call', 'Book a call', 'Talk to us about your website', 'A short call about your business and what you need. We suggest the plan that fits and answer your questions. Nothing is charged.', '[fluent_booking id="' . (int) $event->id . '"]', 'bookings');
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

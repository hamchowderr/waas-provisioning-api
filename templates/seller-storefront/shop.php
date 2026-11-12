<?php
/**
 * The storefront's shop, made once on the template build after presets.php:
 *   wp eval-file shop.php --user=waas-admin
 * with, next to it, pages.php and what it needs (anypress-patterns.php, audiences.json, brand.json, design/: the shop
 * design from waas-plugins scripts/test-storefront/remote/design), help.json, roles.json (the store template's site
 * types) and pricing.json (the API's price list, src/pricing.ts).
 *
 * 1. The website plans: one FluentCart product per site type and size, monthly and yearly, at the price list's prices,
 *    made by AnyPress Host's own "Create my plans", each with a picture of that kind of site. A storefront made from the
 *    template opens with them published, so its owner never sees an empty Plans page.
 * 2. The programs behind the pages: FluentAffiliate's referral program and a FluentBooking call, then what else the shop
 *    sells: the free trial, the email and storage packs, domains, the volume saving, and AnyPress Host's care packages
 *    and one-time services. All of it comes before the pages, which show the packs and care.
 * 3. The pages, in the shop design (pages.php, which the storefront runs again on its first visit to narrow the shop to
 *    what the seller sells), Fluent Support's portal, and the help pages' articles and questions (help.json).
 */

use AnyPressHost\Commerce\FluentCart\FluentCartStarterPlans;
use AnyPressHost\Features\PluginBootstrap;

require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

$here    = __DIR__;
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

// 2. The programs behind the pages.
// Referrals: FluentAffiliate's program, paying the price list's affiliate share of a new
// customer's first payment, approved by the owner.
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

// What else the shop sells and how, as on AnyPress's own shop: the price list's free trial on every plan, an email
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

// Care: AnyPress Host's care packages and one-time services, at the price list's prices, on sale under the owner's name.
// Customers add care from a plan's page or their website's card; requests arrive in Fluent Support.
add_filter('anypress_care_products', static function (array $products) use ($pricing): array {
    foreach (array_merge($pricing['care']['packages'], $pricing['care']['services']) as $item) {
        if (isset($products[$item['key']])) {
            $products[$item['key']][1] = (int) round(($item['monthly'] ?? $item['price']) * 100);
        }
    }
    return $products;
});
$care = new \AnyPressHost\Commerce\FluentCart\FluentCartCareProducts();
if (!$care::exist() && $care->create() !== count($care::catalogue())) {
    throw new RuntimeException('care products not all made');
}
foreach (array_keys($care::catalogue()) as $slug) {
    $product = get_page_by_path($slug, OBJECT, 'fluent-products');
    if ($product) {
        wp_update_post(['ID' => $product->ID, 'post_status' => 'publish']);
    }
}
// 3. The pages (pages.php), then the programs pointed at theirs.
require "$here/pages.php";
$supportSettings = new \FluentSupport\App\Services\EmailNotification\Settings();
$supportSettings->save('global_business_settings', ['portal_page_id' => get_page_by_path('support')->ID] + $supportSettings->globalBusinessSettings(false));
\FluentAffiliate\App\Helper\Utility::updateReferralSettings(['dashboard_page_id' => get_page_by_path('affiliates')->ID] + \FluentAffiliate\App\Helper\Utility::getReferralSettings(false));

kses_remove_filters();
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
kses_init();

echo "Help: " . count($help['articles']) . " articles; support, referrals and a call; care, packs, trial, domains and volume saving on\n";

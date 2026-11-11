<?php
/**
 * FluentCart. A shop: its own sample catalogue in four categories at real prices, a subscription and a gift card,
 * coupons, six months of orders (regulars who come back, two refunds, the newest still shipping or waiting for
 * payment) from customers with addresses, three pieces on sale, one nearly sold out and one sold out, and shipping and
 * sales tax set up. A business that sells its own vouchers, packs, memberships or a course: those, with months of
 * orders and subscriptions. Payments stay in test mode.
 */
use FluentCart\App\Models\ProductVariation;

require_once ANYPRESS_SAMPLE . '/cart.php';

$shop = $sample['shop'];
// The shop's name on receipts and order emails.
(new \FluentCart\Api\StoreSettings())->set('store_name', $sample['business']['name']);

$before = get_posts(['post_type' => 'fluent-products', 'numberposts' => -1, 'fields' => 'ids', 'post_status' => 'any']);
foreach ($shop['products'] ?? [] as [$set, $count]) {
    for ($i = 0; $i < $count; $i++) {
        \FluentCart\App\Services\Async\DummyProductService::create($set, $i);
    }
}
$mark = static function (string $what) {
    static $t;
    if (getenv('ANYPRESS_SAMPLE_TIMING')) {
        printf("  shop %s %.1fs\n", $what, microtime(true) - ($t ?: $t = microtime(true)));
    }
    $t = microtime(true);
};
$mark('catalogue');
$products = array_values(array_diff(
    get_posts(['post_type' => 'fluent-products', 'numberposts' => -1, 'fields' => 'ids', 'post_status' => 'any', 'orderby' => 'ID', 'order' => 'ASC']),
    $before
));

// Real prices (the sample catalogue's are placeholders), three items on sale, and categories a shopper would expect.
$prices = ['hoodie' => 5800, 'sweatshirt' => 4800, 't-shirt' => 2400, 'cap' => 2200, 'jacket' => 8900, 'jeans' => 6800, 'dress' => 7200, 'sweater' => 6400, 'leggings' => 3800, 'shorts' => 3200, 'nightgown' => 4800];
foreach ($products as $n => $postId) {
    $title = strtolower(get_the_title($postId));
    $price = 4500;
    foreach ($prices as $word => $cents) {
        if (strpos($title, $word) !== false) {
            $price = $cents;
        }
    }
    // In cents, as FluentCart keeps prices; one product per update, as its bulk editor sends them.
    $updates = [];
    foreach (ProductVariation::where('post_id', $postId)->get() as $v => $variation) {
        $updates[] = ['id' => $variation->id, 'item_price' => $price + $v * 200, 'compare_price' => in_array($n, [2, 6, 9], true) ? $price + 2000 : null];
    }
    anypress_sample_api('POST', '/fluent-cart/v2/products/variants/bulk-update', ['updates' => $updates]);
    foreach ($shop['categories'] ?? [] as $category => $words) {
        foreach ($words as $word) {
            if (strpos($title, $word) !== false) {
                wp_set_object_terms($postId, [$category], 'product-categories', false);
                break 2;
            }
        }
    }
}
$mark('prices');

// The business's own products: subscriptions and things sent by email (gift cards, vouchers, packs, a course).
$extra = [];
foreach ($shop['items'] as $i => [$title, $about, $cents, $bills, $photoFile, $category]) {
    $info = $bills === 'once' ? ['payment_type' => 'onetime'] : ['payment_type' => 'subscription', 'repeat_interval' => $bills === 'year' ? 'yearly' : 'monthly'];
    $made = (new \FluentCart\App\Services\BulkProductInsertService())->insertChunk([[
        '_cid' => 'item' . $i,
        'post_title' => $title,
        'post_excerpt' => $about,
        'post_content' => $about,
        'post_status' => 'published',
        'detail' => ['fulfillment_type' => $bills === 'month' && !empty($shop['products']) ? 'physical' : 'digital', 'variation_type' => 'simple'],
        'variants' => [['item_price' => $cents, 'other_info' => $info]],
    ]]);
    $id = (int) ($made['created'][0]['id'] ?? 0);
    if (!$id) {
        continue;
    }
    $extra[$i] = $id;
    wp_set_object_terms($id, [$category], 'product-categories', false);
    $photo = anypress_sample_image($photoFile, $id, $title);
    if ($photo) {
        set_post_thumbnail($id, $photo);
        update_post_meta($id, 'fluent-products-gallery-image', [['id' => $photo, 'url' => wp_get_attachment_url($photo), 'title' => $title]]);
    }
}

// A photo for what the sample catalogue leaves without one (its plain t-shirt), so the shop has no empty boxes.
$missing = ['t-shirt' => 'online-store/14.webp'];
foreach ($products as $postId) {
    if (get_post_thumbnail_id($postId)) {
        continue;
    }
    foreach ($missing as $word => $file) {
        if (str_contains(strtolower(get_the_title($postId)), $word)) {
            $photo = anypress_sample_image($file, $postId, get_the_title($postId));
            if ($photo) {
                set_post_thumbnail($postId, $photo);
                update_post_meta($postId, 'fluent-products-gallery-image', [['id' => $photo, 'url' => wp_get_attachment_url($photo), 'title' => get_the_title($postId)]]);
            }
            break;
        }
    }
}

foreach ($shop['coupons'] as [$title, $code, $kind, $amount, $note]) {
    anypress_sample_api('POST', '/fluent-cart/v2/coupons', [
        'title' => $title, 'code' => $code, 'type' => $kind, 'amount' => $amount, 'status' => 'active',
        'stackable' => 'no', 'show_on_checkout' => 'no', 'notes' => $note,
    ]);
}

$variants = [];
// Orders pick from the sample catalogue, or from the business's own one-off products when it has no catalogue.
foreach ($products ?: $extra as $postId) {
    $variants[] = ProductVariation::where('post_id', $postId)->first();
}
// Every order oldest first, Sock club sign-ups among them, so order numbers follow the dates.
$plans = array_values(array_filter(array_map(
    static fn ($i) => $shop['items'][$i][3] !== 'once' ? ProductVariation::where('post_id', $extra[$i])->first() : null,
    array_keys($extra)
)));
$subscription = $plans[0] ?? null;
$queue = [];
foreach ($shop['orders'] as $n => [$who, $daysAgo, $lines, $outcome]) {
    $pool = $products ? $variants : array_values(array_filter($variants, static fn ($v) => $v && $v->payment_type !== 'subscription'));
    $picked = $pool ? array_map(static fn ($l) => [$pool[$l[0] % count($pool)], $l[1]], $lines) : [];
    $queue[] = [$who, $n, $picked, $daysAgo, $outcome];
}
// Subscribers through the months, taking turns between the plans (monthly, yearly).
foreach ($subscription ? $shop['subscribers'] : [] as $n => $who) {
    $queue[] = [$who, 20 + $n, [[$plans[$n % count($plans)], 1]], round(160 - $n * (150 / max(1, count($shop['subscribers']))), 1), 'paid'];
}
usort($queue, static fn ($a, $b) => $b[3] <=> $a[3]);
foreach ($queue as [$who, $n, $picked, $daysAgo, $outcome]) {
    $customer = anypress_sample_customer($sample['people'][$who], $n);
    if ($customer && $picked) {
        anypress_sample_order($customer, $picked, $daysAgo, $outcome);
    }
}
anypress_sample_orders_done();
$mark('orders');

if (!$products) {
    return;
}
// Stock counted on two pieces: one nearly gone, one sold out. Turned on after the orders, so none were refused.
$all = \FluentCart\Api\ModuleSettings::getAllSettings(false);
$all['stock_management'] = ['active' => 'yes'] + (array) ($all['stock_management'] ?? []);
anypress_sample_api('POST', '/fluent-cart/v2/settings/modules', $all);
\FluentCart\Api\ModuleSettings::getAllSettings(false);
foreach ([[1, 3], [4, 0]] as [$n, $left]) {
    $variant = $variants[$n] ?? null;
    if ($variant) {
        anypress_sample_api('PUT', "/fluent-cart/v2/products/{$variant->post_id}/update-manage-stock", ['manage_stock' => 1]);
        foreach (ProductVariation::where('post_id', $variant->post_id)->get() as $v) {
            anypress_sample_api('PUT', "/fluent-cart/v2/products/{$variant->post_id}/update-inventory/{$v->id}", ['total_stock' => 24 + $left, 'available' => $left]);
        }
    }
}

// Shipping across the US (standard, express and pick-up) and sales tax, as a shop sets them up before launch.
[, $zone] = anypress_sample_api('POST', '/fluent-cart/v2/shipping/zones', ['name' => 'United States', 'region' => 'US']);
$zoneId = (int) ($zone['shipping_zone']['id'] ?? 0);
foreach ($zoneId ? [['Standard (3 to 5 days)', 'flat_rate', '8'], ['Express (1 to 2 days)', 'flat_rate', '18'], ['Pick up from the studio', 'local_pickup', '0']] : [] as [$title, $kind, $amount]) {
    anypress_sample_api('POST', '/fluent-cart/v2/shipping/methods', ['zone_id' => $zoneId, 'title' => $title, 'type' => $kind, 'amount' => $amount, 'settings' => ['configure_rate' => 'per_order'], 'is_enabled' => 1]);
}
anypress_sample_api('POST', '/fluent-cart/v2/onboarding/save-tax', ['enable_tax' => 'yes', 'tax_inclusion' => 'excluded']);
anypress_sample_api('POST', '/fluent-cart/v2/tax/country/rate', ['country' => 'US', 'rate' => 7.25, 'name' => 'Sales tax', 'priority' => 1, 'for_shipping' => 1]);
anypress_sample_api('POST', '/fluent-cart/v2/tax/country/rate', ['country' => 'US', 'state' => 'OR', 'rate' => 0, 'name' => 'Oregon (no sales tax)', 'priority' => 1]);
$mark('stock, shipping and tax');

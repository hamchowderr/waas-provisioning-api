<?php
/**
 * FluentCart: its own sample catalogue in four categories at real prices, a subscription and a gift card, two
 * coupons, six months of orders (regulars who come back, two refunds, the newest still shipping or waiting for
 * payment) from customers with addresses, three pieces on sale, one nearly sold out and one sold out, and shipping and
 * sales tax set up. Payments stay in test mode.
 */
use FluentCart\Api\Resource\CustomerResource;
use FluentCart\Api\Resource\OrderResource;
use FluentCart\App\Models\Customer;
use FluentCart\App\Models\Order;
use FluentCart\App\Models\ProductVariation;

$shop = $sample['shop'];
// The shop's name on receipts and order emails.
(new \FluentCart\Api\StoreSettings())->set('store_name', $sample['business']['name']);

$before = get_posts(['post_type' => 'fluent-products', 'numberposts' => -1, 'fields' => 'ids', 'post_status' => 'any']);
foreach ($shop['products'] as [$set, $count]) {
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
    foreach ($shop['categories'] as $category => $words) {
        foreach ($words as $word) {
            if (strpos($title, $word) !== false) {
                wp_set_object_terms($postId, [$category], 'product-categories', false);
                break 2;
            }
        }
    }
}
$mark('prices');

// A monthly subscription and a digital gift card.
$extra = [];
foreach (['subscription' => ['physical', ['payment_type' => 'subscription', 'repeat_interval' => 'monthly']], 'gift' => ['digital', ['payment_type' => 'onetime']]] as $key => [$fulfillment, $info]) {
    [$title, $about, $cents] = $shop[$key];
    $made = (new \FluentCart\App\Services\BulkProductInsertService())->insertChunk([[
        '_cid' => $key,
        'post_title' => $title,
        'post_excerpt' => $about,
        'post_content' => $about,
        'post_status' => 'published',
        'detail' => ['fulfillment_type' => $fulfillment, 'variation_type' => 'simple'],
        'variants' => [['item_price' => $cents, 'other_info' => $info]],
    ]]);
    $extra[$key] = (int) ($made['created'][0]['id'] ?? 0);
    if ($extra[$key]) {
        wp_set_object_terms($extra[$key], ['Accessories'], 'product-categories', false);
    }
}

foreach ($shop['coupons'] as [$title, $code, $kind, $amount, $note]) {
    anypress_sample_api('POST', '/fluent-cart/v2/coupons', [
        'title' => $title, 'code' => $code, 'type' => $kind, 'amount' => $amount, 'status' => 'active',
        'stackable' => 'no', 'show_on_checkout' => 'no', 'notes' => $note,
    ]);
}

$states = ['Portland' => 'OR', 'Atlanta' => 'GA', 'Austin' => 'TX', 'Boston' => 'MA', 'Chicago' => 'IL', 'Denver' => 'CO', 'Seattle' => 'WA', 'New Orleans' => 'LA', 'Minneapolis' => 'MN', 'Detroit' => 'MI', 'San Diego' => 'CA', 'Nashville' => 'TN', 'San Jose' => 'CA', 'Miami' => 'FL', 'Phoenix' => 'AZ', 'Columbus' => 'OH', 'Pittsburgh' => 'PA', 'Philadelphia' => 'PA', 'Houston' => 'TX', 'Raleigh' => 'NC', 'Sacramento' => 'CA', 'Honolulu' => 'HI', 'Dallas' => 'TX', 'Kansas City' => 'MO'];

/** The shop's customer for a sample person, with a billing and shipping address. */
$customerFor = static function (array $p, int $n) use ($states): ?Customer {
    $customer = Customer::where('email', anypress_sample_email($p))->first();
    if (!$customer) {
        CustomerResource::create(['email' => anypress_sample_email($p), 'full_name' => $p[0] . ' ' . $p[1], 'first_name' => $p[0], 'last_name' => $p[1]]);
        $customer = Customer::where('email', anypress_sample_email($p))->first();
    }
    if ($customer && !$customer->primary_billing_address) {
        foreach (['billing', 'shipping'] as $kind) {
            anypress_sample_api('POST', "/fluent-cart/v2/customers/{$customer->id}/address", [
                'type' => $kind, 'is_primary' => 1, 'label' => 'Home', 'name' => "$p[0] $p[1]", 'email' => anypress_sample_email($p),
                'address_1' => (100 + $n * 17) . ' Oak Street', 'city' => $p[2], 'state' => $states[$p[2]] ?? 'CA', 'postcode' => (string) (10000 + $n * 911), 'country' => 'US',
            ]);
        }
    }
    return $customer;
};

/** One order placed from the admin screen's own path, then moved to what happened to it. */
$orders = [];
$place = static function (Customer $customer, array $lines, float $daysAgo, string $outcome) use (&$orders): void {
    $items = [];
    foreach ($lines as [$variation, $quantity]) {
        $items[] = [
            'object_id' => $variation->id, 'post_id' => $variation->post_id, 'quantity' => $quantity,
            'unit_price' => $variation->item_price, 'title' => $variation->variation_title, 'post_title' => get_the_title($variation->post_id),
            'fulfillment_type' => $variation->fulfillment_type, 'other_info' => $variation->other_info,
            'payment_type' => $variation->payment_type ?: 'onetime',
        ];
    }
    $order = OrderResource::updatedPlaceOrder(['customer_id' => $customer->id, 'order_items' => $items]);
    if (!$order instanceof Order) {
        return;
    }
    if ($outcome !== 'pending') {
        anypress_sample_api('POST', "/fluent-cart/v2/orders/{$order->id}/mark-as-paid", ['payment_method' => 'offline_payment']);
    }
    if (in_array($outcome, ['shipped', 'paid', 'refunded'], true)) {
        anypress_sample_api('PUT', "/fluent-cart/v2/orders/{$order->id}/statuses", ['action' => 'change_shipping_status', 'statuses' => ['shipping_status' => 'shipped']]);
    }
    if ($outcome === 'paid') {
        anypress_sample_api('PUT', "/fluent-cart/v2/orders/{$order->id}/statuses", ['action' => 'change_order_status', 'statuses' => ['order_status' => 'completed']]);
        // Older orders arrived long ago (set on the order itself: the delivered email would only repeat the shipped one).
        $done = Order::find($order->id);
        if ($done) {
            $done->shipping_status = 'delivered';
            $done->save();
        }
    }
    if ($outcome === 'refunded') {
        $transaction = \FluentCart\App\Models\OrderTransaction::where('order_id', $order->id)->first();
        if ($transaction) {
            anypress_sample_api('POST', "/fluent-cart/v2/orders/{$order->id}/refund", ['refund_info' => ['transaction_id' => $transaction->id, 'amount' => $transaction->total, 'cancelSubscription' => false, 'manageStock' => true]]);
        }
    }
    // The order's own dates, so a month of sales shows on the reports.
    $when = anypress_sample_when($daysAgo, 11 + (int) $daysAgo % 8);
    foreach ([Order::class, \FluentCart\App\Models\OrderTransaction::class] as $model) {
        foreach ($model === Order::class ? [Order::find($order->id)] : $model::where('order_id', $order->id)->get() as $row) {
            if ($row) {
                $row->created_at = $when;
                $row->updated_at = $when;
                $row->save();
            }
        }
    }
    anypress_sample_mail_at($when);
    // The store's CRM lifecycle tags the buyer as checkout does (its hooks wait for a real payment).
    if ($outcome !== 'pending' && class_exists('AnyPress_CRM_Lifecycle')) {
        $paid = Order::find($order->id);
        foreach ($paid->subscriptions()->get() as $subscription) {
            AnyPress_CRM_Lifecycle::on_subscription_active(['subscription' => $subscription]);
        }
        AnyPress_CRM_Lifecycle::on_order_paid(['order' => $paid, 'customer' => $customer]);
        if ($outcome === 'refunded') {
            AnyPress_CRM_Lifecycle::on_full_refund(['order' => $paid, 'customer' => $customer]);
        }
    }
    $orders[] = $order->id;
};

$variants = [];
foreach ($products as $postId) {
    $variants[] = ProductVariation::where('post_id', $postId)->first();
}
// Every order oldest first, Sock club sign-ups among them, so order numbers follow the dates.
$subscription = $extra['subscription'] ? ProductVariation::where('post_id', $extra['subscription'])->first() : null;
$queue = [];
foreach ($shop['orders'] as $n => [$who, $daysAgo, $lines, $outcome]) {
    $picked = $variants ? array_map(static fn ($l) => [$variants[$l[0] % count($variants)], $l[1]], $lines) : [];
    $queue[] = [$who, $n, $picked, $daysAgo, $outcome];
}
foreach ($subscription ? $shop['subscribers'] : [] as $n => $who) {
    $queue[] = [$who, 20 + $n, [[$subscription, 1]], [150, 90, 40][$n % 3], 'paid'];
}
usort($queue, static fn ($a, $b) => $b[3] <=> $a[3]);
foreach ($queue as [$who, $n, $picked, $daysAgo, $outcome]) {
    $customer = $customerFor($sample['people'][$who], $n);
    if ($customer && $picked) {
        $place($customer, $picked, $daysAgo, $outcome);
    }
}
// Each customer's order count, spend and first order, counted again now the orders carry their real dates.
foreach (Customer::get() as $customer) {
    $customer->recountStat();
}
// FluentCart's follow-up for each paid order (the shop owner's "new sale" email) would all run on the first visit,
// dated today; the demo's orders were paid months ago, so those stay unsent.
as_unschedule_all_actions('fluent_cart/order_paid_async_private_handle', [], 'fluent-cart');
update_option('anypress_sample_orders', $orders, false);
$mark('orders');

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

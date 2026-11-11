<?php
/**
 * FluentCart: its own sample catalogue in four categories at real prices, a subscription and a gift card, two
 * coupons, and a month of orders (paid, shipped, processing, one refunded, one waiting for payment) from customers
 * with addresses, so the reports have numbers in them. Payments stay in test mode.
 */
use FluentCart\Api\Resource\CustomerResource;
use FluentCart\Api\Resource\OrderResource;
use FluentCart\App\Models\Customer;
use FluentCart\App\Models\Order;
use FluentCart\App\Models\ProductVariation;

$shop = $sample['shop'];

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

// Real prices (the sample catalogue's are placeholders), one item on sale, and categories a shopper would expect.
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
        $updates[] = ['id' => $variation->id, 'item_price' => $price + $v * 200, 'compare_price' => $n === 2 ? $price + 2000 : null];
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

/** The shop's customer for a sample person, with a billing and shipping address. */
$customerFor = static function (array $p, int $n): ?Customer {
    $customer = Customer::where('email', anypress_sample_email($p))->first();
    if (!$customer) {
        CustomerResource::create(['email' => anypress_sample_email($p), 'full_name' => $p[0] . ' ' . $p[1], 'first_name' => $p[0], 'last_name' => $p[1]]);
        $customer = Customer::where('email', anypress_sample_email($p))->first();
    }
    if ($customer && !$customer->primary_billing_address) {
        foreach (['billing', 'shipping'] as $kind) {
            anypress_sample_api('POST', "/fluent-cart/v2/customers/{$customer->id}/address", [
                'type' => $kind, 'is_primary' => 1, 'label' => 'Home', 'name' => "$p[0] $p[1]", 'email' => anypress_sample_email($p),
                'address_1' => (100 + $n * 17) . ' Oak Street', 'city' => $p[2], 'postcode' => (string) (10000 + $n * 911), 'country' => 'US',
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
    if ($outcome === 'shipped') {
        anypress_sample_api('PUT', "/fluent-cart/v2/orders/{$order->id}/statuses", ['action' => 'change_shipping_status', 'statuses' => ['shipping_status' => 'shipped']]);
    }
    if ($outcome === 'paid') {
        anypress_sample_api('PUT', "/fluent-cart/v2/orders/{$order->id}/statuses", ['action' => 'change_order_status', 'statuses' => ['order_status' => 'completed']]);
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
foreach ($shop['orders'] as $n => [$who, $daysAgo, $lines, $outcome]) {
    $customer = $customerFor($sample['people'][$who], $n);
    $picked = $variants ? array_map(static fn ($l) => [$variants[$l[0] % count($variants)], $l[1]], $lines) : [];
    if ($customer && $picked) {
        $place($customer, $picked, $daysAgo, $outcome);
    }
}
$subscription = $extra['subscription'] ? ProductVariation::where('post_id', $extra['subscription'])->first() : null;
foreach ($subscription ? $shop['subscribers'] : [] as $n => $who) {
    $customer = $customerFor($sample['people'][$who], 20 + $n);
    if ($customer) {
        $place($customer, [[$subscription, 1]], 20 - $n * 6, 'paid');
    }
}
update_option('anypress_sample_orders', $orders, false);
$mark('orders');

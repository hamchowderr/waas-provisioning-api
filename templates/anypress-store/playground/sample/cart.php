<?php
/**
 * FluentCart orders for the sample: customers with addresses, and orders placed as the admin screen places them, then
 * paid, shipped, completed or refunded on the day it happened. Used by the shop and by paid bookings.
 */
use FluentCart\Api\Resource\CustomerResource;
use FluentCart\Api\Resource\OrderResource;
use FluentCart\App\Models\Customer;
use FluentCart\App\Models\Order;

const ANYPRESS_SAMPLE_STATES = ['Portland' => 'OR', 'Atlanta' => 'GA', 'Austin' => 'TX', 'Boston' => 'MA', 'Chicago' => 'IL', 'Denver' => 'CO', 'Seattle' => 'WA', 'New Orleans' => 'LA', 'Minneapolis' => 'MN', 'Detroit' => 'MI', 'San Diego' => 'CA', 'Nashville' => 'TN', 'San Jose' => 'CA', 'Miami' => 'FL', 'Phoenix' => 'AZ', 'Columbus' => 'OH', 'Pittsburgh' => 'PA', 'Philadelphia' => 'PA', 'Houston' => 'TX', 'Raleigh' => 'NC', 'Sacramento' => 'CA', 'Honolulu' => 'HI', 'Dallas' => 'TX', 'Kansas City' => 'MO'];

/** The shop's customer for a sample person, with a billing and shipping address. */
function anypress_sample_customer(array $p, int $n): ?Customer
{
    $customer = Customer::where('email', anypress_sample_email($p))->first();
    if (!$customer) {
        CustomerResource::create(['email' => anypress_sample_email($p), 'full_name' => $p[0] . ' ' . $p[1], 'first_name' => $p[0], 'last_name' => $p[1]]);
        $customer = Customer::where('email', anypress_sample_email($p))->first();
    }
    if ($customer && !$customer->primary_billing_address) {
        foreach (['billing', 'shipping'] as $kind) {
            anypress_sample_api('POST', "/fluent-cart/v2/customers/{$customer->id}/address", [
                'type' => $kind, 'is_primary' => 1, 'label' => 'Home', 'name' => "$p[0] $p[1]", 'email' => anypress_sample_email($p),
                'address_1' => (100 + $n * 17) . ' Oak Street', 'city' => $p[2], 'state' => ANYPRESS_SAMPLE_STATES[$p[2]] ?? 'CA', 'postcode' => (string) (10000 + $n * 911), 'country' => 'US',
            ]);
        }
    }
    return $customer;
}

/**
 * One order placed from the admin screen's own path, then moved to what happened to it (pending, paid, shipped or
 * refunded) on the day it happened. Answers the order, or null.
 */
function anypress_sample_order(Customer $customer, array $lines, float $daysAgo, string $outcome): ?Order
{
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
        return null;
    }
    if ($outcome !== 'pending') {
        anypress_sample_api('POST', "/fluent-cart/v2/orders/{$order->id}/mark-as-paid", ['payment_method' => 'offline_payment']);
    }
    $ships = array_filter($items, static fn ($i) => $i['fulfillment_type'] === 'physical') !== [];
    if ($ships && in_array($outcome, ['shipped', 'paid', 'refunded'], true)) {
        anypress_sample_api('PUT', "/fluent-cart/v2/orders/{$order->id}/statuses", ['action' => 'change_shipping_status', 'statuses' => ['shipping_status' => 'shipped']]);
    }
    if ($outcome === 'paid') {
        anypress_sample_api('PUT', "/fluent-cart/v2/orders/{$order->id}/statuses", ['action' => 'change_order_status', 'statuses' => ['order_status' => 'completed']]);
        // Older orders arrived long ago (set on the order itself: the delivered email would only repeat the shipped one).
        $done = $ships ? Order::find($order->id) : null;
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
    $GLOBALS['anypress_sample_orders'][] = $order->id;
    return Order::find($order->id);
}

/** After the orders: each customer's totals counted again, and the owner's "new sale" emails left unsent. */
function anypress_sample_orders_done(): void
{
    // Each customer's order count, spend and first order, counted again now the orders carry their real dates.
    foreach (Customer::get() as $customer) {
        $customer->recountStat();
    }
    // Each subscription started with its order, and bills next on the same day of the month (or year) after today.
    foreach (\FluentCart\App\Models\Subscription::get() as $subscription) {
        $order = Order::find($subscription->parent_order_id);
        if (!$order) {
            continue;
        }
        $when = (string) $order->getRawOriginal('created_at');
        $next = strtotime($when . ' UTC');
        while ($next <= time()) {
            $next = strtotime($subscription->billing_interval === 'yearly' ? '+1 year' : '+1 month', $next);
        }
        $subscription->created_at = $when;
        $subscription->updated_at = $when;
        $subscription->next_billing_date = gmdate('Y-m-d H:i:s', $next);
        $subscription->save();
    }
    // FluentCart's follow-up for each paid order (the shop owner's "new sale" email) would all run on the first
    // visit, dated today; the demo's orders were paid months ago, so those stay unsent.
    as_unschedule_all_actions('fluent_cart/order_paid_async_private_handle', [], 'fluent-cart');
    $all = array_merge((array) get_option('anypress_sample_orders', []), $GLOBALS['anypress_sample_orders'] ?? []);
    update_option('anypress_sample_orders', array_values(array_unique($all)), false);
}

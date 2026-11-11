<?php
/**
 * FluentAffiliate: two active affiliates and one waiting for approval, with visits from their links and referrals
 * on the shop's orders (some waiting for a payout, one being checked).
 */
use FluentAffiliate\App\Models\Referral;
use FluentAffiliate\App\Models\Visit;

$orders = (array) get_option('anypress_sample_orders', []);
foreach ($sample['affiliates'] as $a => [$who, $status, $referrals]) {
    $p = $sample['people'][$who];
    $userId = anypress_sample_user($p);
    if (!$userId) {
        continue;
    }
    [, $made] = anypress_sample_api('POST', '/fluent-affiliate/v2/affiliates', [
        'user_id' => $userId, 'status' => $status, 'rate_type' => 'default', 'payment_email' => anypress_sample_email($p),
        'note' => $status === 'pending' ? 'Applied from the affiliate page. Runs a style blog.' : '',
    ]);
    $affiliateId = (int) ($made['affiliate']['id'] ?? 0);
    if (!$affiliateId) {
        continue;
    }
    // Visits from the affiliate's link over the month.
    for ($v = 0; $v < 6 + $a * 4; $v++) {
        $visit = Visit::create([
            'affiliate_id' => $affiliateId,
            'url' => home_url('/?ref=' . $affiliateId),
            'referrer' => ['https://www.instagram.com/', 'https://www.pinterest.com/', 'https://www.google.com/'][$v % 3],
            'utm_campaign' => $v % 2 ? 'winter' : '',
            'ip' => '',
        ]);
        $visit->created_at = anypress_sample_when(28 - $v * 2.2, 12 + $v % 9);
        $visit->save();
    }
    foreach ($referrals as [$orderIndex, $refStatus]) {
        $order = isset($orders[$orderIndex]) ? \FluentCart\App\Models\Order::find($orders[$orderIndex]) : null;
        if (!$order) {
            continue;
        }
        [, $ref] = anypress_sample_api('POST', '/fluent-affiliate/v2/referrals', [
            'affiliate_id' => $affiliateId,
            'amount' => round($order->total_amount * 0.3 / 100, 2),
            'description' => 'Order #' . $order->id,
            'status' => $refStatus === 'paid' ? 'unpaid' : $refStatus,
            'type' => 'sale',
        ]);
        $referral = Referral::find((int) ($ref['referral']['id'] ?? 0));
        if ($referral) {
            // Tied to the order it came from, as FluentAffiliate's FluentCart integration does at checkout.
            $referral->provider = 'fluent_cart';
            $referral->provider_id = $order->id;
            $referral->order_total = $order->total_amount / 100;
            $referral->currency = $order->currency;
            $referral->created_at = $order->created_at;
            $referral->save();
        }
    }
}

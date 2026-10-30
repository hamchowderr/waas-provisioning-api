<?php
/*
 * Plugin Name: Seller storefront defaults
 * Description: Settings the seller storefront template keeps in code: WP Fusion kept out of staging mode, buyers added to FluentCRM, and the owner's details filled in once. Part of the storefront template.
 */

// WP Fusion compares the site URL with the one it was set up on and stops syncing when they differ. Every
// storefront is a clone of the template and can change domain, so that check would switch it off.
if (!defined('WPF_STAGING_MODE')) {
    define('WPF_STAGING_MODE', false);
}
add_filter('wp_fusion_hide_upgrade_nags', '__return_true');

/*
 * Buyers in FluentCRM. Each paid order makes the buyer a contact tagged "Website: Active"; when their last website
 * plan ends (cancelled, expired or fully refunded) the tag becomes "Website: Past". A new contact is "transactional":
 * buying isn't a newsletter sign-up, so marketing email waits for the checkout's newsletter box. An existing contact
 * keeps its status, so someone who unsubscribed stays unsubscribed. (FluentCart's own FluentCRM feed forces the
 * status to subscribed on every order, which would undo an unsubscribe.)
 */
const SELLER_STOREFRONT_ACTIVE = 'Website: Active';
const SELLER_STOREFRONT_PAST = 'Website: Past';

function seller_storefront_contact($customer)
{
    if (!function_exists('FluentCrmApi') || !$customer || !is_email((string) $customer->email)) {
        return null;
    }
    $contact = FluentCrmApi('contacts')->getContact($customer->email);
    if ($contact) {
        return $contact;
    }
    return FluentCrmApi('contacts')->createOrUpdate(array_filter([
        'email' => (string) $customer->email,
        'first_name' => (string) ($customer->first_name ?? ''),
        'last_name' => (string) ($customer->last_name ?? ''),
        'status' => 'transactional',
    ])) ?: null;
}

function seller_storefront_tag(string $title): int
{
    $tag = \FluentCrm\App\Models\Tag::firstOrCreate(['slug' => sanitize_title($title)], ['title' => $title]);
    return (int) $tag->id;
}

function seller_storefront_retag($customer, bool $active): void
{
    $contact = seller_storefront_contact($customer);
    if (!$contact) {
        return;
    }
    [$add, $remove] = $active ? [SELLER_STOREFRONT_ACTIVE, SELLER_STOREFRONT_PAST] : [SELLER_STOREFRONT_PAST, SELLER_STOREFRONT_ACTIVE];
    $contact->detachTags([seller_storefront_tag($remove)]);
    $contact->attachTags([seller_storefront_tag($add)]);
}

function seller_storefront_has_live_plan($customerId, $exceptId = 0): bool
{
    return \FluentCart\App\Models\Subscription::where('customer_id', $customerId)
        ->where('id', '!=', (int) $exceptId)
        ->whereIn('status', ['active', 'trialing', 'paused', 'failing', 'expiring', 'past_due'])
        ->exists();
}

function seller_storefront_safely(callable $step): void
{
    try {
        $step();
    } catch (\Throwable $e) {
        error_log('Seller storefront: FluentCRM: ' . $e->getMessage()); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- a CRM step failing must never stop a checkout; the site's log is where it is looked into.
    }
}

add_action('plugins_loaded', function () {
    if (!defined('FLUENTCRM') || !defined('FLUENTCART_VERSION')) {
        return;
    }
    add_action('fluent_cart/order_paid_done', function ($data) {
        seller_storefront_safely(function () use ($data) {
            $order = $data['order'] ?? null;
            seller_storefront_retag(($data['customer'] ?? null) ?: ($order ? $order->customer : null), true);
        });
    }, 20, 1);
    $ended = function ($data) {
        seller_storefront_safely(function () use ($data) {
            $sub = $data['subscription'] ?? null;
            if (!$sub || seller_storefront_has_live_plan($sub->customer_id, $sub->id)) {
                return;
            }
            seller_storefront_retag(($data['customer'] ?? null) ?: $sub->customer, false);
        });
    };
    foreach (['fluent_cart/subscription_canceled', 'fluent_cart/subscription_expired_validity', 'fluent_cart/subscription_eot'] as $hook) {
        add_action($hook, $ended, 20, 1);
    }
    add_action('fluent_cart/order_fully_refunded', function ($data) {
        seller_storefront_safely(function () use ($data) {
            $order = $data['order'] ?? null;
            $customer = ($data['customer'] ?? null) ?: ($order ? $order->customer : null);
            if (!$customer || seller_storefront_has_live_plan($customer->id)) {
                return;
            }
            seller_storefront_retag($customer, false);
        });
    }, 20, 1);
});

/*
 * The owner's details, filled in once. The API sets the site title and admin email after the storefront is made from
 * the template, so FluentCRM's business name and email (its email footers) wait for the first web request that has a
 * real admin email.
 */
add_action('init', function () {
    if ((defined('WP_CLI') && WP_CLI) || get_option('seller_storefront_owner_applied') || !defined('FLUENTCRM')) {
        return;
    }
    $email = (string) get_option('admin_email');
    if (!is_email($email) || substr($email, -8) === '.invalid') {
        return;
    }
    if (!add_option('seller_storefront_owner_applied', time(), '', false)) {
        return;
    }
    $crm = get_option('fluentcrm-global-settings', []);
    $crm['business_settings'] = array_merge($crm['business_settings'] ?? ['business_address' => '', 'logo' => ''], [
        'business_name' => wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES),
        'admin_email' => $email,
    ]);
    update_option('fluentcrm-global-settings', $crm);
}, 9999);

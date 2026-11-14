<?php
/**
 * AutomatorWP: the business's own automations, switched on, and months of runs in its log. Each run is the event the
 * automation's trigger listens for (a post going live, a member joining a space, a signed-in customer buying or
 * booking), for the person it happened to, so its actions really ran (the CRM tag, the email), dated when it happened.
 */
$now = time();

/**
 * One automation as its editor saves it: the automation, one trigger and one action, each with its options. Runs once
 * per person when $perPerson is 1, every time when 0.
 */
$automation = static function (string $title, float $daysAgo, array $trigger, array $action, int $perPerson = 0): ?object {
    ct_setup_table('automatorwp_automations');
    $id = ct_insert_object([
        'title' => $title, 'type' => 'user', 'sequential' => 0, 'times_per_user' => $perPerson, 'times' => 0,
        'status' => 'active', 'date' => anypress_sample_when($daysAgo, 15),
    ]);
    ct_reset_setup_table();
    if (!$id) {
        return null;
    }
    $items = [];
    foreach (['trigger' => $trigger, 'action' => $action] as $kind => [$type, $options]) {
        ct_setup_table("automatorwp_{$kind}s");
        $item = ['automation_id' => $id, 'title' => '', 'type' => $type, 'status' => 'active', 'position' => 0, 'date' => anypress_sample_when($daysAgo, 15)];
        $item['id'] = ct_insert_object($item);
        // Its options may name the trigger's own tags ({trigger}:post_title), as the editor's tag picker writes them.
        foreach ($options as $key => $value) {
            ct_update_object_meta($item['id'], $key, str_replace('{trigger}', '{' . ($items['trigger']->id ?? 0), $value));
        }
        wp_cache_flush();
        ct_update_object(['id' => $item['id'], 'title' => automatorwp_parse_automation_item_edit_label((object) $item, $kind, 'view')]);
        ct_reset_setup_table();
        $items[$kind] = (object) $item;
    }
    wp_cache_flush();
    // AutomatorWP keeps each automation's triggers and actions for the request; these are new.
    AutomatorWP()->cache = [];
    return (object) ['id' => $id, 'trigger' => $items['trigger']];
};

/** The newest log id, so the logs one event writes can be dated after it. */
$newest = static function (): int {
    ct_setup_table('automatorwp_logs');
    $rows = (new CT_Query(['orderby' => 'id', 'order' => 'DESC', 'items_per_page' => 1]))->get_results();
    ct_reset_setup_table();
    return (int) ($rows[0]->id ?? 0);
};

/** One run: the trigger's own event for a person, its logs (and any email it sent) dated when it happened. */
$run = static function (array $event, string $when) use ($newest): void {
    $before = $newest();
    $GLOBALS['automatorwp_completed_triggers'] = [];
    automatorwp_trigger_event($event);
    ct_setup_table('automatorwp_logs');
    foreach ((new CT_Query(['orderby' => 'id', 'order' => 'DESC', 'items_per_page' => 10]))->get_results() as $log) {
        if ((int) $log->id > $before) {
            ct_update_object(['id' => $log->id, 'date' => $when]);
        }
    }
    ct_reset_setup_table();
    anypress_sample_mail_at($when);
};

/** A FluentCRM tag for an automation to add, made once. */
$tag = static function (string $title): int {
    return (int) \FluentCrm\App\Models\Tag::firstOrCreate(['slug' => sanitize_title($title)], ['title' => $title])->id;
};

$daysAgo = static fn (string $date) => ($now - strtotime($date . ' UTC')) / DAY_IN_SECONDS;
$oldest = static fn (array $dates) => $dates ? max(array_map($daysAgo, $dates)) + 3 : 120;

// Every site: the team hears when a post goes live, to share it.
$posts = get_posts(['post_type' => 'post', 'numberposts' => -1, 'orderby' => 'date', 'order' => 'ASC']);
$made = $automation(
    'Tell the team when a post goes live',
    $oldest(array_map(static fn ($p) => $p->post_date_gmt, $posts)),
    ['wordpress_publish_post', ['times' => 1]],
    ['wordpress_send_email', [
        'to' => get_option('admin_email'),
        'subject' => 'New on the blog: {trigger}:post_title}',
        'content' => "{trigger}:post_title} is live: {trigger}:post_url}\n\nShare it on social and add it to the next newsletter.",
    ]]
);
foreach ($made ? $posts : [] as $post) {
    $run(['trigger' => 'wordpress_publish_post', 'user_id' => (int) $post->post_author, 'post_id' => $post->ID], $post->post_date_gmt);
}

if (!defined('FLUENTCRM')) {
    return;
}

// Community: every new member is tagged in the CRM once, for the welcome emails.
if (defined('FLUENT_COMMUNITY_PLUGIN_VERSION')) {
    $joined = \FluentCommunity\App\Models\SpaceUserPivot::where('status', 'active')->where('role', 'member')->orderBy('created_at')->get();
    $made = $automation(
        'Tag new members in the CRM',
        $oldest($joined->pluck('created_at')->all()),
        ['fluentcommunity_join_space', ['space' => 'any', 'times' => 1]],
        ['fluentcrm_user_tag', ['tag' => $tag('Community member')]],
        1
    );
    foreach ($made ? $joined : [] as $member) {
        $run(['trigger' => 'fluentcommunity_join_space', 'user_id' => (int) $member->user_id, 'space_id' => (int) $member->space_id], (string) $member->created_at);
    }
}

// Shops: customers who buy while signed in are tagged as buyers.
if (defined('FLUENTCART_VERSION')) {
    $orders = \FluentCart\App\Models\Order::with(['customer', 'order_items'])->where('payment_status', 'paid')->orderBy('created_at')->get();
    $made = $automation(
        'Tag signed-in buyers',
        $oldest($orders->pluck('created_at')->all()),
        ['fluentcart_purchase_product', ['post' => 'any', 'times' => 1]],
        ['fluentcrm_user_tag', ['tag' => $tag('Bought online')]],
        1
    );
    foreach ($made ? $orders : [] as $order) {
        $user = $order->customer ? get_user_by('email', $order->customer->email) : null;
        foreach ($user ? $order->order_items : [] as $item) {
            $run(['trigger' => 'fluentcart_purchase_product', 'user_id' => $user->ID, 'post_id' => (int) $item->post_id, 'order_id' => $order->id], (string) $order->created_at);
        }
    }
}

// Bookings: clients who book while signed in are tagged, so the follow-up emails reach them.
if (defined('FLUENT_BOOKING_VERSION')) {
    $bookings = \FluentBooking\App\Models\Booking::orderBy('created_at')->get();
    $made = $automation(
        'Tag clients who book',
        $oldest($bookings->pluck('created_at')->all()),
        ['fluentbooking_schedule_meeting', ['post' => 'any', 'times' => 1]],
        ['fluentcrm_user_tag', ['tag' => $tag('Booked a session')]],
        1
    );
    foreach ($made ? $bookings : [] as $booking) {
        $user = get_user_by('email', $booking->email);
        if ($user) {
            $run(['trigger' => 'fluentbooking_schedule_meeting', 'user_id' => $user->ID, 'event_id' => (int) $booking->event_id, 'booking_id' => $booking->id], (string) $booking->created_at);
        }
    }
}

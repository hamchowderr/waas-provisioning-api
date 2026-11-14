<?php
/**
 * FluentBooking: two hosts with their own calendars and weekly hours (lunch off, Saturday mornings, a day off next
 * week), the business's services, three months of sessions (done, a few no-shows and cancellations) and the next
 * two weeks filling up. With FluentCart on, paid services take payment through it, as on a real store: each has its
 * product, and every paid session has its order (paid, or refunded when it was cancelled).
 */
use FluentBooking\App\Models\Availability;
use FluentBooking\App\Models\Booking;
use FluentBooking\App\Services\BookingService;
use FluentBooking\App\Services\CalendarService;

$plan = $sample['bookings'];
$people = $sample['people'];
$week = static function (bool $saturday): array {
    $day = ['enabled' => true, 'slots' => [['start' => '09:00', 'end' => '12:30'], ['start' => '13:30', 'end' => '17:00']]];
    return [
        'sun' => ['enabled' => false, 'slots' => []],
        'mon' => $day, 'tue' => $day, 'wed' => $day, 'thu' => $day, 'fri' => $day,
        'sat' => $saturday ? ['enabled' => true, 'slots' => [['start' => '10:00', 'end' => '14:00']]] : ['enabled' => false, 'slots' => []],
    ];
};

$events = [];
foreach ($plan['hosts'] as $h => [$who, $bio]) {
    $userId = anypress_sample_user($people[$who]);
    if (!$userId) {
        continue;
    }
    wp_update_user(['ID' => $userId, 'description' => $bio, 'role' => 'editor']);
    $made = CalendarService::createCalendar([
        'title' => $people[$who][0] . ' ' . $people[$who][1],
        'description' => $bio,
        'user_id' => $userId,
    ]);
    $calendar = is_array($made) ? ($made['calendar'] ?? null) : null;
    if ($calendar) {
        // A host calendar takes its host's login as its title; the booking page shows the host's name instead.
        $calendar->title = $people[$who][0] . ' ' . $people[$who][1];
        $calendar->save();
    }
    $default = $calendar ? $calendar->events()->first() : null;
    if (!$default) {
        continue;
    }
    // Weekly hours: lunch off, Saturday mornings for the first host, and a day off next week.
    $hours = Availability::find($default->availability_id);
    if ($hours) {
        $value = $hours->value;
        $value['weekly_schedules'] = $week($h === 0);
        $value['date_overrides'] = [gmdate('Y-m-d', strtotime('+' . (8 + $h) . ' days')) => []];
        $hours->value = $value;
        $hours->key = $h === 0 ? 'Studio hours' : 'Coaching hours';
        $hours->save();
    }
    $mine = array_values(array_filter($plan['events'], static fn ($e) => $e[0] === $h));
    foreach ($mine as $n => [, $title, $minutes, $price, $where, $about]) {
        $location = ['phone' => 'phone_guest', 'in_person' => 'in_person_organizer', 'online' => 'online_meeting'][$where];
        $fields = [
            'title' => $title,
            'description' => $about . ($price ? ' $' . number_format($price / 100) . ', paid at the session.' : ' Free.'),
            'duration' => $minutes,
            'location_type' => $location,
            'location_settings' => [['type' => $location, 'title' => $where === 'in_person' ? '14 Willow Lane, Suite 2' : '', 'display_on_booking' => '']],
            'status' => 'active',
        ];
        if ($n === 0) {
            foreach ($fields as $key => $value) {
                $default->{$key} = $value;
            }
            $default->save();
            $slot = $default;
        } else {
            CalendarService::createCalendarEvents($calendar, [$fields + [
                'event_type' => 'single',
                'availability_type' => 'existing_schedule',
                'availability_id' => $default->availability_id,
            ]]);
            $slot = $calendar->events()->where('title', $title)->first();
        }
        foreach ($plan['events'] as $index => $event) {
            if ($event[1] === $title) {
                $events[$index] = $slot;
            }
        }
    }
}

$made = [];
$notes = ['Lower back has been tight since the move.', 'First time, a little nervous!', 'Would like to focus on pricing.', '', 'Running 5 minutes late is OK?', ''];
foreach ($plan['bookings'] as $n => [$event, $who, $daysAhead, $hour, $status]) {
    $slot = $events[$event] ?? null;
    if (!$slot) {
        continue;
    }
    $p = $people[$who];
    $start = strtotime('today ' . $hour . ':00 UTC') + $daysAhead * DAY_IN_SECONDS;
    // Weekends move to Monday, as the hours above allow.
    while (in_array(gmdate('w', $start), ['0', '6'], true)) {
        $start += DAY_IN_SECONDS;
    }
    try {
        $booking = BookingService::createBooking([
            'first_name' => $p[0],
            'last_name' => $p[1],
            'email' => anypress_sample_email($p),
            'phone' => '+1 555 01' . str_pad((string) (10 + $n), 2, '0', STR_PAD_LEFT),
            'message' => $notes[$n % count($notes)],
            'start_time' => gmdate('Y-m-d H:i:s', $start),
            'person_time_zone' => 'America/Los_Angeles',
            'status' => 'scheduled',
            'source' => 'web',
        ], $slot);
    } catch (\Throwable $e) {
        continue;
    }
    if (!$booking instanceof Booking) {
        continue;
    }
    // Booked a few days ahead, as clients do; the confirmation emails are dated then too.
    $booked = $start - (2 + $n % 6) * DAY_IN_SECONDS - 5 * HOUR_IN_SECONDS;
    // Sessions coming up soon were booked over the last week, not all today.
    if ($booked > time() - 900) {
        $booked = time() - (1 + $n % 7) * DAY_IN_SECONDS - (2 + $n % 9) * HOUR_IN_SECONDS;
    }
    $booked = gmdate('Y-m-d H:i:s', $booked);
    $booking->created_at = $booked;
    $booking->updated_at = $status === 'scheduled' ? $booked : gmdate('Y-m-d H:i:s', min(time() - 600, $start + 2 * HOUR_IN_SECONDS));
    $booking->status = $status;
    if ($status === 'cancelled') {
        $booking->internal_note = 'Cancelled by the client: travelling that week.';
    }
    if ($status === 'no_show') {
        $booking->internal_note = 'Did not arrive. Sent a friendly note to rebook.';
    }
    $booking->save();
    $made[] = [$booking, $slot, $who, $n, $status, $booked];
    // The confirmations FluentBooking's queue sends straight after a booking, sent now and dated when it was made.
    do_action('fluent_booking/after_booking_scheduled_async', $booking->id, $slot->id);
    as_unschedule_action('fluent_booking/after_booking_scheduled_async', [$booking->id, $slot->id], 'fluent-booking');
    anypress_sample_mail_at($booked);
}

// Paid services take payment through FluentCart, as on a real Bookings store: a product for each (made from the event's
// own Payment screen route), then an order for every paid session, paid when it was booked and refunded if cancelled.
if (defined('FLUENTCART_VERSION')) {
    require_once ANYPRESS_SAMPLE . '/cart.php';
    $products = [];
    foreach ($events as $index => $slot) {
        $price = (int) $plan['events'][$index][3];
        if (!$price || isset($products[$slot->id])) {
            continue;
        }
        [, $made_] = anypress_sample_api('POST', '/fluent-booking/v2/integrations/create/cart-product', ['title' => $slot->title, 'price' => $price / 100]);
        $variant = (int) ($made_['variant']['id'] ?? 0);
        if (!$variant) {
            continue;
        }
        wp_set_object_terms((int) $made_['variant']['post_id'], ['Sessions'], 'product-categories', false);
        anypress_sample_api('POST', "/fluent-booking/v2/calendars/{$slot->calendar_id}/events/{$slot->id}/cart-settings", [
            'settings' => ['enabled' => 'yes', 'multi_payment_enabled' => 'no', 'cart_product_id' => $variant],
        ]);
        $products[$slot->id] = \FluentCart\App\Models\ProductVariation::find($variant);
    }
    // Oldest first, so order numbers follow the dates.
    usort($made, static fn ($a, $b) => strcmp($a[5], $b[5]));
    foreach ($made as [$booking, $slot, $who, $n, $status, $booked]) {
        $variation = $products[$slot->id] ?? null;
        $customer = $variation ? anypress_sample_customer($people[$who], $n) : null;
        if (!$customer) {
            continue;
        }
        $order = anypress_sample_order($customer, [[$variation, 1]], (time() - strtotime($booked . ' UTC')) / DAY_IN_SECONDS, $status === 'cancelled' ? 'refunded' : 'paid');
        if (!$order) {
            continue;
        }
        // Linked both ways, as FluentBooking links them when the payment comes in: the booking shows its order.
        $config = (array) $order->config;
        $config['fcal_booking_id'] = $booking->id;
        $config['fcal_target_variant_id'] = $variation->id;
        $order->config = $config;
        $order->save();
        $booking->source_id = $order->id;
        $booking->payment_status = $status === 'cancelled' ? 'refunded' : 'paid';
        $booking->save();
    }
    anypress_sample_orders_done();
}

// Reminders for sessions already past would all go out at once on the first visit; the coming ones stay queued.
if (class_exists('ActionScheduler')) {
    foreach (as_get_scheduled_actions(['group' => 'fluent-booking', 'status' => \ActionScheduler_Store::STATUS_PENDING, 'per_page' => 500], 'ids') as $actionId) {
        $next = \ActionScheduler::store()->get_date($actionId);
        if ($next && $next->getTimestamp() < time() + 300) {
            \ActionScheduler::store()->cancel_action($actionId);
        }
    }
}

// The demo's admin isn't one of the hosts, so its bookings screen opens on everyone's bookings, not "My bookings".
file_put_contents(WPMU_PLUGIN_DIR . '/anypress-sample-bookings.php', "<?php\nadd_filter('fluent_booking/default_booking_filters', static fn (\$f) => ['author' => 'all'] + \$f);\n");

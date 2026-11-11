<?php
/**
 * FluentBooking: two hosts with their own calendars and weekly hours (lunch off, Saturday mornings, a day off next
 * week), the business's services, and a fortnight of bookings: some done, most coming up, one cancelled.
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
    if ($booking instanceof Booking && $status !== 'scheduled') {
        $booking->status = $status;
        if ($status === 'cancelled') {
            $booking->internal_note = 'Cancelled by the client: travelling that week.';
        }
        $booking->save();
    }
}

// The demo's admin isn't one of the hosts, so its bookings screen opens on everyone's bookings, not "My bookings".
file_put_contents(WPMU_PLUGIN_DIR . '/anypress-sample-bookings.php', "<?php\nadd_filter('fluent_booking/default_booking_filters', static fn (\$f) => ['author' => 'all'] + \$f);\n");

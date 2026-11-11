<?php
/**
 * Sample content for a site type's demo on WordPress Playground, so a visitor sees the site working: blog posts, CRM
 * contacts, and by site type shop products, a community with members and posts, or booking times with bookings.
 * Made with each plugin's own functions, after the store set-up, only for the plugins this site type has on. Demo only:
 * "Make this my site" carries pages, styles and menus to the store, never this content.
 */
require '/wordpress/wp-load.php';
wp_set_current_user(1);

$type = defined('ANYPRESS_TENANT_ROLES') ? (string) ANYPRESS_TENANT_ROLES : '';
$people = [
    ['Maya', 'Chen'], ['Daniel', 'Okafor'], ['Sofia', 'Ramirez'], ['Liam', 'Walsh'],
    ['Aisha', 'Khan'], ['Noah', 'Bennett'], ['Grace', 'Kim'], ['Lucas', 'Moreau'],
];
$email = static fn (array $p) => strtolower($p[0] . '.' . $p[1]) . '@example.com';

// Blog posts, on every site type.
$posts = [
    ['Welcome to our new website', "We've opened our doors online. Here you'll find what we do, how to reach us, and news as it happens.", 'News'],
    ['Five questions to ask before you start', 'A short checklist we share with every new customer, so the first conversation is a useful one.', 'Tips'],
    ['Behind the scenes: a week with our team', 'What a normal week looks like here, from the first coffee to the last delivery.', 'Stories'],
];
foreach ($posts as $i => [$title, $text, $category]) {
    $term = term_exists($category, 'category') ?: wp_insert_term($category, 'category');
    wp_insert_post([
        'post_title' => $title,
        'post_content' => "<!-- wp:paragraph -->\n<p>" . esc_html($text) . "</p>\n<!-- /wp:paragraph -->",
        'post_status' => 'publish',
        'post_date' => gmdate('Y-m-d H:i:s', time() - ($i + 1) * 3 * DAY_IN_SECONDS),
        'post_category' => is_wp_error($term) ? [] : [(int) $term['term_id']],
    ]);
}

// CRM contacts, with a tag, where FluentCRM is on.
if (function_exists('FluentCrmApi')) {
    foreach ($people as $i => $p) {
        FluentCrmApi('contacts')->createOrUpdate([
            'first_name' => $p[0],
            'last_name' => $p[1],
            'email' => $email($p),
            'status' => 'subscribed',
            'tags' => [$i % 2 ? 'Customer' : 'Lead'],
        ]);
    }
}

// Shop products from FluentCart's own sample catalogue, on the site types that sell products.
if (in_array($type, ['online-store', 'everything'], true) && class_exists('\FluentCart\App\Services\Async\DummyProductService')) {
    for ($i = 0; $i < 6; $i++) {
        \FluentCart\App\Services\Async\DummyProductService::create('menswear', $i);
    }
}

// A community: members, two spaces, posts, comments and likes.
if (class_exists('\FluentCommunity\App\Models\Space')) {
    $members = [1];
    foreach (array_slice($people, 0, 6) as $p) {
        $id = username_exists(strtolower($p[0] . $p[1])) ?: wp_insert_user([
            'user_login' => strtolower($p[0] . $p[1]),
            'user_pass' => wp_generate_password(),
            'user_email' => $email($p),
            'display_name' => $p[0] . ' ' . $p[1],
            'first_name' => $p[0],
            'last_name' => $p[1],
            'role' => 'subscriber',
        ]);
        if (!is_wp_error($id)) {
            \FluentCommunity\App\Models\User::find($id)->syncXProfile();
            $members[] = (int) $id;
        }
    }
    $spaces = [];
    foreach ([['Welcome', 'Say hello and tell us what brought you here.'], ['Show your work', 'Share what you are making and get friendly feedback.']] as $i => [$title, $about]) {
        $space = \FluentCommunity\App\Models\Space::create([
            'serial' => $i + 1,
            'title' => $title,
            'slug' => sanitize_title($title),
            'description' => $about,
            'privacy' => 'public',
            'created_by' => 1,
        ]);
        foreach ($members as $userId) {
            $space->members()->attach($userId, ['role' => $userId === 1 ? 'admin' : 'member', 'status' => 'active']);
        }
        $spaces[] = $space;
    }
    $feed = [
        [1, 0, "Welcome, everyone! Introduce yourself below: who you are and what you'd like to get from this community."],
        [2, 0, "Hi all, I'm Maya. I run a small studio and I'm here to learn from people who've been where I am."],
        [3, 1, 'Finished my first big project this week. It took longer than planned, but I learned a lot. Happy to share notes.'],
        [4, 0, 'Is anyone else joining the live session on Thursday? I have a few questions saved up.'],
        [5, 1, 'Here is a before and after of the redesign I mentioned. Feedback very welcome!'],
    ];
    foreach ($feed as $i => [$author, $spaceIndex, $message]) {
        $userId = $members[min($author - 1, count($members) - 1)];
        $when = gmdate('Y-m-d H:i:s', time() - (count($feed) - $i) * 5 * HOUR_IN_SECONDS);
        $post = new \FluentCommunity\App\Models\Feed();
        $post->fill([
            'message' => $message,
            'message_rendered' => wp_kses_post(\FluentCommunity\App\Services\FeedsHelper::mdToHtml($message)),
            'type' => 'text',
            'content_type' => 'text',
            'privacy' => 'public',
            'status' => 'published',
            'space_id' => $spaces[$spaceIndex]->id,
            'user_id' => $userId,
            'created_at' => $when,
            'updated_at' => $when,
        ]);
        $post->save();
        foreach (array_slice($members, 1, 1 + $i % 3) as $liker) {
            \FluentCommunity\App\Models\Reaction::create(['user_id' => $liker, 'object_id' => $post->id, 'object_type' => 'feed', 'type' => 'like']);
            $post->reactions_count = $post->reactions_count + 1;
        }
        if ($i % 2 === 0) {
            $reply = 'Great to see this here. Thanks for sharing!';
            $comment = new \FluentCommunity\App\Models\Comment();
            $comment->fill([
                'user_id' => $members[($i + 2) % count($members)],
                'post_id' => $post->id,
                'message' => $reply,
                'message_rendered' => wp_kses_post(\FluentCommunity\App\Services\FeedsHelper::mdToHtml($reply)),
                'type' => 'comment',
                'content_type' => 'text',
                'status' => 'published',
            ]);
            $comment->save();
            $post->comments_count = $post->comments_count + 1;
        }
        $post->save();
    }
}

// Booking times and a few upcoming bookings, where FluentBooking is on.
if (class_exists('\FluentBooking\App\Services\CalendarService')) {
    $made = \FluentBooking\App\Services\CalendarService::createCalendar([
        'title' => get_bloginfo('name') ?: 'Appointments',
        'description' => 'Pick a time that suits you.',
        'user_id' => 1,
    ], true);
    $calendar = is_array($made) ? ($made['calendar'] ?? null) : null;
    $first = $calendar ? $calendar->events()->first() : null;
    if ($first) {
        $first->title = 'Free consultation';
        $first->description = 'A short call to talk through what you need.';
        $first->save();
        \FluentBooking\App\Services\CalendarService::createCalendarEvents($calendar, [[
            'title' => 'Full session',
            'description' => 'An hour together on your project.',
            'duration' => 60,
            'event_type' => 'single',
            'availability_type' => 'existing_schedule',
            'availability_id' => $first->availability_id,
            'status' => 'active',
        ]]);
        foreach (array_slice($people, 0, 3) as $i => $p) {
            $day = strtotime('+' . ($i + 1) . ' weekdays 10:00 UTC');
            try {
                \FluentBooking\App\Services\BookingService::createBooking([
                    'first_name' => $p[0],
                    'last_name' => $p[1],
                    'email' => $email($p),
                    'start_time' => gmdate('Y-m-d H:i:s', $day),
                    'person_time_zone' => 'UTC',
                    'status' => 'scheduled',
                    'source' => 'web',
                ], $first);
            } catch (\Throwable $e) {
                // A booking the plugin refuses is left out; the demo still has its booking times.
            }
        }
    }
}

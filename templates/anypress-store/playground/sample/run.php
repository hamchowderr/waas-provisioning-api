<?php
/**
 * Sample content for a site type's demo on WordPress Playground: a made-up business set up in every plugin the site
 * type has on, so a visitor can open any screen in wp-admin and see it working (blog, CRM, forms, shop, bookings,
 * help desk, affiliates, community, course). Demo only: "Make this my site" carries the visitor's pages, styles, menus
 * and business details to the store, never this content.
 *
 * Everything is made through each plugin's own REST routes (as its admin screens do) or its own models and services,
 * never SQL on its tables. Each part runs only when its plugin is on for this site type. No email leaves Playground.
 */
require '/wordpress/wp-load.php';
wp_set_current_user(1);
// Playground runs on SQLite: a few report queries some plugins run while saving don't translate. They only feed
// dashboards, so their errors stay out of the page.
$GLOBALS['wpdb']->suppress_errors(true);
// Nothing is mailed from the demo.
add_filter('pre_wp_mail', '__return_false', 99);
// Product photos are used at their own size: making every thumbnail size in the browser is most of the wait.
add_filter('intermediate_image_sizes_advanced', '__return_empty_array', 99);
add_filter('big_image_size_threshold', '__return_false', 99);

const ANYPRESS_SAMPLE = __DIR__;
$type = defined('ANYPRESS_TENANT_ROLES') ? (string) ANYPRESS_TENANT_ROLES : 'website';
$sample = (require ANYPRESS_SAMPLE . '/data.php')($type);

/** One of the plugin's own REST routes, as its admin screens call it. Answers [status, data]. */
function anypress_sample_api(string $method, string $route, array $params = []): array
{
    $request = new WP_REST_Request($method, $route);
    if ($method === 'GET') {
        $request->set_query_params($params);
    } else {
        $request->set_header('content-type', 'application/json');
        $request->set_body((string) wp_json_encode($params));
    }
    $response = rest_do_request($request);
    return [$response->get_status(), $response->get_data()];
}

/** A time $days ago (negative: ahead), at $hour UTC, as MySQL wants it. */
function anypress_sample_when(float $days, int $hour = 10): string
{
    return gmdate('Y-m-d H:i:s', (int) (strtotime('today ' . $hour . ':00 UTC') - $days * DAY_IN_SECONDS));
}

/** The sample person's email address. */
function anypress_sample_email(array $person): string
{
    return strtolower($person[0] . '.' . $person[1]) . '@example.com';
}

/** A WordPress user for a sample person (subscriber), made once. */
function anypress_sample_user(array $person): int
{
    $login = strtolower($person[0] . $person[1]);
    $id = username_exists($login) ?: wp_insert_user([
        'user_login' => $login,
        'user_pass' => wp_generate_password(),
        'user_email' => anypress_sample_email($person),
        'display_name' => $person[0] . ' ' . $person[1],
        'first_name' => $person[0],
        'last_name' => $person[1],
        'description' => $person[4] ?? '',
        'role' => 'subscriber',
    ]);
    return is_wp_error($id) ? 0 : (int) $id;
}

update_option('blogname', $sample['business']['name']);
update_option('blogdescription', $sample['business']['tagline']);

$parts = [
    'blog' => true,
    'forms' => defined('FLUENTFORM'),
    'shop' => defined('FLUENTCART_VERSION') && !empty($sample['shop']),
    'bookings' => defined('FLUENT_BOOKING_VERSION') && !empty($sample['bookings']),
    'support' => defined('FLUENT_SUPPORT_VERSION') && !empty($sample['tickets']),
    'affiliates' => defined('FLUENT_AFFILIATE_VERSION') && !empty($sample['affiliates']),
    'community' => defined('FLUENT_COMMUNITY_PLUGIN_VERSION') && !empty($sample['community']),
    'extras' => true,
    // Last: buyers, bookers and members are contacts already (each plugin adds them); the CRM part adds the rest of
    // the list, notes, the Newsletter list and the automations they are in.
    'crm' => defined('FLUENTCRM'),
];
foreach ($parts as $part => $on) {
    if (!$on) {
        continue;
    }
    $started = microtime(true);
    try {
        require ANYPRESS_SAMPLE . '/' . $part . '.php';
    } catch (\Throwable $e) {
        // A part a plugin refuses is left out; the rest of the demo still has its content.
        echo "Sample $part: " . $e->getMessage() . "\n";
    }
    if (getenv('ANYPRESS_SAMPLE_TIMING')) {
        printf("%s %.1fs\n", $part, microtime(true) - $started);
    }
}

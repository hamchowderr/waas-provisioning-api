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
// Nothing is mailed from the demo: with FluentSMTP on, its simulator logs each email instead (set up below), and
// without it nothing is sent at all.
if (!defined('FLUENTMAIL')) {
    add_filter('pre_wp_mail', '__return_false', 99);
} else {
    // The store drops mail to example.com addresses before it is sent, and every sample person has one. While the
    // sample is made, those emails reach FluentSMTP's simulator so the log lists them; nothing is sent either way.
    foreach (['pre_wp_mail', 'wp_mail'] as $hook) {
        foreach ($GLOBALS['wp_filter'][$hook]->callbacks[10] ?? [] as $callback) {
            if ($callback['function'] instanceof Closure && str_ends_with((string) (new ReflectionFunction($callback['function']))->getFileName(), 'anypress-store.php')) {
                remove_filter($hook, $callback['function'], 10);
            }
        }
    }
}
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

/** One entry on a Fluent Forms form, as a submission saves it: the entry, its details and its id hash. */
function anypress_sample_entry(\FluentForm\App\Models\Form $form, array $data, float $daysAgo, string $status, bool $starred = false, string $page = '/contact/'): void
{
    $previous = (int) \FluentForm\App\Models\Submission::where('form_id', $form->id)->max('serial_number');
    $when = anypress_sample_when($daysAgo, 9 + (int) ($daysAgo * 7) % 9);
    $submission = \FluentForm\App\Models\Submission::create([
        'form_id' => $form->id,
        'serial_number' => $previous + 1,
        'response' => wp_json_encode($data, JSON_UNESCAPED_UNICODE),
        'source_url' => home_url($page),
        'user_id' => 0,
        'status' => $status,
        'is_favourite' => $starred ? 1 : 0,
        'browser' => ['Chrome', 'Safari', 'Firefox'][(int) $daysAgo % 3],
        'device' => ['Windows', 'iPhone', 'Mac', 'Android'][(int) $daysAgo % 4],
        'country' => 'US',
        'created_at' => $when,
        'updated_at' => $when,
    ]);
    (new \FluentForm\App\Services\Submission\SubmissionService())->recordEntryDetails($submission->id, $form->id, $data);
    \FluentForm\App\Helpers\Helper::setSubmissionMeta($submission->id, '_entry_uid_hash', md5(wp_generate_uuid4() . $submission->id), $form->id);
}

/** A photo from the sample's own set (sample/images, CC0 from StockSnap), added to the media library. Answers its id. */
function anypress_sample_image(string $name, int $postId = 0, string $title = ''): int
{
    $base = defined('ANYPRESS_SAMPLE_IMAGES') ? ANYPRESS_SAMPLE_IMAGES : 'https://raw.githubusercontent.com/hamchowderr/waas-provisioning-api/main/templates/anypress-store/playground/sample/images/';
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';
    $file = download_url($base . $name, 30);
    if (is_wp_error($file)) {
        return 0;
    }
    $id = media_handle_sideload(['name' => sanitize_title($title ?: basename($name, '.webp')) . '.webp', 'tmp_name' => $file], $postId, $title);
    if (is_wp_error($id)) {
        @unlink($file);
        return 0;
    }
    update_post_meta($id, '_wp_attachment_image_alt', $title);
    return (int) $id;
}

/**
 * Emails a step sent (logged by FluentSMTP's simulator) dated when that step happened, not when the demo was made.
 * Every email logged since the last call takes $when.
 */
function anypress_sample_mail_at(string $when): void
{
    static $seen = null;
    if (!class_exists('\FluentMail\App\Models\Logger')) {
        return;
    }
    $logger = new \FluentMail\App\Models\Logger();
    $rows = $logger->get(['per_page' => 100, 'page' => 1]);
    $rows = $rows['data'] ?? (is_array($rows) ? $rows : []);
    foreach ($rows as $row) {
        $row = (array) $row;
        if ($seen !== null && (int) $row['id'] <= $seen) {
            continue;
        }
        $logger->updateLog(['created_at' => $when, 'updated_at' => $when], ['id' => (int) $row['id']]);
    }
    foreach ($rows as $row) {
        $seen = max((int) $seen, (int) ((array) $row)['id']);
    }
}

update_option('blogname', $sample['business']['name']);
update_option('blogdescription', $sample['business']['tagline']);

$parts = [
    // First: the email log (FluentSMTP's simulator), so every email a later part sends is listed, and none leaves.
    'mail' => defined('FLUENTMAIL'),
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
    // Then the newsletter: months of issues to the list the parts before made.
    'newsletter' => defined('FLUENTCRM') && !empty($sample['newsletter']),
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

<?php
/**
 * FluentAuth: two months of sign-ins in its log (the team most days, members and clients now and then, from their own
 * browsers and phones), a few mistyped passwords, and one bot that guessed at "admin" until it was blocked. Each row is
 * written by FluentAuth's own login handler, then dated when it happened.
 */
use FluentAuth\App\Helpers\Helper;
use FluentAuth\App\Hooks\Handlers\LoginSecurityHandler;

$agents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
];

/** As if the request came from this address and browser. */
$from = static function (string $ip, string $agent): void {
    $_SERVER['REMOTE_ADDR'] = $ip;
    $_SERVER['HTTP_USER_AGENT'] = $agent;
    Helper::resetStatics();
};

/** The row FluentAuth's handler just wrote, dated when it happened. */
$dated = static function (string $when): void {
    $id = (int) $GLOBALS['wpdb']->insert_id;
    if ($id) {
        flsDb()->table('fls_auth_logs')->where('id', $id)->update(['created_at' => $when, 'updated_at' => $when]);
    }
};

// Who signs in: the team (admins, editors, hosts, authors) most days, then up to a dozen members or customers.
$team = get_users(['role__in' => ['administrator', 'editor', 'author'], 'fields' => 'all']);
$others = get_users(['role__not_in' => ['administrator', 'editor', 'author'], 'number' => 12, 'orderby' => 'ID']);
$logins = [];
foreach ($team as $t => $user) {
    for ($day = 60 - $t * 3; $day > 0; $day -= 2 + ($t + $day) % 3) {
        $logins[] = [$user, $day + (8 + ($day * 5 + $t) % 9) / 24, $t];
    }
}
foreach ($others as $o => $user) {
    for ($day = 55 - $o * 4; $day > 0; $day -= 9 + $o % 7) {
        $logins[] = [$user, $day + (12 + ($day + $o) % 10) / 24, 10 + $o];
    }
}
foreach ($logins as [$user, $daysAgo, $who]) {
    // Each person has their own address and mostly one browser, with a phone some days.
    $from('203.0.113.' . (10 + $who * 7 % 230), $agents[($who + ((int) $daysAgo % 5 === 0 ? 2 : 0)) % count($agents)]);
    (new LoginSecurityHandler())->logAuthSuccess($user->user_login, $user);
    $dated(gmdate('Y-m-d H:i:s', (int) (time() - $daysAgo * DAY_IN_SECONDS)));
}

// A few mistyped passwords, each followed by the right one.
foreach (array_slice($team, 0, 3) as $t => $user) {
    $from('203.0.113.' . (10 + $t * 7 % 230), $agents[$t % count($agents)]);
    (new LoginSecurityHandler())->logFailedAuth($user->user_login, new WP_Error('incorrect_password', __('The password you entered is incorrect.', 'fluent-security')));
    $dated(gmdate('Y-m-d H:i:s', (int) (time() - (11 + $t * 13) * DAY_IN_SECONDS - 60)));
}

// A bot guessing at "admin" from one address, until FluentAuth blocked it (its own check, on the next try).
$from('198.51.100.77', 'python-requests/2.32.3');
$start = $GLOBALS['wpdb']->insert_id;
foreach (['admin', 'admin', 'administrator', 'admin', 'test'] as $guess) {
    (new LoginSecurityHandler())->logFailedAuth($guess, new WP_Error('invalid_username', __('Unknown username. Check again or try your email address.', 'fluent-security')));
}
wp_authenticate('admin', wp_generate_password());
$burst = gmdate('Y-m-d H:i:s', (int) (time() - 19.6 * DAY_IN_SECONDS));
flsDb()->table('fls_auth_logs')->where('id', '>', (int) $start)->update(['created_at' => $burst, 'updated_at' => $burst]);

// The plugins were switched on and off when the site was set up, months before the first sign-in above.
$setUp = gmdate('Y-m-d H:i:s', (int) (time() - 200 * DAY_IN_SECONDS));
flsDb()->table('fls_auth_logs')->where('status', 'site_activity')->update(['created_at' => $setUp, 'updated_at' => $setUp]);

unset($_SERVER['HTTP_USER_AGENT']);
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
Helper::resetStatics();

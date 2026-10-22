<?php
/*
 * WaaS store agent. The Coolify provisioner runs it in a store's `agent` container (the
 * wordpress:cli image, sharing the WordPress volume) through a Coolify scheduled task:
 *
 *   php /tmp/waas-agent.php <operation> <base64 JSON arguments>
 *
 * On success it prints one line "WAAS_RESULT <json>". On failure it prints "WAAS_ERROR <message>"
 * and exits 1. It never prints its arguments: they carry pre-signed URLs.
 */

// WAAS_ROOT is for tests; in a store it is always the WordPress volume.
define('ROOT', getenv('WAAS_ROOT') ?: '/var/www/html');
const CONTENT = ROOT . '/wp-content';
const FLAG = CONTENT . '/.waas-suspended';
/** The page a suspended store shows. Rendered on suspend; kept out of snapshots, so it never spreads to other stores. */
const PAGE = CONTENT . '/waas-unavailable.html';
const DEFAULT_BRAND = ['name' => 'AnyPress'];
const WWW_UID = 33; // www-data in the Debian WordPress image (the Alpine CLI image's own is 82)

function fail(string $message)
{
    fwrite(STDOUT, 'WAAS_ERROR ' . str_replace("\n", ' ', $message) . "\n");
    exit(1);
}

function done(array $result = [])
{
    fwrite(STDOUT, 'WAAS_RESULT ' . json_encode($result) . "\n");
    exit(0);
}

/** Runs a shell command, returning stdout. Fails with the tail of stderr, not the command. */
function run(string $command, bool $mayFail = false): string
{
    // stderr goes to a file: two pipes read one after the other deadlock once the unread one fills.
    $errFile = tempnam(sys_get_temp_dir(), 'waas-err');
    $proc = proc_open($command, [1 => ['pipe', 'w'], 2 => ['file', $errFile, 'w']], $pipes);
    if (!is_resource($proc)) fail('could not start a process');
    $out = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $code = proc_close($proc);
    $err = (string) @file_get_contents($errFile);
    @unlink($errFile);
    if ($code !== 0 && !$mayFail) {
        $words = preg_split('/\s+/', $command);
        fail(($words[0] === 'wp' ? 'wp ' . ($words[4] ?? '') : $words[0]) . " exited $code: " . substr(trim($err ?: $out), -400));
    }
    return trim((string) $out);
}

/** WP-CLI without plugins or themes, so a broken plugin cannot block provisioning. */
function wp(string ...$args): string
{
    return run('wp --path=' . ROOT . ' --skip-plugins --skip-themes ' . implode(' ', array_map('escapeshellarg', $args)) . ' 2>&1', false);
}

function wpMayFail(string ...$args): ?string
{
    $out = run('wp --path=' . ROOT . ' --skip-plugins --skip-themes ' . implode(' ', array_map('escapeshellarg', $args)) . ' 2>/dev/null; echo "::$?"', true);
    [$text, $code] = array_pad(explode('::', $out, 2), 2, '1');
    return trim($code) === '0' ? trim($text) : null;
}

function curlTransfer(string $url, string $file, bool $upload): void
{
    $fh = fopen($file, $upload ? 'rb' : 'wb');
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_FAILONERROR => true, CURLOPT_FOLLOWLOCATION => !$upload, CURLOPT_CONNECTTIMEOUT => 30]);
    if ($upload) {
        curl_setopt_array($ch, [CURLOPT_UPLOAD => true, CURLOPT_INFILE => $fh, CURLOPT_INFILESIZE => filesize($file), CURLOPT_RETURNTRANSFER => true]);
    } else {
        curl_setopt($ch, CURLOPT_FILE, $fh);
    }
    $ok = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    fclose($fh);
    if ($ok === false) fail(($upload ? 'upload' : 'download') . " failed: HTTP $status $error");
}

function tempDir(): string
{
    $dir = sys_get_temp_dir() . '/waas-' . bin2hex(random_bytes(6));
    mkdir($dir, 0700, true);
    register_shutdown_function(fn () => run('rm -rf ' . escapeshellarg($dir), true));
    return $dir;
}

/** Extracts a zip or a gzipped tar into $dir. */
function extract_archive(string $file, string $dir): void
{
    $magic = file_get_contents($file, false, null, 0, 2);
    if ($magic === 'PK') {
        $zip = new ZipArchive();
        if ($zip->open($file) !== true) fail('not a readable zip');
        $zip->extractTo($dir) || fail('zip extraction failed');
        $zip->close();
    } else {
        run('tar -xzf ' . escapeshellarg($file) . ' -C ' . escapeshellarg($dir));
    }
}

/** Adds a directory to a zip under $prefix, skipping caches and the suspension flag. */
function zip_dir(ZipArchive $zip, string $dir, string $prefix): void
{
    if (!is_dir($dir)) return;
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
    foreach ($it as $path => $info) {
        $rel = substr($path, strlen($dir) + 1);
        if ($rel === '.waas-suspended' || $rel === 'waas-unavailable.html' || preg_match('#^(cache|upgrade|upgrade-temp-backup)(/|$)#', $rel)) continue;
        if ($info->isDir()) $zip->addEmptyDir("$prefix/$rel");
        elseif ($info->isFile()) $zip->addFile($path, "$prefix/$rel");
    }
}

/** The wp-content directory inside an extracted archive. */
function find_content(string $dir): ?string
{
    if (is_dir("$dir/wp-content")) return "$dir/wp-content";
    if (is_dir("$dir/plugins") || is_dir("$dir/themes") || is_dir("$dir/uploads")) return $dir;
    return null;
}

function set_home(string $home): void
{
    $old = wpMayFail('option', 'get', 'home');
    if ($old && rtrim($old, '/') !== rtrim($home, '/')) {
        $oldHost = parse_url($old, PHP_URL_HOST);
        $newHost = parse_url($home, PHP_URL_HOST);
        foreach (['https://', 'http://'] as $scheme) {
            wp('search-replace', $scheme . $oldHost, 'https://' . $newHost, '--all-tables-with-prefix', '--skip-columns=guid', '--quiet');
        }
    }
    wp('option', 'update', 'home', $home);
    wp('option', 'update', 'siteurl', $home);
}

/**
 * What a site moved in from another host must not bring along: the old host's must-use plugins and
 * drop-ins (they expect that host's servers and caches), caches, and other backup plugins' archives.
 * Our own must-use plugins are installed again afterwards (install_guard).
 */
const IMPORT_DROP = [
    'object-cache.php', 'advanced-cache.php', 'db.php', 'wp-cache-config.php', 'cache', 'upgrade', 'upgrade-temp-backup',
    'ai1wm-backups', 'updraft', 'backups-dup-lite', 'backups-dup-pro', 'wpvividbackups', 'backup-db', 'plugins/anypress-export',
];
const IMPORT_DROP_MU = [
    // WP Engine
    'mu-plugin.php', 'wpengine-common', 'wpe-wp-sign-on-plugin', 'wpe-wp-sign-on-plugin.php', 'wpengine-security-auditor.php',
    'slt-force-strong-passwords.php', 'force-strong-passwords', 'stop-long-comments.php', 'wpe-cache-plugin', 'wpe-cache-plugin.php',
    'wpe-elasticpress-autosuggest-logger', 'wpe-elasticpress-autosuggest-logger.php', 'wpe-update-source-selector', 'wpe-update-source-selector.php',
    // Kinsta, GoDaddy, Pantheon, WordPress.com and Pressable, Bluehost
    'kinsta-mu-plugins', 'kinsta-mu-plugins.php', 'gd-system-plugin', 'gd-system-plugin.php', 'pantheon', 'pantheon.php', 'pantheon-mu-plugin',
    'wpcomsh', 'wpcomsh-loader.php', 'endurance-page-cache.php', 'endurance-browser-cache.php', 'sso.php',
];

/** Removes from wp-content what a site moved in must not bring along (IMPORT_DROP). Returns what it removed. */
function clean_import(): array
{
    $removed = [];
    foreach (IMPORT_DROP as $name) {
        if (file_exists(CONTENT . "/$name")) $removed[] = $name;
    }
    foreach (IMPORT_DROP_MU as $name) {
        if (file_exists(CONTENT . "/mu-plugins/$name")) $removed[] = "mu-plugins/$name";
    }
    foreach ($removed as $rel) run('rm -rf ' . escapeshellarg(CONTENT . "/$rel"));
    return $removed;
}

/**
 * Gives a database moved in from another host the store's table prefix. `$from` is the prefix the
 * export reported; without one it is found from the tables. Fails on a multisite network. Returns the
 * prefix the site had.
 */
function adopt_prefix(?string $from): string
{
    $to = wp('config', 'get', 'table_prefix');
    preg_match('/^[A-Za-z0-9_]+$/', $to) || fail('could not read the store\'s table prefix');
    // Only lines that are table names: the client may print warnings too.
    $tables = array_values(preg_grep('/^[A-Za-z0-9_$]+$/', array_map('trim', explode("\n", wp('db', 'query', 'SHOW TABLES', '--skip-column-names')))));
    if ($from === null || !in_array($from . 'options', $tables, true)) {
        $from = null;
        foreach ($tables as $t) {
            if (substr($t, -7) === 'options' && in_array(substr($t, 0, -7) . 'usermeta', $tables, true)) {
                $from = substr($t, 0, -7);
                break;
            }
        }
    }
    if ($from === null || $from === '') fail('the database export has no WordPress tables');
    preg_match('/^[A-Za-z0-9_]+$/', $from) || fail('the database export uses a table prefix WordPress cannot use here');
    if (in_array($from . 'blogs', $tables, true) || in_array($from . 'sitemeta', $tables, true)) fail('multisite networks cannot be moved in yet');
    if ($from === $to) return $from;
    $renames = [];
    foreach ($tables as $t) {
        if (strpos($t, $from) !== 0) continue;
        $new = $to . substr($t, strlen($from));
        if (in_array($new, $tables, true)) fail("the database export has both $t and $new");
        $renames[] = "`$t` TO `$new`";
    }
    wp('db', 'query', 'RENAME TABLE ' . implode(', ', $renames));
    // WordPress keys roles and each user's capabilities by the prefix.
    $like = str_replace('_', '\\_', $from) . '%';
    $from_at = strlen($from) + 1;
    wp('db', 'query', "UPDATE `{$to}options` SET option_name = CONCAT('$to', SUBSTRING(option_name, $from_at)) WHERE option_name LIKE '$like'");
    wp('db', 'query', "UPDATE `{$to}usermeta` SET meta_key = CONCAT('$to', SUBSTRING(meta_key, $from_at)) WHERE meta_key LIKE '$like'");
    return $from;
}

/** An added plugin's main file, as WordPress names it in active_plugins ("slug/file.php"): the PHP file with a Plugin Name header. */
function plugin_main_file(string $slug): ?string
{
    $files = glob(CONTENT . "/plugins/$slug/*.php") ?: [];
    // The usual name first.
    usort($files, fn ($a, $b) => (basename($b) === "$slug.php") <=> (basename($a) === "$slug.php"));
    foreach ($files as $file) {
        $head = (string) file_get_contents($file, false, null, 0, 8192);
        if (preg_match('/^[ \t\/*#@]*Plugin Name:/mi', $head)) return "$slug/" . basename($file);
    }
    return null;
}

/**
 * The "website unavailable" page every suspended store shows, branded with the platform's (or,
 * later, a reseller's) name and optional link. Self-contained: no scripts, fonts or images to load.
 */
function render_unavailable_page(array $brand): string
{
    $e = fn ($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
    $name = trim((string) ($brand['name'] ?? '')) ?: DEFAULT_BRAND['name'];
    $url = (string) ($brand['url'] ?? '');
    if (!preg_match('#^https?://[^\s"<>]+$#i', $url)) $url = '';
    $mark = $url !== '' ? '<a class="brand" href="' . $e($url) . '">' . $e($name) . '</a>' : '<span class="brand">' . $e($name) . '</span>';
    return <<<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Website unavailable</title>
<style>
:root{--bg:#f6f7fb;--card:#fff;--text:#14161f;--muted:#5b6172;--line:#e3e6ef;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0e1017;--card:#171a24;--text:#eef0f6;--muted:#a3a9ba;--line:#2a2f3d;--accent:#8b85ff}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--text);
font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{width:100%;max-width:480px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:40px 32px;text-align:center}
.icon{width:56px;height:56px;margin:0 auto 20px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)}
h1{margin:0 0 12px;font-size:1.5rem;line-height:1.3}
p{margin:0 0 12px;color:var(--muted)}
footer{margin-top:28px;padding-top:20px;border-top:1px solid var(--line);font-size:.875rem;color:var(--muted)}
.brand{color:var(--text);font-weight:600;text-decoration:none}
a.brand:hover{color:var(--accent)}
</style>
</head>
<body>
<main>
<div class="icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M10 15V9M14 15V9"/></svg></div>
<h1>This website is temporarily unavailable</h1>
<p>It isn&rsquo;t being served right now. Please check back later.</p>
<p>If this is your website, contact your provider to bring it back online.</p>
<footer>Powered by {$mark}</footer>
</main>
</body>
</html>

HTML;
}

/**
 * The mu-plugins and .htaccess block behind suspension, redirect domains, outgoing mail and the plan's quotas, and the page cache. $brand re-renders the
 * unavailable page; without it the page already there is kept (or the default one written).
 */
function install_guard(?array $brand = null): void
{
    if ($brand !== null || !is_file(PAGE)) {
        file_put_contents(PAGE, render_unavailable_page($brand ?? DEFAULT_BRAND)) !== false || fail('cannot write the unavailable page');
    }
    @mkdir(CONTENT . '/mu-plugins', 0755, true);
    file_put_contents(CONTENT . '/mu-plugins/waas-guard.php', <<<'PHP'
<?php
/*
 * Plugin Name: WaaS store guard
 * Description: Suspension (503) and redirect domains (301). Managed by the WaaS provisioner; edits are overwritten.
 */
if (defined('WP_CLI') && WP_CLI) return;
if (file_exists(WP_CONTENT_DIR . '/.waas-suspended')) {
    $waas_page = WP_CONTENT_DIR . '/waas-unavailable.html';
    header('HTTP/1.1 503 Service Unavailable', true, 503);
    header('Retry-After: 3600');
    header('Cache-Control: no-store');
    if (is_file($waas_page)) {
        header('Content-Type: text/html; charset=utf-8');
        readfile($waas_page);
    } else {
        header('Content-Type: text/plain; charset=utf-8');
        echo "Website unavailable\n";
    }
    exit;
}
$waas_home = strtolower((string) parse_url((string) get_option('home'), PHP_URL_HOST));
$waas_host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
if ($waas_home !== '' && $waas_host !== '' && $waas_host !== $waas_home) {
    header('Location: https://' . $waas_home . ($_SERVER['REQUEST_URI'] ?? '/'), true, 301);
    exit;
}
PHP);
    file_put_contents(CONTENT . '/mu-plugins/waas-mail.php', <<<'PHP'
<?php
/*
 * Plugin Name: WaaS store mail
 * Description: Sends the store's email through the platform's mail relay. Managed by the WaaS provisioner; edits are overwritten.
 */
$waas_mail = json_decode((string) base64_decode((string) getenv('WAAS_MAIL_B64')), true);
if (!is_array($waas_mail) || empty($waas_mail['host']) || empty($waas_mail['from'])) return;
// The relay sends only from its verified domain: mail goes out from the store's own address there
// under the store's name, and replies go to the address the store meant to send from, else to the
// site's administrator (nobody reads the store's address on the relay's domain).
add_action('phpmailer_init', function ($mailer) use ($waas_mail) {
    $mailer->isSMTP();
    $mailer->Host = $waas_mail['host'];
    $mailer->Port = (int) ($waas_mail['port'] ?? 465);
    $mailer->SMTPSecure = $mailer->Port === 465 ? 'ssl' : 'tls';
    $mailer->SMTPAuth = (string) ($waas_mail['user'] ?? '') !== '';
    $mailer->Username = (string) ($waas_mail['user'] ?? '');
    $mailer->Password = (string) ($waas_mail['pass'] ?? '');
    $name = (string) $mailer->FromName;
    if ($name === '' || $name === 'WordPress') $name = wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES);
    $from = strtolower((string) $mailer->From);
    $host = preg_replace('/^www\./', '', strtolower((string) parse_url((string) get_option('home'), PHP_URL_HOST)));
    // WordPress's own default sender (wordpress@<site>) has no mailbox behind it.
    if ($from !== '' && $from !== strtolower($waas_mail['from']) && $from !== "wordpress@$host" && !$mailer->getReplyToAddresses()) {
        $mailer->addReplyTo($mailer->From, $name);
    }
    $admin = strtolower((string) get_option('admin_email'));
    if (!$mailer->getReplyToAddresses() && filter_var($admin, FILTER_VALIDATE_EMAIL) && $admin !== strtolower($waas_mail['from'])) $mailer->addReplyTo($admin, $name);
    $mailer->setFrom($waas_mail['from'], $name, false);
    $mailer->Sender = $waas_mail['from'];
}, PHP_INT_MAX);
add_action('wp_mail_failed', function ($error) {
    error_log('WaaS store mail: ' . $error->get_error_message());
});

/*
 * The plugins' own email settings. Each Fluent plugin keeps a sender (From and Reply-To) of its own, shows it in its
 * settings and puts it on its emails, so fill each one in with how the store really sends: its name, its address on
 * the relay (the platform's, or the owner's sending domain once verified), and replies to its administrator. Their
 * recipients (order, form, booking, login and support notices) already follow the administrator's address.
 * Runs again whenever one of those changes or a plugin is switched on. A value the owner typed is kept: only empty
 * ones, the ones last set here, and the administrator's address older stores were given as the From are changed.
 */
$GLOBALS['waas_mail_plugins'] = [];
// The plugins loaded on this request, before a plan's site type switches any on or off on `init`.
add_action('plugins_loaded', function () {
    $GLOBALS['waas_mail_plugins'] = (array) get_option('active_plugins', []);
});
add_action('init', function () use ($waas_mail) {
    if (defined('WP_CLI') && WP_CLI) return;
    $admin = strtolower((string) get_option('admin_email'));
    if (!is_email($admin) || substr($admin, -8) === '.invalid') $admin = '';
    $name = wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES);
    $want = ['name' => $name, 'email' => strtolower($waas_mail['from']), 'reply_name' => $admin === '' ? '' : $name, 'reply' => $admin];
    $plugins = $GLOBALS['waas_mail_plugins'];
    sort($plugins);
    $key = md5(json_encode([$want, $plugins]));
    $last = get_option('waas_mail_senders');
    $last = is_array($last) ? $last : [];
    if (($last['key'] ?? '') === $key) return;
    $was = (array) ($last['set'] ?? []);
    /** The fields of $current (role => setting name) still to be filled in, with their new values. */
    $changes = function (array $current, array $fields) use ($want, $was, $admin) {
        $out = [];
        foreach ($fields as $role => $field) {
            $value = trim((string) ($current[$field] ?? ''));
            $ours = $value === '' || strcasecmp($value, (string) ($was[$role] ?? '')) === 0
                || ($role === 'email' && (strtolower($value) === $admin || substr(strtolower($value), -8) === '.invalid'));
            if ($ours && $value !== $want[$role]) $out[$field] = $want[$role];
        }
        return $out;
    };
    $sender = ['name' => 'from_name', 'email' => 'from_email', 'reply_name' => 'reply_to_name', 'reply' => 'reply_to_email'];
    $steps = [
        'FluentCart' => function () use ($changes, $sender) {
            if (!class_exists('\FluentCart\App\Services\Email\EmailNotifications')) return;
            $set = $changes(\FluentCart\App\Services\Email\EmailNotifications::getSettings(), $sender);
            if ($set) \FluentCart\App\Services\Email\EmailNotifications::updateSettings($set);
        },
        // FluentBooking falls back to FluentCRM's sender, but only while its own is empty; it gets its own.
        'FluentCRM' => function () use ($changes, $sender) {
            if (!defined('FLUENTCRM') || !class_exists('\FluentCrm\App\Services\Helper')) return;
            $email = \FluentCrm\App\Services\Helper::getGlobalEmailSettings();
            $set = $changes($email, $sender);
            if (!$set) return;
            $crm = get_option('fluentcrm-global-settings', []);
            $crm = is_array($crm) ? $crm : [];
            $crm['email_settings'] = array_merge($email, $set);
            update_option('fluentcrm-global-settings', $crm);
        },
        'FluentBooking' => function () use ($changes, $sender) {
            if (!class_exists('\FluentBooking\App\Services\Helper')) return;
            $settings = get_option('_fluent_booking_settings', []);
            $settings = is_array($settings) ? $settings : [];
            $set = $changes((array) ($settings['emailing'] ?? []), $sender);
            if (!$set) return;
            $settings['emailing'] = array_merge((array) ($settings['emailing'] ?? []), $set);
            update_option('_fluent_booking_settings', $settings, false);
        },
        // Support email goes out from the mailbox's own name and address.
        'Fluent Support' => function () use ($changes) {
            if (!class_exists('\FluentSupport\App\Models\MailBox')) return;
            foreach (\FluentSupport\App\Models\MailBox::where('box_type', 'web')->get() as $box) {
                $set = $changes(['name' => $box->name, 'email' => $box->email], ['name' => 'name', 'email' => 'email']);
                if ($set) $box->fill($set)->save();
            }
        },
        'FluentAffiliate' => function () use ($changes) {
            $utility = '\FluentAffiliate\App\Helper\Utility';
            if (!class_exists($utility)) return;
            $settings = array_merge($utility::defaultEmailSettings(), (array) $utility::getOption('global_email_settings', []));
            $set = $changes($settings, ['name' => 'send_from_name', 'email' => 'send_from_email', 'reply_name' => 'reply_to_name', 'reply' => 'reply_to_email']);
            if ($set) $utility::updateOption('global_email_settings', array_merge($settings, $set));
        },
        'FluentCommunity' => function () use ($changes) {
            $utility = '\FluentCommunity\App\Functions\Utility';
            if (!class_exists($utility)) return;
            $settings = $utility::getOption('global_email_settings', []);
            if (!is_array($settings) || !$settings) {
                $settings = $utility::getEmailNotificationSettings();
                unset($settings['email_footer_rendered']);
            }
            $set = $changes($settings, ['name' => 'send_from_name', 'email' => 'send_from_email', 'reply_name' => 'reply_to_name', 'reply' => 'reply_to_email']);
            if ($set) $utility::updateOption('global_email_settings', array_merge($settings, $set));
        },
        // FluentAuth's login, sign-up and password emails.
        'FluentAuth' => function () use ($changes, $sender) {
            if (!class_exists('\FluentAuth\App\Services\SystemEmailService')) return;
            $settings = get_option('fa_system_email_settings', []);
            $settings = is_array($settings) ? $settings : [];
            $set = $changes((array) ($settings['template_settings'] ?? []), $sender);
            if (!$set) return;
            $settings['template_settings'] = array_merge((array) ($settings['template_settings'] ?? []), $set);
            update_option('fa_system_email_settings', $settings, false);
        },
    ];
    foreach ($steps as $plugin => $step) {
        try {
            $step();
        } catch (\Throwable $e) {
            error_log("WaaS store mail: $plugin sender: " . $e->getMessage());
        }
    }
    update_option('waas_mail_senders', ['key' => $key, 'set' => $want], false);
}, PHP_INT_MAX);
PHP);
    file_put_contents(CONTENT . '/mu-plugins/waas-owner.php', <<<'PHP'
<?php
/*
 * Plugin Name: WaaS store owner
 * Description: Fills in the owner's business details from the purchase. Managed by the WaaS provisioner; edits are overwritten.
 */
/*
 * The platform sets `waas_store_owner` (JSON) from the buyer's billing details: name, phone, address_1, address_2,
 * city, state, postcode and country. Copy them where the store and its plugins keep their own: the site's time zone,
 * the administrator's name, FluentCart's store address and currency, FluentCRM's business address (the footer of
 * every campaign) and Rank Math's address and phone (the site's business details for search engines).
 * Runs again whenever the details change or a plugin is switched on. A value the owner typed is kept: only empty
 * ones, the ones last set here, and the template's own defaults (UTC, USD) are changed.
 */

/** The IANA time zone for a country and its state or province, '' when it can't be told. */
function waas_owner_timezone(string $country, string $state): string
{
    $by_state = [
        'US' => [
            'America/New_York' => 'CT DE DC FL GA KY ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV',
            'America/Indiana/Indianapolis' => 'IN',
            'America/Chicago' => 'AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI',
            'America/Denver' => 'CO MT NM UT WY',
            'America/Boise' => 'ID',
            'America/Phoenix' => 'AZ',
            'America/Los_Angeles' => 'CA NV OR WA',
            'America/Anchorage' => 'AK',
            'Pacific/Honolulu' => 'HI',
        ],
        'CA' => [
            'America/Vancouver' => 'BC', 'America/Edmonton' => 'AB NT', 'America/Regina' => 'SK', 'America/Winnipeg' => 'MB',
            'America/Toronto' => 'ON QC', 'America/Moncton' => 'NB', 'America/Halifax' => 'NS PE', 'America/St_Johns' => 'NL',
            'America/Whitehorse' => 'YT', 'America/Iqaluit' => 'NU',
        ],
        'AU' => [
            'Australia/Sydney' => 'NSW ACT', 'Australia/Melbourne' => 'VIC', 'Australia/Brisbane' => 'QLD',
            'Australia/Adelaide' => 'SA', 'Australia/Perth' => 'WA', 'Australia/Hobart' => 'TAS', 'Australia/Darwin' => 'NT',
        ],
    ];
    if (isset($by_state[$country])) {
        foreach ($by_state[$country] as $zone => $states) {
            if (in_array(strtoupper($state), explode(' ', $states), true)) return $zone;
        }
        return '';
    }
    $zones = $country !== '' ? DateTimeZone::listIdentifiers(DateTimeZone::PER_COUNTRY, $country) : [];
    return count($zones) === 1 ? $zones[0] : '';
}

/** The country's currency (ISO 4217), '' when unknown. */
function waas_owner_currency(string $country): string
{
    if ($country === '' || !class_exists('NumberFormatter')) return '';
    $code = (new NumberFormatter('und_' . $country, NumberFormatter::CURRENCY))->getTextAttribute(NumberFormatter::CURRENCY_CODE);
    return is_string($code) && preg_match('/^[A-Z]{3}$/', $code) && $code !== 'XXX' ? $code : '';
}

$GLOBALS['waas_owner_plugins'] = [];
// The plugins loaded on this request, before a plan's site type switches any on or off on `init`.
add_action('plugins_loaded', function () {
    $GLOBALS['waas_owner_plugins'] = (array) get_option('active_plugins', []);
});
add_action('init', function () {
    if (defined('WP_CLI') && WP_CLI) return;
    $owner = json_decode((string) get_option('waas_store_owner', ''), true);
    if (!is_array($owner)) return;
    $text = fn (string $key) => trim(wp_specialchars_decode((string) ($owner[$key] ?? ''), ENT_QUOTES));
    $country = strtoupper(substr($text('country'), 0, 2));
    $street = trim($text('address_1') . ', ' . $text('address_2'), ', ');
    $region = trim($text('state') . ' ' . $text('postcode'));
    $country_name = $country !== '' && class_exists('Locale') ? (string) Locale::getDisplayRegion('-' . $country, 'en') : $country;
    $want = [
        'name' => $text('name'),
        'phone' => $text('phone'),
        'address_1' => $text('address_1'),
        'address_2' => $text('address_2'),
        'city' => $text('city'),
        'state' => $text('state'),
        'postcode' => $text('postcode'),
        'country' => $country,
        'street' => trim($text('address_1') . ' ' . $text('address_2')),
        // One line, for an email footer.
        'address' => $street === '' ? '' : implode(', ', array_filter([$street, $text('city'), $region, $country_name], 'strlen')),
        'timezone' => waas_owner_timezone($country, $text('state')),
        'currency' => waas_owner_currency($country),
    ];
    $plugins = $GLOBALS['waas_owner_plugins'];
    sort($plugins);
    $key = md5(json_encode([$want, $plugins, get_option('admin_email')]));
    $last = get_option('waas_owner_details');
    $last = is_array($last) ? $last : [];
    if (($last['key'] ?? '') === $key) return;
    $was = (array) ($last['set'] ?? []);
    /**
     * Whether a setting holding $value should take the detail $role: it is empty, last set here (so a detail that is
     * now empty clears it), or a template default.
     */
    $ours = function ($value, string $role, array $defaults = []) use ($want, $was) {
        $value = trim((string) $value);
        if ($value === $want[$role]) return false;
        if ($value === '') return true;
        return $value === (string) ($was[$role] ?? '') || in_array($value, $defaults, true);
    };
    $steps = [
        'time zone' => function () use ($ours, $want) {
            $zone = (string) get_option('timezone_string');
            // A store on a UTC offset instead of a named zone was set that way by its owner.
            if ($zone === '' && (float) get_option('gmt_offset') !== 0.0) return;
            if ($want['timezone'] !== '' && $ours($zone, 'timezone', ['UTC'])) update_option('timezone_string', $want['timezone']);
        },
        // The administrator: the owner. FluentBooking shows their name as the host of their calendars.
        'administrator' => function () use ($want, $was) {
            $user = get_user_by('email', (string) get_option('admin_email'));
            if (!$user || $want['name'] === '') return;
            [$first, $last] = array_pad(preg_split('/\s+/', $want['name'], 2), 2, '');
            $old = trim($user->first_name . ' ' . $user->last_name);
            if ($old !== '' && $old !== (string) ($was['name'] ?? '')) return;
            $update = ['ID' => $user->ID, 'first_name' => $first, 'last_name' => $last];
            if (in_array($user->display_name, [$user->user_login, $old, (string) ($was['name'] ?? '')], true)) $update['display_name'] = $want['name'];
            wp_update_user($update);
        },
        'FluentCart' => function () use ($ours, $want) {
            if (!class_exists('\FluentCart\Api\StoreSettings')) return;
            $store = new \FluentCart\Api\StoreSettings();
            $set = [];
            foreach (['store_address1' => 'address_1', 'store_address2' => 'address_2', 'store_city' => 'city', 'store_state' => 'state', 'store_postcode' => 'postcode', 'store_country' => 'country'] as $field => $role) {
                if ($ours($store->get($field, ''), $role)) $set[$field] = $want[$role];
            }
            // Prices are in the store's currency, so only before its first order, and only one FluentCart supports.
            $known = class_exists('\FluentCart\App\Helpers\CurrenciesHelper') ? \FluentCart\App\Helpers\CurrenciesHelper::getCurrencies() : [];
            if (isset($known[$want['currency']]) && $ours($store->get('currency', 'USD'), 'currency', ['USD'])
                && class_exists('\FluentCart\App\Models\Order') && !\FluentCart\App\Models\Order::query()->exists()) {
                $set['currency'] = $want['currency'];
            }
            if ($set) $store->save($set);
        },
        'FluentCRM' => function () use ($ours, $want) {
            if (!defined('FLUENTCRM')) return;
            $crm = get_option('fluentcrm-global-settings', []);
            $crm = is_array($crm) ? $crm : [];
            $business = (array) ($crm['business_settings'] ?? []);
            if (!$ours($business['business_address'] ?? '', 'address')) return;
            $crm['business_settings'] = array_merge(['business_name' => '', 'business_address' => '', 'logo' => ''], $business, ['business_address' => $want['address']]);
            update_option('fluentcrm-global-settings', $crm);
        },
        'Rank Math' => function () use ($ours, $want) {
            if (!defined('RANK_MATH_VERSION')) return;
            $titles = get_option('rank-math-options-titles', []);
            $titles = is_array($titles) ? $titles : [];
            $address = is_array($titles['local_address'] ?? null) ? $titles['local_address'] : [];
            $fields = ['streetAddress' => 'street', 'addressLocality' => 'city', 'addressRegion' => 'state', 'postalCode' => 'postcode', 'addressCountry' => 'country'];
            $before = $titles;
            foreach ($fields as $field => $role) {
                if ($ours($address[$field] ?? '', $role)) $address[$field] = $want[$role];
            }
            $titles['local_address'] = $address;
            if ($ours($titles['phone'] ?? '', 'phone')) $titles['phone'] = $want['phone'];
            if ($titles !== $before) update_option('rank-math-options-titles', $titles);
        },
    ];
    foreach ($steps as $what => $step) {
        try {
            $step();
        } catch (\Throwable $e) {
            error_log("WaaS store owner: $what: " . $e->getMessage());
        }
    }
    update_option('waas_owner_details', ['key' => $key, 'set' => $want], false);
}, PHP_INT_MAX);
PHP);
    file_put_contents(CONTENT . '/mu-plugins/waas-plan.php', <<<'PHP'
<?php
/*
 * Plugin Name: WaaS store plan
 * Description: Keeps the store within its plan's storage and monthly email. Managed by the WaaS provisioner; edits are overwritten.
 */
// The quotas come with the store's size (compose.ts). Version sites have none, and nothing here applies to them.
if ((string) getenv('WAAS_STORAGE_GB') === '' && (string) getenv('WAAS_EMAILS_PER_MONTH') === '') return;

/** The plan's storage (GB, and bytes) and emails a calendar month; 0 is no limit. */
function waas_plan_limits(): array
{
    $gb = (int) getenv('WAAS_STORAGE_GB');
    return ['storageGb' => $gb, 'storage' => $gb * 1024 ** 3, 'emails' => (int) getenv('WAAS_EMAILS_PER_MONTH')];
}

/** The storage used when last measured, in bytes, plus what was uploaded since. */
function waas_plan_used(): int
{
    $usage = get_option('waas_plan_usage');
    return is_array($usage) ? (int) ($usage['bytes'] ?? 0) : 0;
}

/**
 * Measures the storage used: wp-content, without wp-content/cache (saved pages and other caches, which come back on
 * their own), and the database. Walking every file is too slow for each upload, so a daily WP-cron event measures
 * and uploads are checked against the saved number. Cron runs from the agent through WP-CLI, not on page loads.
 */
function waas_plan_measure(): array
{
    global $wpdb;
    $bytes = 0;
    $dirs = new RecursiveCallbackFilterIterator(
        new RecursiveDirectoryIterator(WP_CONTENT_DIR, FilesystemIterator::SKIP_DOTS),
        fn ($file, $path) => $path !== WP_CONTENT_DIR . '/cache'
    );
    foreach (new RecursiveIteratorIterator($dirs, RecursiveIteratorIterator::LEAVES_ONLY, RecursiveIteratorIterator::CATCH_GET_CHILD) as $file) {
        if ($file->isFile() && !$file->isLink()) $bytes += $file->getSize();
    }
    $bytes += (int) $wpdb->get_var($wpdb->prepare(
        'SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = %s',
        DB_NAME
    ));
    $usage = ['bytes' => $bytes, 'at' => time()];
    update_option('waas_plan_usage', $usage, false);
    return $usage;
}
add_action('waas_plan_measure', 'waas_plan_measure');
add_action('init', function () {
    if (!wp_next_scheduled('waas_plan_measure')) wp_schedule_event(time(), 'daily', 'waas_plan_measure');
});

/** Refuses an upload that would take the store past its storage. */
function waas_plan_check_upload($file)
{
    $limits = waas_plan_limits();
    if (!$limits['storage'] || !is_array($file) || !empty($file['error'])) return $file;
    $size = (int) ($file['size'] ?? @filesize((string) ($file['tmp_name'] ?? '')));
    if (waas_plan_used() + $size > $limits['storage']) {
        $file['error'] = sprintf('This website has used its %d GB of storage. Delete files you no longer need, or move to a bigger plan, to upload more.', $limits['storageGb']);
    }
    return $file;
}
add_filter('wp_handle_upload_prefilter', 'waas_plan_check_upload');
add_filter('wp_handle_sideload_prefilter', 'waas_plan_check_upload');
// Uploads count at once, so a day of uploads can't go far past the storage before the next measurement.
add_filter('wp_handle_upload', function ($upload) {
    $usage = get_option('waas_plan_usage');
    if (is_array($usage) && is_array($upload) && !empty($upload['file']) && empty($upload['error'])) {
        $usage['bytes'] = (int) ($usage['bytes'] ?? 0) + (int) @filesize($upload['file']);
        update_option('waas_plan_usage', $usage, false);
    }
    return $upload;
});

/**
 * The store's email packs: emails bought on top of the plan (the agent's mail-packs operation writes `purchased`),
 * and how many of them were used. Pack emails never expire; `left` carries over from month to month.
 */
function waas_plan_packs(): array
{
    $packs = get_option('waas_plan_mail_packs');
    $purchased = is_array($packs) ? max(0, (int) ($packs['purchased'] ?? 0)) : 0;
    $used = is_array($packs) ? max(0, (int) ($packs['used'] ?? 0)) : 0;
    return ['purchased' => $purchased, 'used' => $used, 'left' => max(0, $purchased - $used)];
}

/**
 * `$month`'s count of emails as the platform counted them on the relay (the agent's mail-count operation writes it,
 * hourly), or 0 when it holds another month's. An administrator can edit the store's own count; this one comes back.
 */
function waas_plan_mail_platform(string $month): int
{
    $platform = get_option('waas_plan_mail_platform');
    return is_array($platform) && ($platform['month'] ?? '') === $month ? max(0, (int) ($platform['sent'] ?? 0)) : 0;
}

/**
 * This calendar month's (UTC) count of emails sent, as the store counts them itself (at once); a new month starts at
 * 0. When the month the count was for is over, what it sent beyond the plan came out of the email packs: that is
 * added to their `used` (no more than were left), and the new month is saved with it, so the next call sees the new
 * month and it happens once. What that month sent is the higher of the store's count and the platform's.
 */
function waas_plan_mail(): array
{
    $month = gmdate('Y-m');
    $mail = get_option('waas_plan_mail');
    if (is_array($mail) && ($mail['month'] ?? '') === $month) return ['month' => $month, 'sent' => (int) ($mail['sent'] ?? 0)];
    $fresh = ['month' => $month, 'sent' => 0];
    $emails = waas_plan_limits()['emails'];
    // The month the count was for: the store's, or the platform's when the store's own count is gone.
    $platform = get_option('waas_plan_mail_platform');
    $closing = (string) (is_array($mail) ? ($mail['month'] ?? '') : (is_array($platform) ? ($platform['month'] ?? '') : ''));
    $sent = max(is_array($mail) ? (int) ($mail['sent'] ?? 0) : 0, waas_plan_mail_platform($closing));
    $over = $emails > 0 && $closing !== '' && $closing !== $month ? $sent - $emails : 0;
    $packs = waas_plan_packs();
    if ($over > 0 && $packs['left'] > 0) {
        update_option('waas_plan_mail', $fresh, false);
        update_option('waas_plan_mail_packs', ['purchased' => $packs['purchased'], 'used' => $packs['used'] + min($over, $packs['left'])], false);
    }
    return $fresh;
}
add_action('wp_mail_succeeded', function () {
    $mail = waas_plan_mail();
    $mail['sent']++;
    update_option('waas_plan_mail', $mail, false);
});

/** This month's emails sent: the higher of the store's count and the platform's, which can lag by an hour. */
function waas_plan_mail_sent(): int
{
    // The store's count first: a new month moves last month's pack emails to used.
    $month = waas_plan_mail();
    return max($month['sent'], waas_plan_mail_platform($month['month']));
}

/** What this month may send before bulk email waits: the plan's emails plus the pack emails left; 0 is no limit. */
function waas_plan_mail_allowance(): int
{
    $emails = waas_plan_limits()['emails'];
    return $emails > 0 ? $emails + waas_plan_packs()['left'] : 0;
}

/** Whether this month's emails, the packs' included, are used up. */
function waas_plan_mail_used_up(): bool
{
    // The count first: a new month moves last month's pack emails to used.
    $sent = waas_plan_mail_sent();
    $allowance = waas_plan_mail_allowance();
    return $allowance > 0 && $sent >= $allowance;
}
/*
 * Past the allowance, bulk email waits: FluentCRM's campaigns, sequences and automation emails stay in its queue and
 * go out when the next month starts. Everything else (order receipts, account emails, bookings, support replies)
 * still sends, so the store keeps working. A FluentCRM run already sending finishes its batch, so a campaign can go
 * a little past. Pack emails are used once the plan's are gone, so a store with packs left keeps sending bulk email.
 */
add_filter('fluent_crm/disable_email_processing', function ($disabled) {
    return $disabled || waas_plan_mail_used_up();
});

// The store's administrators see it coming: from 80% of either quota, and once it is used up.
add_action('admin_notices', function () {
    if (!current_user_can('manage_options')) return;
    $limits = waas_plan_limits();
    $notices = [];
    if ($limits['storage']) {
        $used = waas_plan_used();
        if ($used >= $limits['storage']) {
            $notices[] = ['error', sprintf('This website has used all of its %d GB of storage, so uploads are refused. Delete files you no longer need, or move to a bigger plan.', $limits['storageGb'])];
        } elseif ($used >= 0.8 * $limits['storage']) {
            $notices[] = ['warning', sprintf('This website has used %d%% of its %d GB of storage. Delete files you no longer need, or move to a bigger plan, before uploads stop.', floor(100 * $used / $limits['storage']), $limits['storageGb'])];
        }
    }
    if ($limits['emails']) {
        $plan = $limits['emails'];
        $sent = waas_plan_mail_sent();
        $packs = waas_plan_packs();
        // Pack emails left now: those left at the start of the month, less what this month sent beyond the plan.
        $packsLeft = max(0, $packs['left'] - max(0, $sent - $plan));
        if ($sent >= $plan + $packs['left']) {
            $notices[] = ['error', $packs['left']
                ? sprintf('This website has sent all %s of the emails its plan includes this month, and all of its pack emails. Campaigns and sequences are paused until %s; order, account and booking emails still go out. Buy more emails, or move to a bigger plan, to send more.', number_format($plan), gmdate('F j', strtotime('first day of next month')))
                : sprintf('This website has sent all %s of the emails its plan includes this month. Campaigns and sequences are paused until %s; order, account and booking emails still go out. Move to a bigger plan to send more.', number_format($plan), gmdate('F j', strtotime('first day of next month')))];
        } elseif ($sent >= $plan) {
            $notices[] = ['warning', sprintf('This website has sent all %s of the emails its plan includes this month and is now sending pack emails: %s left. Campaigns and sequences pause if they run out; order, account and booking emails always go out.', number_format($plan), number_format($packsLeft))];
        } elseif ($sent >= 0.8 * $plan) {
            $notices[] = ['warning', $packs['left']
                ? sprintf('This website has sent %s of the %s emails its plan includes this month, plus %s pack emails left. Campaigns and sequences pause when both are used up; order, account and booking emails always go out.', number_format($sent), number_format($plan), number_format($packsLeft))
                : sprintf('This website has sent %s of the %s emails its plan includes this month. Campaigns and sequences pause when it reaches %2$s; order, account and booking emails always go out.', number_format($sent), number_format($plan))];
        }
    }
    foreach ($notices as [$type, $text]) printf('<div class="notice notice-%s"><p>%s</p></div>', $type, esc_html($text));
});
PHP);
    // Apache answers 503 before PHP runs, with the page as the error document (which itself is let through).
    $block = "# BEGIN WaaS\n<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteCond %{DOCUMENT_ROOT}/wp-content/.waas-suspended -f\n"
        . "RewriteCond %{REQUEST_URI} !^/wp-content/waas-unavailable\\.html$\nRewriteRule ^ - [R=503,L]\n</IfModule>\n"
        . "ErrorDocument 503 /wp-content/waas-unavailable.html\n# END WaaS\n";
    $htaccess = ROOT . '/.htaccess';
    $current = is_file($htaccess) ? file_get_contents($htaccess) : '';
    $current = preg_replace('/# BEGIN WaaS\n.*?# END WaaS\n/s', '', $current);
    file_put_contents($htaccess, $block . $current);
    install_cache();
}

/**
 * The page cache: advanced-cache.php serves a saved copy of a page to visitors who are not logged in, before WordPress
 * and its plugins load (WP_CACHE is on in every store's wp-config, compose.ts), and mu-plugins/waas-cache.php saves
 * pages and clears them when content changes. A drop-in another cache plugin put there is left alone; ours then serves
 * nothing and saves nothing. Saved pages live in wp-content/cache, which snapshots and code exports skip, and are
 * cleared on every install, so a restored, moved or reconfigured store never serves a page from before.
 */
function install_cache(): void
{
    $dropin = CONTENT . '/advanced-cache.php';
    $current = is_file($dropin) ? (string) file_get_contents($dropin) : null;
    if ($current === null || strpos($current, 'WaaS page cache') !== false) {
        file_put_contents($dropin, <<<'PHP'
<?php
/*
 * WaaS page cache: serves saved pages. Managed by the WaaS provisioner; edits are overwritten.
 * Saved by mu-plugins/waas-cache.php, which also says which requests are cached.
 */
defined('WAAS_CACHE_TTL') || define('WAAS_CACHE_TTL', 600);
if (PHP_SAPI === 'cli') return;
$waas_method = $_SERVER['REQUEST_METHOD'] ?? '';
$waas_uri = $_SERVER['REQUEST_URI'] ?? '';
$waas_host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
// Plain page loads only: no query string (searches, previews, cart links), no WordPress internals, no PHP files.
$waas_cacheable = ($waas_method === 'GET' || $waas_method === 'HEAD')
    && preg_match('#^/[^?]*$#', $waas_uri)
    && !preg_match('#^/(wp-admin|wp-json|wp-content|wp-includes)(/|$)|\.php$#', $waas_uri)
    && preg_match('/^[a-z0-9.-]+$/', $waas_host)
    && !file_exists(WP_CONTENT_DIR . '/.waas-suspended');
// Any cookie but a few analytics ones means a visitor WordPress may treat differently: logged in, a cart, a
// password-protected post, a saved comment name. They always get WordPress.
foreach (array_keys($_COOKIE) as $waas_cookie) {
    if (!preg_match('/^(_ga|_gid$|_gat|_gcl_|_fbp$|_fbc$|_clck$|_clsk$|wordpress_test_cookie$)/', (string) $waas_cookie)) $waas_cacheable = false;
}
if ($waas_cacheable) {
    $waas_file = WP_CONTENT_DIR . '/cache/waas-pages/' . md5($waas_host . $waas_uri) . '.html';
    $waas_saved = @filemtime($waas_file);
    if ($waas_saved && time() - $waas_saved < WAAS_CACHE_TTL) {
        header('Content-Type: text/html; charset=UTF-8');
        header('X-WaaS-Cache: hit');
        if ($waas_method === 'GET') readfile($waas_file);
        exit;
    }
    // The page may be saved once WordPress has rendered it (mu-plugins/waas-cache.php decides).
    define('WAAS_CACHE_FILE', $waas_file);
}
PHP) !== false || fail('cannot write the page cache drop-in');
    }
    file_put_contents(CONTENT . '/mu-plugins/waas-cache.php', <<<'PHP'
<?php
/*
 * Plugin Name: WaaS page cache
 * Description: Saves pages for visitors who are not logged in and clears them when content changes. Managed by the WaaS provisioner; edits are overwritten.
 */
defined('WAAS_CACHE_TTL') || define('WAAS_CACHE_TTL', 600);

/** Removes every saved page, or only the expired ones. */
function waas_cache_clear(bool $expiredOnly = false): void
{
    foreach (glob(WP_CONTENT_DIR . '/cache/waas-pages/*.html') ?: [] as $file) {
        if (!$expiredOnly || time() - (int) @filemtime($file) >= WAAS_CACHE_TTL) @unlink($file);
    }
}

// Content changes clear the whole cache once, at the end of the request: a post can show on the home page,
// archives and menus, so clearing one page would not be enough. Saved pages also expire after WAAS_CACHE_TTL,
// which covers what no hook announces (stock levels, scheduled posts going live).
function waas_cache_clear_later(): void
{
    static $queued = false;
    if (!$queued) add_action('shutdown', 'waas_cache_clear', 0);
    $queued = true;
}
foreach ([
    'deleted_post', 'trashed_post', 'untrashed_post', 'edited_term', 'delete_term', 'comment_post', 'edit_comment',
    'wp_set_comment_status', 'switch_theme', 'customize_save_after', 'wp_update_nav_menu', 'activated_plugin',
    'deactivated_plugin', 'upgrader_process_complete', 'update_option_blogname', 'update_option_blogdescription',
    'update_option_permalink_structure', 'update_option_page_on_front', 'update_option_show_on_front',
    'update_option_sidebars_widgets', 'update_option_fluent_cart_store_settings', 'fluent_cart/product_updated',
    'fluent_cart/product/variants_updated', 'fluent_cart/order_paid_done',
] as $waas_hook) {
    add_action($waas_hook, 'waas_cache_clear_later');
}
// Posts of internal types (embeds WordPress caches as posts, scheduled actions) change without changing any page.
add_action('save_post', function ($id, $post) {
    if (in_array($post->post_type, ['revision', 'oembed_cache', 'customize_changeset', 'scheduled-action', 'user_request'], true)) return;
    waas_cache_clear_later();
}, 10, 2);

if (!defined('WAAS_CACHE_FILE')) return;

/** Whether the page WordPress just rendered is the same for every visitor who isn't logged in. */
function waas_cache_saveable(string $html): bool
{
    if (http_response_code() !== 200 || is_user_logged_in() || (defined('DONOTCACHEPAGE') && DONOTCACHEPAGE)) return false;
    if (is_search() || is_404() || is_feed() || is_preview() || is_robots() || is_trackback()) return false;
    if (is_singular() && post_password_required()) return false;
    if (stripos($html, '</html>') === false) return false;
    foreach (headers_list() as $header) {
        [$name, $value] = array_map('trim', explode(':', $header, 2) + [1 => '']);
        $name = strtolower($name);
        if ($name === 'set-cookie') return false;
        if ($name === 'content-type' && stripos($value, 'text/html') !== 0) return false;
        if ($name === 'cache-control' && preg_match('/no-cache|no-store|private/i', $value)) return false;
    }
    // FluentCart's cart, checkout, receipt and account pages (with the account's sub-pages under it).
    $settings = get_option('fluent_cart_store_settings');
    $path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
    foreach (['cart_page_id', 'checkout_page_id', 'receipt_page_id', 'customer_profile_page_id'] as $key) {
        $id = is_array($settings) ? (int) ($settings[$key] ?? 0) : 0;
        if (!$id) continue;
        $page = rtrim((string) parse_url((string) get_permalink($id), PHP_URL_PATH), '/');
        if ($page !== '' && ($path === $page || strpos($path, "$page/") === 0)) return false;
    }
    return true;
}

add_action('template_redirect', function () {
    ob_start(function ($html) {
        if (is_string($html) && waas_cache_saveable($html)) {
            $dir = dirname(WAAS_CACHE_FILE);
            if (is_dir($dir) || @mkdir($dir, 0755, true)) {
                // Written whole, then moved into place, so a visitor never gets half a page.
                $tmp = WAAS_CACHE_FILE . '.' . getmypid();
                if (@file_put_contents($tmp, $html) !== false) @rename($tmp, WAAS_CACHE_FILE);
            }
            if (mt_rand(1, 50) === 1) waas_cache_clear(true);
        }
        return $html;
    });
}, PHP_INT_MAX);
PHP) !== false || fail('cannot write the page cache mu-plugin');
    run('rm -rf ' . escapeshellarg(CONTENT . '/cache/waas-pages'), true);
}

/** The store's email packs as the waas-plan mu-plugin keeps them: {purchased, used}. */
function mail_packs(): array
{
    $packs = json_decode((string) wpMayFail('option', 'get', 'waas_plan_mail_packs', '--format=json'), true);
    return [
        'purchased' => is_array($packs) ? max(0, (int) ($packs['purchased'] ?? 0)) : 0,
        'used' => is_array($packs) ? max(0, (int) ($packs['used'] ?? 0)) : 0,
    ];
}

/** `$month`'s count of emails as the platform told the store it (the mail-count operation), or 0 for another month. */
function mail_platform(string $month): int
{
    $platform = json_decode((string) wpMayFail('option', 'get', 'waas_plan_mail_platform', '--format=json'), true);
    return is_array($platform) && ($platform['month'] ?? '') === $month ? max(0, (int) ($platform['sent'] ?? 0)) : 0;
}

// Commands run as root in the container; drop to www-data so WordPress can manage its files.
if (function_exists('posix_getuid') && posix_getuid() === 0) {
    posix_setgid(WWW_UID) && posix_setuid(WWW_UID) || fail('could not drop privileges');
}
putenv('HOME=/tmp');
umask(0022);

$op = $argv[1] ?? '';
$raw = $argv[2] ?? '';
// Arguments too long for one Coolify task command (255 characters) arrive in chunks first:
// "stage <id> <chunk>" appends, then "<op> @<id>" reads the staged arguments and removes them.
if ($op === 'stage') {
    preg_match('/^[0-9a-f]{12}$/', $raw) || fail('bad stage id');
    file_put_contents("/tmp/waas-args-$raw", $argv[3] ?? '', FILE_APPEND) !== false || fail('cannot stage arguments');
    done();
}
if (substr($raw, 0, 1) === '@') {
    $id = substr($raw, 1);
    preg_match('/^[0-9a-f]{12}$/', $id) || fail('bad stage id');
    $raw = (string) @file_get_contents("/tmp/waas-args-$id");
    @unlink("/tmp/waas-args-$id");
}
$args = json_decode(base64_decode($raw) ?: '{}', true);
if (!is_array($args)) fail('arguments are not base64 JSON');

switch ($op) {
    case 'ping':
        done(['uid' => function_exists('posix_getuid') ? posix_getuid() : null, 'zip' => class_exists('ZipArchive')]);

    case 'home':
        done(['home' => wpMayFail('option', 'get', 'home')]);

    case 'restore': {
        // A snapshot, base snapshot, backup or uploaded archive: database.sql and wp-content. `import`:
        // a site moved in from another host (the AnyPress Export plugin's archive, with a waas.json
        // describing it), cleaned up on the way in.
        $import = !empty($args['import']);
        $tmp = tempDir();
        curlTransfer($args['url'], "$tmp/archive", false);
        mkdir("$tmp/x");
        extract_archive("$tmp/archive", "$tmp/x");
        $suspended = file_exists(FLAG);
        $page = is_file(PAGE) ? file_get_contents(PAGE) : null;
        $content = find_content("$tmp/x");
        $sql = is_file("$tmp/x/database.sql") ? "$tmp/x/database.sql" : null;
        if ($import && (!$content || !$sql)) fail('the export must hold database.sql and wp-content');
        $info = $import && is_file("$tmp/x/waas.json") ? json_decode((string) file_get_contents("$tmp/x/waas.json"), true) : null;
        $result = [];
        if ($content) {
            run('rm -rf ' . CONTENT . '/* ' . CONTENT . '/.[!.]*', true);
            run('cp -a ' . escapeshellarg($content) . '/. ' . CONTENT . '/');
            if ($import) $result['removed'] = clean_import();
        }
        if ($sql) {
            wpMayFail('db', 'clean', '--yes');
            wp('db', 'import', $sql);
            if ($import) {
                $result['tablePrefix'] = adopt_prefix(is_array($info) && is_string($info['tablePrefix'] ?? null) ? $info['tablePrefix'] : null);
                $result['previousHome'] = wpMayFail('option', 'get', 'home');
            }
        } elseif (wpMayFail('core', 'is-installed') === null) {
            wp('core', 'install', '--url=' . $args['home'], '--title=' . ($args['title'] ?? 'Store'), '--admin_user=waas-admin',
                '--admin_email=' . ($args['adminEmail'] ?? 'admin@example.invalid'), '--admin_password=' . bin2hex(random_bytes(24)), '--skip-email');
        }
        set_home($args['home']);
        if ($suspended) touch(FLAG); else @unlink(FLAG);
        if ($page !== null) file_put_contents(PAGE, $page);
        install_guard();
        done(['database' => $sql !== null, 'content' => $content !== null] + $result);
    }

    case 'configure': {
        install_guard();
        if (!empty($args['home'])) set_home($args['home']);
        foreach ($args['options'] ?? [] as $name => $value) wp('option', 'update', (string) $name, (string) $value);
        $user = $args['user'] ?? null;
        $created = false;
        if ($user && wpMayFail('user', 'get', $user['email'], '--field=ID') === null) {
            $password = getenv('WAAS_INIT_PASSWORD');
            $extra = $password ? ['--user_pass=' . $password] : [];
            wp('user', 'create', $user['name'], $user['email'], '--role=' . $user['role'], '--porcelain', ...$extra);
            $created = true;
        }
        done(['userCreated' => $created]);
    }

    case 'snapshot': {
        $tmp = tempDir();
        wp('db', 'export', "$tmp/database.sql");
        $zip = new ZipArchive();
        $zip->open("$tmp/snapshot.zip", ZipArchive::CREATE) === true || fail('cannot create zip');
        $zip->addFile("$tmp/database.sql", 'database.sql');
        $zip->addFromString('waas.json', json_encode(['home' => wpMayFail('option', 'get', 'home'), 'takenAt' => gmdate('c')]));
        zip_dir($zip, CONTENT, 'wp-content');
        $zip->close() || fail('cannot write zip');
        $size = filesize("$tmp/snapshot.zip");
        curlTransfer($args['url'], "$tmp/snapshot.zip", true);
        done(['sizeBytes' => $size]);
    }

    case 'plugins': {
        // Plugin choices (docs/plugin-choices.md), applied to a version site before its code is exported:
        // wordpress.org plugins added to wp-content/plugins and to roles.json's site types, or taken out of
        // them. The archive may come from a version or store that already had choices applied, so those are
        // undone first: the plugins they added are removed and roles.json goes back to the template's own.
        $data = CONTENT . '/plugins/waas-client-data';
        $rolesFile = "$data/roles.json";
        $baseFile = "$data/roles.template.json";
        $addedFile = "$data/plugin-choices.json";
        if (is_file($addedFile)) {
            $earlier = json_decode((string) file_get_contents($addedFile), true);
            foreach ((array) ($earlier['created'] ?? []) as $slug) {
                if (is_string($slug) && preg_match('/^[a-z0-9][a-z0-9-]{0,99}$/', $slug)) run('rm -rf ' . escapeshellarg(CONTENT . "/plugins/$slug"));
            }
            unlink($addedFile);
        }
        if (is_file($baseFile)) rename($baseFile, $rolesFile) || fail('cannot restore the template roles.json');
        $plugins = (array) ($args['plugins'] ?? []);
        if (!empty($args['manifest'])) {
            $tmp = tempDir();
            curlTransfer((string) $args['manifest'], "$tmp/choices.json", false);
            $manifest = json_decode((string) file_get_contents("$tmp/choices.json"), true);
            is_array($manifest) || fail('the plugin choices file is not readable');
            $plugins = (array) ($manifest['plugins'] ?? []);
        }
        if (!$plugins) done(['files' => (object) []]);

        is_file($rolesFile) || fail("the template has no site types (waas-client-data/roles.json), so the plugins chosen can't be switched on");
        $roles = json_decode((string) file_get_contents($rolesFile), true);
        is_array($roles) && $roles || fail('the template roles.json is not readable');
        $known = array_map('strval', array_keys($roles));
        $tmp = tempDir();
        $created = [];
        $files = [];
        foreach ($plugins as $p) {
            $slug = (string) ($p['slug'] ?? '');
            preg_match('/^[a-z0-9][a-z0-9-]{0,99}$/', $slug) || fail("bad plugin slug $slug");
            $types = array_values(array_map('strval', (array) ($p['siteTypes'] ?? [])));
            $unknown = array_diff($types, $known);
            if ($unknown) fail("$slug: the template has no site type " . implode(', ', $unknown) . ' (it has ' . implode(', ', $known) . ')');
            $applies = fn (string $key) => !$types || in_array($key, $types, true);
            if (($p['action'] ?? '') === 'add') {
                curlTransfer((string) $p['url'], "$tmp/$slug.zip", false);
                hash_file('sha256', "$tmp/$slug.zip") === ($p['sha256'] ?? '') || fail("$slug: the zip does not match its SHA-256");
                mkdir("$tmp/$slug");
                extract_archive("$tmp/$slug.zip", "$tmp/$slug");
                is_dir("$tmp/$slug/$slug") || fail("$slug: the zip has no $slug folder");
                if (!is_dir(CONTENT . "/plugins/$slug")) $created[] = $slug;
                run('rm -rf ' . escapeshellarg(CONTENT . "/plugins/$slug") . ' && cp -a ' . escapeshellarg("$tmp/$slug/$slug") . ' ' . escapeshellarg(CONTENT . '/plugins/'));
                $file = plugin_main_file($slug) ?? fail("$slug: no plugin file with a Plugin Name header");
                $files[$slug] = $file;
                foreach ($roles as $key => $role) {
                    if (!$applies((string) $key) || !is_array($role)) continue;
                    $list = array_values(array_filter((array) ($role['plugins'] ?? []), 'is_string'));
                    if (!in_array($file, $list, true)) $list[] = $file;
                    $roles[$key]['plugins'] = $list;
                }
            } else {
                foreach ($roles as $key => $role) {
                    if (!$applies((string) $key) || !is_array($role)) continue;
                    $roles[$key]['plugins'] = array_values(array_filter((array) ($role['plugins'] ?? []), fn ($f) => is_string($f) && !str_starts_with($f, "$slug/")));
                }
            }
        }
        copy($rolesFile, $baseFile) || fail('cannot keep the template roles.json');
        file_put_contents($rolesFile, json_encode($roles, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n") !== false || fail('cannot write roles.json');
        file_put_contents($addedFile, json_encode(['created' => $created, 'files' => $files], JSON_UNESCAPED_SLASHES)) !== false || fail('cannot write plugin-choices.json');
        done(['files' => (object) $files]);
    }

    case 'code-export': {
        $tmp = tempDir();
        $zip = new ZipArchive();
        $zip->open("$tmp/code.zip", ZipArchive::CREATE) === true || fail('cannot create zip');
        zip_dir($zip, CONTENT . '/plugins', 'wp-content/plugins');
        zip_dir($zip, CONTENT . '/themes', 'wp-content/themes');
        $zip->addFromString('wp-content/.waas-code', gmdate('c'));
        $zip->close() || fail('cannot write zip');
        curlTransfer($args['url'], "$tmp/code.zip", true);
        done();
    }

    case 'code-import': {
        $tmp = tempDir();
        curlTransfer($args['url'], "$tmp/code.zip", false);
        mkdir("$tmp/x");
        extract_archive("$tmp/code.zip", "$tmp/x");
        foreach (['plugins', 'themes'] as $dir) {
            if (!is_dir("$tmp/x/wp-content/$dir")) continue;
            run('rm -rf ' . CONTENT . "/$dir && cp -a " . escapeshellarg("$tmp/x/wp-content/$dir") . ' ' . CONTENT . "/$dir");
        }
        done();
    }

    case 'usage': {
        // What the store uses against its plan (the waas-plan mu-plugin), with storage measured now, as the
        // mu-plugin's daily measurement does, and saved for it.
        $bytes = 0;
        $dirs = new RecursiveCallbackFilterIterator(
            new RecursiveDirectoryIterator(CONTENT, FilesystemIterator::SKIP_DOTS),
            fn ($file, $path) => $path !== CONTENT . '/cache'
        );
        foreach (new RecursiveIteratorIterator($dirs, RecursiveIteratorIterator::LEAVES_ONLY, RecursiveIteratorIterator::CATCH_GET_CHILD) as $file) {
            if ($file->isFile() && !$file->isLink()) $bytes += $file->getSize();
        }
        $db = wp('db', 'query', 'SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE()', '--skip-column-names');
        preg_match('/(\d+)\s*$/', $db, $m) || fail('could not read the database size');
        $bytes += (int) $m[1];
        $at = time();
        wp('option', 'update', 'waas_plan_usage', json_encode(['bytes' => $bytes, 'at' => $at]), '--format=json', '--autoload=no');
        $month = gmdate('Y-m');
        $mail = json_decode((string) wpMayFail('option', 'get', 'waas_plan_mail', '--format=json'), true);
        // The higher of the store's own count and the platform's, as the mu-plugin goes by.
        $platformSent = mail_platform($month);
        $sent = max(is_array($mail) && ($mail['month'] ?? '') === $month ? (int) ($mail['sent'] ?? 0) : 0, $platformSent);
        // Email packs, with the pack emails used counted as the mu-plugin does: a past month it has not closed yet
        // (nothing sent since), then this month so far.
        $packs = mail_packs();
        $plan = (int) getenv('WAAS_EMAILS_PER_MONTH');
        $used = $packs['used'];
        if ($plan > 0) {
            if (is_array($mail) && ($mail['month'] ?? '') !== $month) {
                $closed = max((int) ($mail['sent'] ?? 0), mail_platform((string) ($mail['month'] ?? '')));
                $used += min(max(0, $closed - $plan), max(0, $packs['purchased'] - $used));
            }
            $used += min(max(0, $sent - $plan), max(0, $packs['purchased'] - $used));
        }
        done([
            'storageBytes' => $bytes, 'measuredAt' => gmdate('c', $at), 'mailMonth' => $month, 'mailSent' => $sent,
            'platformSent' => $platformSent, 'packPurchased' => $packs['purchased'], 'packUsed' => $used,
        ]);
    }

    case 'mail-packs': {
        // The total of the email packs bought for the store (the API's record), keeping the store's own count of
        // the pack emails it used (the waas-plan mu-plugin).
        $purchased = $args['purchased'] ?? null;
        if (!is_int($purchased) || $purchased < 0) fail('purchased must be a whole number');
        $used = mail_packs()['used'];
        wp('option', 'update', 'waas_plan_mail_packs', json_encode(['purchased' => $purchased, 'used' => $used]), '--format=json', '--autoload=no');
        done(['purchased' => $purchased, 'used' => $used]);
    }

    case 'mail-count': {
        // This month's emails as the platform counted them on the relay (the API's hourly mail-count job). The
        // waas-plan mu-plugin goes by the higher of it and the store's own count.
        $month = $args['month'] ?? null;
        $sent = $args['sent'] ?? null;
        if (!is_string($month) || !preg_match('/^\d{4}-\d{2}$/', $month)) fail('month must be YYYY-MM');
        if (!is_int($sent) || $sent < 0) fail('sent must be a whole number');
        wp('option', 'update', 'waas_plan_mail_platform', json_encode(['month' => $month, 'sent' => $sent]), '--format=json', '--autoload=no');
        done(['month' => $month, 'sent' => $sent]);
    }

    case 'update-db':
        wp('core', 'update-db');
        done();

    case 'suspend':
        install_guard(is_array($args['brand'] ?? null) ? $args['brand'] : DEFAULT_BRAND);
        touch(FLAG) || fail('cannot write the suspension flag');
        done();

    case 'resume':
        install_guard();
        if (file_exists(FLAG)) unlink(FLAG) || fail('cannot remove the suspension flag');
        done();

    default:
        fail("unknown operation $op");
}

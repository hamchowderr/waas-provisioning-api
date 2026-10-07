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

const ROOT = '/var/www/html';
const CONTENT = ROOT . '/wp-content';
const FLAG = CONTENT . '/.waas-suspended';
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
    $proc = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($proc)) fail('could not start a process');
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
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
        if ($rel === '.waas-suspended' || preg_match('#^(cache|upgrade|upgrade-temp-backup)(/|$)#', $rel)) continue;
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

/** The mu-plugin and .htaccess block behind suspension and redirect domains. */
function install_guard(): void
{
    @mkdir(CONTENT . '/mu-plugins', 0755, true);
    file_put_contents(CONTENT . '/mu-plugins/waas-guard.php', <<<'PHP'
<?php
/*
 * Plugin Name: WaaS store guard
 * Description: Suspension (503) and redirect domains (301). Managed by the WaaS provisioner; edits are overwritten.
 */
if (defined('WP_CLI') && WP_CLI) return;
if (file_exists(WP_CONTENT_DIR . '/.waas-suspended')) {
    header('HTTP/1.1 503 Service Unavailable', true, 503);
    header('Content-Type: text/plain; charset=utf-8');
    header('Retry-After: 3600');
    echo "Store unavailable\n";
    exit;
}
$waas_home = strtolower((string) parse_url((string) get_option('home'), PHP_URL_HOST));
$waas_host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
if ($waas_home !== '' && $waas_host !== '' && $waas_host !== $waas_home) {
    header('Location: https://' . $waas_home . ($_SERVER['REQUEST_URI'] ?? '/'), true, 301);
    exit;
}
PHP);
    $block = "# BEGIN WaaS\n<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteCond %{DOCUMENT_ROOT}/wp-content/.waas-suspended -f\nRewriteRule ^ - [R=503,L]\n</IfModule>\nErrorDocument 503 \"Store unavailable\"\n# END WaaS\n";
    $htaccess = ROOT . '/.htaccess';
    $current = is_file($htaccess) ? file_get_contents($htaccess) : '';
    $current = preg_replace('/# BEGIN WaaS\n.*?# END WaaS\n/s', '', $current);
    file_put_contents($htaccess, $block . $current);
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
        // A snapshot, base snapshot, backup or uploaded archive: database.sql and wp-content.
        $tmp = tempDir();
        curlTransfer($args['url'], "$tmp/archive", false);
        mkdir("$tmp/x");
        extract_archive("$tmp/archive", "$tmp/x");
        $suspended = file_exists(FLAG);
        $content = find_content("$tmp/x");
        if ($content) {
            run('rm -rf ' . CONTENT . '/* ' . CONTENT . '/.[!.]*', true);
            run('cp -a ' . escapeshellarg($content) . '/. ' . CONTENT . '/');
        }
        $sql = is_file("$tmp/x/database.sql") ? "$tmp/x/database.sql" : null;
        if ($sql) {
            wpMayFail('db', 'clean', '--yes');
            wp('db', 'import', $sql);
        } elseif (wpMayFail('core', 'is-installed') === null) {
            wp('core', 'install', '--url=' . $args['home'], '--title=' . ($args['title'] ?? 'Store'), '--admin_user=waas-admin',
                '--admin_email=' . ($args['adminEmail'] ?? 'admin@example.invalid'), '--admin_password=' . bin2hex(random_bytes(24)), '--skip-email');
        }
        set_home($args['home']);
        if ($suspended) touch(FLAG); else @unlink(FLAG);
        install_guard();
        done(['database' => $sql !== null, 'content' => $content !== null]);
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

    case 'update-db':
        wp('core', 'update-db');
        done();

    case 'suspend':
        install_guard();
        touch(FLAG) || fail('cannot write the suspension flag');
        done();

    case 'resume':
        install_guard();
        if (file_exists(FLAG)) unlink(FLAG) || fail('cannot remove the suspension flag');
        done();

    default:
        fail("unknown operation $op");
}

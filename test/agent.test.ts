import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs the store agent's suspend and resume against a scratch WordPress root. Needs a php binary.
const AGENT = fileURLToPath(new URL('../src/provisioner/coolify/agent.php', import.meta.url));
const hasPhp = (() => {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPhp)('store agent: suspension page', () => {
  let root: string;
  const content = () => join(root, 'wp-content');
  const agent = (op: string, args: unknown = {}) => {
    const out = execFileSync('php', [AGENT, op, Buffer.from(JSON.stringify(args)).toString('base64')], {
      env: { ...process.env, WAAS_ROOT: root },
      encoding: 'utf8',
    });
    expect(out).toMatch(/^WAAS_RESULT /m);
  };
  /** What the guard mu-plugin prints for a page load. */
  const guard = () =>
    execFileSync('php', ['-r', `define('WP_CONTENT_DIR', ${JSON.stringify(content())}); function get_option() { return ''; } include WP_CONTENT_DIR . '/mu-plugins/waas-guard.php'; echo 'SERVED';`], {
      encoding: 'utf8',
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'waas-agent-'));
    mkdirSync(content());
    // The agent drops to uid 33 when run as root.
    chmodSync(root, 0o777);
    chmodSync(content(), 0o777);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('shows the AnyPress page while suspended, and the site again once resumed', () => {
    agent('suspend', { brand: { name: 'AnyPress' } });
    expect(existsSync(join(content(), '.waas-suspended'))).toBe(true);
    const page = guard();
    expect(page).toContain('This website is temporarily unavailable');
    expect(page).toContain('<span class="brand">AnyPress</span>');
    expect(page).not.toContain('SERVED');
    const htaccess = readFileSync(join(root, '.htaccess'), 'utf8');
    expect(htaccess).toContain('ErrorDocument 503 /wp-content/waas-unavailable.html');
    expect(htaccess).toContain('RewriteCond %{REQUEST_URI} !^/wp-content/waas-unavailable\\.html$');

    agent('resume');
    expect(existsSync(join(content(), '.waas-suspended'))).toBe(false);
    expect(guard()).toBe('SERVED');
  });

  it('escapes the brand and links it only to an http(s) URL', () => {
    agent('suspend', { brand: { name: 'R&D <Hosting>', url: 'https://host.example/' } });
    expect(guard()).toContain('<a class="brand" href="https://host.example/">R&amp;D &lt;Hosting&gt;</a>');
    agent('suspend', { brand: { name: 'Evil', url: 'javascript:alert(1)' } });
    const page = guard();
    expect(page).toContain('<span class="brand">Evil</span>');
    expect(page).not.toContain('javascript:');
  });

  it('keeps the branded page when the guard is reinstalled without a brand', () => {
    agent('suspend', { brand: { name: 'Reseller Co' } });
    agent('resume');
    agent('suspend', {});
    expect(guard()).toContain('AnyPress');
    agent('suspend', { brand: { name: 'Reseller Co' } });
    agent('configure', {});
    expect(guard()).toContain('Reseller Co');
  });
});

describe.skipIf(!hasPhp)('store agent: mail mu-plugin', () => {
  let root: string;
  const relay = { host: 'smtp.resend.com', port: 465, user: 'resend', pass: 're_test_not_real', from: 'store@mail.example' };
  /** Loads the mu-plugin with a stand-in WordPress and PHPMailer, sends one message, and prints the mailer's state. */
  const send = (env: Record<string, string>, message: { from: string; fromName: string; replyTo?: string }) =>
    JSON.parse(
      execFileSync(
        'php',
        [
          '-r',
          `
          $hooks = [];
          function add_action($hook, $fn) { global $hooks; $hooks[$hook] = $fn; }
          function get_option($name) { return ['blogname' => 'Ann &amp; Co', 'home' => 'https://www.shop.example'][$name]; }
          function wp_specialchars_decode($s) { return html_entity_decode($s); }
          class Mailer {
            public $From; public $FromName; public $Sender = ''; public $Host; public $Port; public $SMTPSecure; public $SMTPAuth; public $Username; public $Password;
            public $mailer = 'mail'; public $replyTo = [];
            function isSMTP() { $this->mailer = 'smtp'; }
            function getReplyToAddresses() { return $this->replyTo; }
            function addReplyTo($a, $n) { $this->replyTo[$a] = $n; }
            function setFrom($a, $n, $auto) { $this->From = $a; $this->FromName = $n; }
          }
          include ${JSON.stringify(join(root, 'wp-content/mu-plugins/waas-mail.php'))};
          $m = new Mailer();
          $m->From = ${JSON.stringify(message.from)};
          $m->FromName = ${JSON.stringify(message.fromName)};
          ${message.replyTo ? `$m->replyTo = [${JSON.stringify(message.replyTo)} => ''];` : ''}
          if (isset($hooks['phpmailer_init'])) $hooks['phpmailer_init']($m);
          echo json_encode(get_object_vars($m));
          `,
        ],
        { env: { ...process.env, ...env }, encoding: 'utf8' },
      ),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'waas-agent-'));
    mkdirSync(join(root, 'wp-content'));
    chmodSync(root, 0o777);
    chmodSync(join(root, 'wp-content'), 0o777);
    execFileSync('php', [AGENT, 'configure', Buffer.from('{}').toString('base64')], { env: { ...process.env, WAAS_ROOT: root } });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const withRelay = { WAAS_MAIL_B64: Buffer.from(JSON.stringify(relay)).toString('base64') };

  it('sends through the relay from its address, under the store name, with replies to the store', () => {
    const m = send(withRelay, { from: 'owner@gmail.example', fromName: 'WordPress' });
    expect(m).toMatchObject({ mailer: 'smtp', Host: 'smtp.resend.com', Port: 465, SMTPSecure: 'ssl', SMTPAuth: true, Username: 'resend', Password: 're_test_not_real' });
    expect(m).toMatchObject({ From: 'store@mail.example', Sender: 'store@mail.example', FromName: 'Ann & Co', replyTo: { 'owner@gmail.example': 'Ann & Co' } });
  });

  it("keeps a plugin's sender name and Reply-To, and adds no Reply-To for WordPress's default sender", () => {
    expect(send(withRelay, { from: 'owner@gmail.example', fromName: 'Ann Shop', replyTo: 'help@shop.example' })).toMatchObject({
      FromName: 'Ann Shop',
      replyTo: { 'help@shop.example': '' },
    });
    expect(send(withRelay, { from: 'wordpress@shop.example', fromName: 'WordPress' }).replyTo).toEqual([]);
  });

  it('uses STARTTLS on other ports', () => {
    const env = { WAAS_MAIL_B64: Buffer.from(JSON.stringify({ ...relay, port: 587 })).toString('base64') };
    expect(send(env, { from: 'a@b.example', fromName: 'x' })).toMatchObject({ Port: 587, SMTPSecure: 'tls' });
  });

  it('changes nothing without relay settings (version sites)', () => {
    expect(send({ WAAS_MAIL_B64: '' }, { from: 'a@b.example', fromName: 'x' })).toMatchObject({ mailer: 'mail', From: 'a@b.example', Host: null });
  });
});

describe.skipIf(!hasPhp)('store agent: page cache', () => {
  let root: string;
  let server: ChildProcess;
  let base: string;
  const content = () => join(root, 'wp-content');
  const configure = () => execFileSync('php', [AGENT, 'configure', Buffer.from('{}').toString('base64')], { env: { ...process.env, WAAS_ROOT: root } });
  /**
   * A stand-in WordPress behind PHP's built-in web server: the drop-in first (which may answer from the cache and
   * exit), then the mu-plugin, the page and the end of the request. Test headers say what WordPress would do:
   * x-body is the page, x-logged-in a logged-in user, x-change a save_post of that post type, x-status the status.
   */
  const ROUTER = `<?php
$hooks = [];
function add_action($hook, $fn, $priority = 10, $args = 1) { global $hooks; $hooks[$hook][] = $fn; }
function do_action($hook, ...$args) { global $hooks; foreach ($hooks[$hook] ?? [] as $fn) $fn(...$args); }
function is_user_logged_in() { return isset($_SERVER['HTTP_X_LOGGED_IN']); }
foreach (['is_search', 'is_404', 'is_feed', 'is_preview', 'is_robots', 'is_trackback', 'is_singular', 'post_password_required'] as $fn) eval("function $fn() { return false; }");
function get_option($name) { return $name === 'fluent_cart_store_settings' ? ['checkout_page_id' => 7, 'cart_page_id' => 0] : false; }
function get_permalink($id) { return 'https://shop.example/checkout/'; }
define('WP_CONTENT_DIR', getenv('WAAS_TEST_CONTENT'));
include WP_CONTENT_DIR . '/advanced-cache.php';
include WP_CONTENT_DIR . '/mu-plugins/waas-cache.php';
http_response_code((int) ($_SERVER['HTTP_X_STATUS'] ?? 200));
do_action('template_redirect');
if (isset($_SERVER['HTTP_X_CHANGE'])) do_action('save_post', 1, (object) ['post_type' => $_SERVER['HTTP_X_CHANGE']]);
echo $_SERVER['HTTP_X_BODY'] ?? '<html>fresh</html>';
while (ob_get_level()) ob_end_flush();
do_action('shutdown');
`;
  const visit = async (path = '/', headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { headers: { host: 'shop.example', ...headers } });
    return { body: await res.text(), cache: res.headers.get('x-waas-cache') };
  };
  const saved = () => (existsSync(join(content(), 'cache/waas-pages')) ? readdirSync(join(content(), 'cache/waas-pages')) : []);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'waas-agent-'));
    mkdirSync(content());
    chmodSync(root, 0o777);
    chmodSync(content(), 0o777);
    configure();
    // The web server here runs as the test's user while the agent drops to uid 33; in a store both are www-data.
    mkdirSync(join(content(), 'cache/waas-pages'), { recursive: true });
    chmodSync(join(content(), 'cache/waas-pages'), 0o777);
    writeFileSync(join(root, 'router.php'), ROUTER);
    const port = 20000 + Math.floor(Math.random() * 20000);
    base = `http://127.0.0.1:${port}`;
    server = spawn('php', ['-S', `127.0.0.1:${port}`, join(root, 'router.php')], { env: { ...process.env, WAAS_TEST_CONTENT: content() }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      if (await fetch(base + '/ready', { method: 'POST' }).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  afterEach(() => {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  });

  it('saves a page for a logged-out visitor and serves the next visitor the saved copy', async () => {
    expect(await visit('/about/', { 'x-body': '<html>first</html>' })).toEqual({ body: '<html>first</html>', cache: null });
    expect(saved()).toHaveLength(1);
    expect(await visit('/about/', { 'x-body': '<html>second</html>', cookie: '_ga=GA1.1' })).toEqual({ body: '<html>first</html>', cache: 'hit' });
  });

  it('never serves or saves the cache for logged-in visitors, carts, query strings or checkout', async () => {
    await visit('/about/', { 'x-body': '<html>first</html>' });
    expect((await visit('/about/', { 'x-body': '<html>mine</html>', cookie: 'wordpress_logged_in_abc=1' })).body).toBe('<html>mine</html>');
    expect((await visit('/about/', { 'x-body': '<html>cart</html>', cookie: 'fct_cart_hash=xyz' })).body).toBe('<html>cart</html>');
    expect((await visit('/about/?s=shoes', { 'x-body': '<html>search</html>' })).body).toBe('<html>search</html>');
    await visit('/checkout/', { 'x-body': '<html>checkout</html>' });
    await visit('/checkout/step/', { 'x-body': '<html>checkout</html>' });
    await visit('/private/', { 'x-body': '<html>private</html>', 'x-logged-in': '1' });
    await visit('/missing/', { 'x-body': '<html>nope</html>', 'x-status': '404' });
    await visit('/partial/', { 'x-body': 'not a whole page' });
    expect(saved()).toHaveLength(1);
  });

  it('clears saved pages when content changes, but not for internal post types', async () => {
    await visit('/about/');
    await visit('/other/', { 'x-change': 'oembed_cache' });
    expect(saved()).toHaveLength(2);
    await visit('/third/', { 'x-change': 'page', cookie: 'wordpress_logged_in_abc=1' });
    expect(saved()).toHaveLength(0);
  });

  it('serves nothing from the cache while the store is suspended, and configure clears it', async () => {
    await visit('/about/', { 'x-body': '<html>first</html>' });
    writeFileSync(join(content(), '.waas-suspended'), '');
    expect((await visit('/about/', { 'x-body': '<html>live</html>' })).cache).toBeNull();
    configure();
    expect(saved()).toHaveLength(0);
  });

  it("leaves another cache plugin's drop-in alone", () => {
    writeFileSync(join(content(), 'advanced-cache.php'), '<?php // Another cache plugin');
    configure();
    expect(readFileSync(join(content(), 'advanced-cache.php'), 'utf8')).toBe('<?php // Another cache plugin');
  });
});

describe.skipIf(!hasPhp)('store agent: plan mu-plugin', () => {
  let root: string;
  const content = () => join(root, 'wp-content');
  const GB = 1024 ** 3;
  const month = () => new Date().toISOString().slice(0, 7);
  /**
   * Loads the mu-plugin with a stand-in WordPress holding `options`, runs `script`, and returns the options after it
   * and what the script printed. The database is 1000 bytes.
   */
  const plan = (env: Record<string, string>, options: Record<string, unknown>, script: string) =>
    JSON.parse(
      execFileSync(
        'php',
        [
          // The mail quota logs to the PHP error log; keep it out of the test output.
          '-d',
          'error_log=/dev/null',
          '-r',
          `
          $hooks = [];
          $options = json_decode(${JSON.stringify(JSON.stringify(options))}, true);
          function add_action($hook, $fn) { global $hooks; $hooks[$hook][] = $fn; }
          function add_filter($hook, $fn) { global $hooks; $hooks[$hook][] = $fn; }
          function apply_filters($hook, $value) { global $hooks; foreach ($hooks[$hook] ?? [] as $fn) $value = $fn($value); return $value; }
          function do_action($hook) { global $hooks; foreach ($hooks[$hook] ?? [] as $fn) $fn(); }
          function get_option($name) { global $options; return $options[$name] ?? false; }
          function update_option($name, $value, $autoload = null) { global $options; $options[$name] = $value; return true; }
          function wp_next_scheduled($hook) { global $options; return $options['cron'][$hook] ?? false; }
          function wp_schedule_event($time, $recurrence, $hook) { global $options; $options['cron'][$hook] = $recurrence; }
          function current_user_can($cap) { return true; }
          function esc_html($s) { return htmlspecialchars($s); }
          class StandInDb { function prepare($sql, ...$args) { return $sql; } function get_var($sql) { return '1000'; } }
          $wpdb = new StandInDb();
          define('WP_CONTENT_DIR', ${JSON.stringify(content())});
          define('DB_NAME', 'wordpress');
          include WP_CONTENT_DIR . '/mu-plugins/waas-plan.php';
          ob_start();
          ${script}
          echo json_encode(['options' => $options, 'out' => ob_get_clean()]);
          `,
        ],
        { env: { ...process.env, WAAS_STORAGE_GB: '', WAAS_EMAILS_PER_MONTH: '', ...env }, encoding: 'utf8' },
      ),
    );
  const quotas = { WAAS_STORAGE_GB: '1', WAAS_EMAILS_PER_MONTH: '10' };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'waas-agent-'));
    mkdirSync(content());
    chmodSync(root, 0o777);
    chmodSync(content(), 0o777);
    execFileSync('php', [AGENT, 'configure', Buffer.from('{}').toString('base64')], { env: { ...process.env, WAAS_ROOT: root } });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('does nothing without quotas (version sites)', () => {
    expect(plan({}, {}, `echo json_encode(array_keys($hooks));`).out).toBe('[]');
  });

  it('measures wp-content without its caches, plus the database, once a day', () => {
    mkdirSync(join(content(), 'uploads'));
    writeFileSync(join(content(), 'uploads/photo.jpg'), Buffer.alloc(3000));
    mkdirSync(join(content(), 'cache/waas-pages'), { recursive: true });
    writeFileSync(join(content(), 'cache/waas-pages/a.html'), Buffer.alloc(50000));
    // Everything in wp-content but the cache: the photo and the files the agent installed.
    const files = readdirSync(content(), { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile() && !join(f.parentPath, f.name).startsWith(join(content(), 'cache')))
      .reduce((sum, f) => sum + statSync(join(f.parentPath, f.name)).size, 0);
    const { options } = plan(quotas, {}, `do_action('init'); do_action('waas_plan_measure');`);
    expect(options.cron).toEqual({ waas_plan_measure: 'daily' });
    expect(options.waas_plan_usage.bytes).toBe(files + 1000);
    expect(files).toBeLessThan(50000);
  });

  it('refuses an upload past the storage, counts the ones it lets through, and warns from 80%', () => {
    const usage = { waas_plan_usage: { bytes: GB - 100, at: 1 } };
    const upload = (size: number) => `echo json_encode(apply_filters('wp_handle_upload_prefilter', ['name' => 'a.jpg', 'size' => ${size}, 'error' => 0]));`;
    expect(JSON.parse(plan(quotas, usage, upload(50)).out)).toEqual({ name: 'a.jpg', size: 50, error: 0 });
    expect(JSON.parse(plan(quotas, usage, upload(200)).out).error).toBe(
      'This website has used its 1 GB of storage. Delete files you no longer need, or move to a bigger plan, to upload more.',
    );
    // Sideloads (media from a URL) too.
    expect(JSON.parse(plan(quotas, usage, upload(200).replace('wp_handle_upload_prefilter', 'wp_handle_sideload_prefilter')).out).error).toContain('1 GB');

    writeFileSync(join(root, 'up.jpg'), Buffer.alloc(70));
    const { options } = plan(quotas, usage, `apply_filters('wp_handle_upload', ['file' => ${JSON.stringify(join(root, 'up.jpg'))}]);`);
    expect(options.waas_plan_usage.bytes).toBe(GB - 30);

    expect(plan(quotas, { waas_plan_usage: { bytes: Math.ceil(0.85 * GB) } }, `do_action('admin_notices');`).out).toBe(
      '<div class="notice notice-warning"><p>This website has used 85% of its 1 GB of storage. Delete files you no longer need, or move to a bigger plan, before uploads stop.</p></div>',
    );
    expect(plan(quotas, { waas_plan_usage: { bytes: GB } }, `do_action('admin_notices');`).out).toContain('notice-error');
    expect(plan(quotas, { waas_plan_usage: { bytes: 0.5 * GB } }, `do_action('admin_notices');`).out).toBe('');
  });

  it('counts email per month and pauses only bulk email past the quota', () => {
    const send = `echo json_encode(apply_filters('pre_wp_mail', null)); do_action('wp_mail_succeeded');`;
    const bulk = `echo json_encode(apply_filters('fluent_crm/disable_email_processing', false));`;
    const { options, out } = plan(quotas, { waas_plan_mail: { month: month(), sent: 8 } }, send);
    expect(out).toBe('null');
    expect(options.waas_plan_mail).toEqual({ month: month(), sent: 9 });
    expect(plan(quotas, { waas_plan_mail: { month: month(), sent: 9 } }, bulk).out).toBe('false');

    // Used up: FluentCRM's campaigns and sequences wait; other email still goes out.
    const full = { waas_plan_mail: { month: month(), sent: 10 } };
    expect(plan(quotas, full, bulk).out).toBe('true');
    expect(plan(quotas, full, `echo json_encode(apply_filters('pre_wp_mail', null));`).out).toBe('null');
    expect(plan(quotas, full, `do_action('admin_notices');`).out).toContain('has sent all 10 of the emails its plan includes this month. Campaigns and sequences are paused until');
    expect(plan(quotas, { waas_plan_mail: { month: month(), sent: 8 } }, `do_action('admin_notices');`).out).toContain('has sent 8 of the 10 emails its plan includes');
    // Last month's count doesn't pause this month's.
    expect(plan(quotas, { waas_plan_mail: { month: '2000-01', sent: 99 } }, bulk).out).toBe('false');

    // A new month starts again at 0.
    const old = plan(quotas, { waas_plan_mail: { month: '2000-01', sent: 99 } }, send);
    expect(old.out).toBe('null');
    expect(old.options.waas_plan_mail).toEqual({ month: month(), sent: 1 });
  });

  it('reports usage through the agent, measuring storage now and saving it for the mu-plugin', () => {
    const bin = mkdtempSync(join(tmpdir(), 'waas-bin-'));
    chmodSync(bin, 0o755);
    // A stand-in WP-CLI: the database is 2048 bytes, and this month 7 emails went out.
    writeFileSync(
      join(bin, 'wp'),
      `#!/bin/sh
case "$*" in
  *"db query"*) echo 2048 ;;
  *"option update waas_plan_usage"*) printf '%s' "$7" > "$WAAS_ROOT/usage.json" ;;
  *"option get waas_plan_mail"*) echo '{"month":"${month()}","sent":7}' ;;
esac
`,
    );
    chmodSync(join(bin, 'wp'), 0o755);
    mkdirSync(join(content(), 'uploads'));
    writeFileSync(join(content(), 'uploads/photo.jpg'), Buffer.alloc(3000));
    try {
      const out = execFileSync('php', [AGENT, 'usage', Buffer.from('{}').toString('base64')], {
        env: { ...process.env, WAAS_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      });
      const result = JSON.parse(/^WAAS_RESULT (.*)$/m.exec(out)![1]!);
      expect(result).toMatchObject({ mailMonth: month(), mailSent: 7 });
      expect(result.storageBytes).toBeGreaterThan(3000 + 2048);
      expect(new Date(result.measuredAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(JSON.parse(readFileSync(join(root, 'usage.json'), 'utf8')).bytes).toBe(result.storageBytes);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

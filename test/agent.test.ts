import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const send = (env: Record<string, string>, message: { from: string; fromName: string; replyTo?: string }, adminEmail = 'owner@shop.example') =>
    JSON.parse(
      execFileSync(
        'php',
        [
          '-r',
          `
          $hooks = [];
          function add_action($hook, $fn) { global $hooks; $hooks[$hook] = $fn; }
          function get_option($name) { return ['blogname' => 'Ann &amp; Co', 'home' => 'https://www.shop.example', 'admin_email' => ${JSON.stringify(adminEmail)}][$name]; }
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

  it("keeps a plugin's sender name and Reply-To, and sends replies to WordPress's default sender to the administrator", () => {
    expect(send(withRelay, { from: 'owner@gmail.example', fromName: 'Ann Shop', replyTo: 'help@shop.example' })).toMatchObject({
      FromName: 'Ann Shop',
      replyTo: { 'help@shop.example': '' },
    });
    // Nobody reads the store's own address on the relay's domain.
    expect(send(withRelay, { from: 'wordpress@shop.example', fromName: 'WordPress' }).replyTo).toEqual({ 'owner@shop.example': 'Ann & Co' });
    expect(send(withRelay, { from: relay.from, fromName: 'WordPress' }).replyTo).toEqual({ 'owner@shop.example': 'Ann & Co' });
    expect(send(withRelay, { from: 'wordpress@shop.example', fromName: 'WordPress' }, 'not an address').replyTo).toEqual([]);
  });

  it('uses STARTTLS on other ports', () => {
    const env = { WAAS_MAIL_B64: Buffer.from(JSON.stringify({ ...relay, port: 587 })).toString('base64') };
    expect(send(env, { from: 'a@b.example', fromName: 'x' })).toMatchObject({ Port: 587, SMTPSecure: 'tls' });
  });

  it('changes nothing without relay settings (version sites)', () => {
    expect(send({ WAAS_MAIL_B64: '' }, { from: 'a@b.example', fromName: 'x' })).toMatchObject({ mailer: 'mail', From: 'a@b.example', Host: null });
  });

  /**
   * Loads the mu-plugin with a stand-in WordPress holding `options` and FluentCart's email settings, runs one page
   * load, and prints both afterwards.
   */
  const pageLoad = (from: string, options: Record<string, unknown>, cart: Record<string, string>) =>
    JSON.parse(
      execFileSync(
        'php',
        [
          '-r',
          `
          namespace FluentCart\\App\\Services\\Email { class EmailNotifications {
            static $s = [];
            static function getSettings() { return self::$s; }
            static function updateSettings($d) { self::$s = array_merge(self::$s, $d); }
          } }
          namespace {
          $hooks = [];
          $options = json_decode(${JSON.stringify(JSON.stringify(options))}, true);
          function add_action($hook, $fn) { global $hooks; $hooks[$hook] = $fn; }
          function get_option($name, $default = false) { global $options; return $options[$name] ?? $default; }
          function update_option($name, $value) { global $options; $options[$name] = $value; }
          function is_email($e) { return filter_var($e, FILTER_VALIDATE_EMAIL) !== false; }
          function wp_specialchars_decode($s) { return html_entity_decode($s); }
          \\FluentCart\\App\\Services\\Email\\EmailNotifications::$s = json_decode(${JSON.stringify(JSON.stringify(cart))}, true);
          include ${JSON.stringify(join(root, 'wp-content/mu-plugins/waas-mail.php'))};
          $hooks['plugins_loaded']();
          $hooks['init']();
          echo json_encode(['options' => $options, 'cart' => \\FluentCart\\App\\Services\\Email\\EmailNotifications::getSettings()]);
          }
          `,
        ],
        { env: { ...process.env, WAAS_MAIL_B64: Buffer.from(JSON.stringify({ ...relay, from })).toString('base64') }, encoding: 'utf8' },
      ),
    );

  it("fills in a plugin's sender with the store's name, sending address and administrator, and keeps what the owner typed", () => {
    const store = { blogname: 'Ann &amp; Co', admin_email: 'owner@shop.example', active_plugins: ['fluent-cart/fluent-cart.php'] };
    // What older stores got from the store template: the owner's email as the From.
    const first = pageLoad('ann@anypress.example', store, { from_name: 'Ann & Co', from_email: 'owner@shop.example', reply_to_name: '', reply_to_email: '' });
    expect(first.cart).toEqual({ from_name: 'Ann & Co', from_email: 'ann@anypress.example', reply_to_name: 'Ann & Co', reply_to_email: 'owner@shop.example' });

    // The owner changes the From name; then their own domain is verified and the store is renamed.
    const later = pageLoad('no-reply@ann.example', { ...first.options, blogname: 'Ann and Co' }, { ...first.cart, from_name: 'Ann Orders' });
    expect(later.cart).toEqual({ from_name: 'Ann Orders', from_email: 'no-reply@ann.example', reply_to_name: 'Ann and Co', reply_to_email: 'owner@shop.example' });

    // Nothing changed since: a value set by hand in the meantime stays, even one the mu-plugin would otherwise set.
    const again = pageLoad('no-reply@ann.example', later.options, { ...later.cart, reply_to_email: '' });
    expect(again.cart.reply_to_email).toBe('');
  });

  it('leaves the Reply-To empty while the store has no administration email', () => {
    const { cart } = pageLoad('ann@anypress.example', { blogname: 'Ann', admin_email: 'admin@example.invalid', active_plugins: [] }, {});
    expect(cart).toEqual({ from_name: 'Ann', from_email: 'ann@anypress.example' });
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

  describe('email packs', () => {
    const bulk = `echo json_encode(apply_filters('fluent_crm/disable_email_processing', false));`;
    const notices = `do_action('admin_notices');`;
    const mail = (sent: number, m = month()) => ({ month: m, sent });

    it('lifts the pause until the pack emails left are used too', () => {
      const packs = { waas_plan_mail_packs: { purchased: 5, used: 0 } };
      expect(plan(quotas, { waas_plan_mail: mail(10), ...packs }, bulk).out).toBe('false');
      expect(plan(quotas, { waas_plan_mail: mail(14), ...packs }, bulk).out).toBe('false');
      expect(plan(quotas, { waas_plan_mail: mail(15), ...packs }, bulk).out).toBe('true');
      // Packs used in earlier months are gone.
      expect(plan(quotas, { waas_plan_mail: mail(12), waas_plan_mail_packs: { purchased: 5, used: 3 } }, bulk).out).toBe('true');
      expect(plan(quotas, { waas_plan_mail: mail(11), waas_plan_mail_packs: { purchased: 5, used: 3 } }, bulk).out).toBe('false');
      // Within the month nothing is moved to used.
      expect(plan(quotas, { waas_plan_mail: mail(14), ...packs }, bulk).options.waas_plan_mail_packs).toEqual({ purchased: 5, used: 0 });
    });

    it('says how many pack emails are left', () => {
      const packs = { waas_plan_mail_packs: { purchased: 8000, used: 0 } };
      expect(plan(quotas, { waas_plan_mail: mail(8), ...packs }, notices).out).toBe(
        '<div class="notice notice-warning"><p>This website has sent 8 of the 10 emails its plan includes this month, plus 8,000 pack emails left. Campaigns and sequences pause when both are used up; order, account and booking emails always go out.</p></div>',
      );
      expect(plan(quotas, { waas_plan_mail: mail(12), ...packs }, notices).out).toContain(
        'has sent all 10 of the emails its plan includes this month and is now sending pack emails: 7,998 left.',
      );
      const out = plan(quotas, { waas_plan_mail: mail(8010), ...packs }, notices).out;
      expect(out).toContain('notice-error');
      expect(out).toContain('has sent all 10 of the emails its plan includes this month, and all of its pack emails. Campaigns and sequences are paused until');
      expect(plan(quotas, { waas_plan_mail: mail(5), ...packs }, notices).out).toBe('');
    });

    it('moves last month\'s emails beyond the plan to used when a new month starts, once', () => {
      const first = plan(quotas, { waas_plan_mail: mail(13, '2000-01'), waas_plan_mail_packs: { purchased: 5, used: 1 } }, bulk);
      expect(first.out).toBe('false');
      expect(first.options.waas_plan_mail).toEqual(mail(0));
      expect(first.options.waas_plan_mail_packs).toEqual({ purchased: 5, used: 4 });
      const again = plan(quotas, first.options, bulk);
      expect(again.options.waas_plan_mail_packs).toEqual({ purchased: 5, used: 4 });
      // The first email of the month counts after the move.
      const sent = plan(quotas, { waas_plan_mail: mail(13, '2000-01'), waas_plan_mail_packs: { purchased: 5, used: 1 } }, `do_action('wp_mail_succeeded');`);
      expect(sent.options).toMatchObject({ waas_plan_mail: mail(1), waas_plan_mail_packs: { purchased: 5, used: 4 } });
    });

    it('moves no more than were left, and nothing for a month within the plan or without a plan limit', () => {
      expect(plan(quotas, { waas_plan_mail: mail(40, '2000-01'), waas_plan_mail_packs: { purchased: 5, used: 1 } }, bulk).options.waas_plan_mail_packs).toEqual({
        purchased: 5,
        used: 5,
      });
      const within = plan(quotas, { waas_plan_mail: mail(7, '2000-01'), waas_plan_mail_packs: { purchased: 5, used: 1 } }, bulk);
      expect(within.options.waas_plan_mail_packs).toEqual({ purchased: 5, used: 1 });
      const unlimited = plan({ WAAS_STORAGE_GB: '1', WAAS_EMAILS_PER_MONTH: '0' }, { waas_plan_mail: mail(99, '2000-01'), waas_plan_mail_packs: { purchased: 5, used: 0 } }, bulk + notices);
      expect(unlimited.out).toBe('false');
      expect(unlimited.options.waas_plan_mail_packs).toEqual({ purchased: 5, used: 0 });
    });

    it('sets the total bought through the agent, keeping the pack emails used', () => {
      const bin = mkdtempSync(join(tmpdir(), 'waas-bin-'));
      chmodSync(bin, 0o755);
      const wp = (held: string) =>
        writeFileSync(
          join(bin, 'wp'),
          `#!/bin/sh
case "$*" in
  *"option get waas_plan_mail_packs"*) ${held ? `echo '${held}'` : 'exit 1'} ;;
  *"option update waas_plan_mail_packs"*) printf '%s %s %s' "$7" "$8" "$9" > "$WAAS_ROOT/packs.txt" ;;
esac
`,
          { mode: 0o755 },
        );
      const run = (args: unknown) =>
        execFileSync('php', [AGENT, 'mail-packs', Buffer.from(JSON.stringify(args)).toString('base64')], {
          env: { ...process.env, WAAS_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
          encoding: 'utf8',
        });
      try {
        wp('{"purchased":100,"used":40}');
        expect(run({ purchased: 300 })).toContain('WAAS_RESULT {"purchased":300,"used":40}');
        expect(readFileSync(join(root, 'packs.txt'), 'utf8')).toBe('{"purchased":300,"used":40} --format=json --autoload=no');
        wp('');
        expect(run({ purchased: 50 })).toContain('WAAS_RESULT {"purchased":50,"used":0}');
        for (const bad of [{ purchased: '50' }, { purchased: -1 }, {}]) {
          let stdout = '';
          try {
            run(bad);
          } catch (err) {
            stdout = String((err as { stdout?: string }).stdout);
          }
          expect(stdout).toBe('WAAS_ERROR purchased must be a whole number\n');
        }
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  });

  describe("the platform's count", () => {
    const bulk = `echo json_encode(apply_filters('fluent_crm/disable_email_processing', false));`;
    const notices = `do_action('admin_notices');`;
    const mail = (sent: number, m = month()) => ({ month: m, sent });

    it('goes by the platform count when it is higher than the store\'s own, for this month only', () => {
      // An administrator set the store's own count back; the platform's still pauses bulk email.
      expect(plan(quotas, { waas_plan_mail: mail(2), waas_plan_mail_platform: mail(10) }, bulk).out).toBe('true');
      expect(plan(quotas, { waas_plan_mail: mail(2), waas_plan_mail_platform: mail(9) }, bulk).out).toBe('false');
      expect(plan(quotas, { waas_plan_mail_platform: mail(10) }, bulk).out).toBe('true');
      // The store's own count is instant; the platform's lags. The higher one counts.
      expect(plan(quotas, { waas_plan_mail: mail(10), waas_plan_mail_platform: mail(3) }, bulk).out).toBe('true');
      // Another month's platform count is no count for this one.
      expect(plan(quotas, { waas_plan_mail: mail(2), waas_plan_mail_platform: mail(50, '2000-01') }, bulk).out).toBe('false');
      expect(plan(quotas, { waas_plan_mail: mail(2), waas_plan_mail_platform: mail(8) }, notices).out).toContain('has sent 8 of the 10 emails its plan includes');
      // The store keeps counting its own.
      const sent = plan(quotas, { waas_plan_mail: mail(2), waas_plan_mail_platform: mail(8) }, `do_action('wp_mail_succeeded');`);
      expect(sent.options.waas_plan_mail).toEqual(mail(3));
      expect(sent.options.waas_plan_mail_platform).toEqual(mail(8));
    });

    it('counts packs used last month by the higher count too, even when the store\'s own count is gone', () => {
      const packs = { waas_plan_mail_packs: { purchased: 5, used: 0 } };
      const first = plan(quotas, { waas_plan_mail: mail(4, '2000-01'), waas_plan_mail_platform: mail(13, '2000-01'), ...packs }, bulk);
      expect(first.options.waas_plan_mail_packs).toEqual({ purchased: 5, used: 3 });
      expect(first.options.waas_plan_mail).toEqual(mail(0));
      // The platform's count of an earlier month than the one closing is not that month's.
      expect(plan(quotas, { waas_plan_mail: mail(4, '2000-02'), waas_plan_mail_platform: mail(13, '2000-01'), ...packs }, bulk).options.waas_plan_mail_packs).toEqual({
        purchased: 5,
        used: 0,
      });
      const deleted = plan(quotas, { waas_plan_mail_platform: mail(12, '2000-01'), ...packs }, bulk);
      expect(deleted.options.waas_plan_mail_packs).toEqual({ purchased: 5, used: 2 });
      expect(plan(quotas, deleted.options, bulk).options.waas_plan_mail_packs).toEqual({ purchased: 5, used: 2 });
    });

    it('is set through the agent', () => {
      const bin = mkdtempSync(join(tmpdir(), 'waas-bin-'));
      chmodSync(bin, 0o755);
      writeFileSync(join(bin, 'wp'), `#!/bin/sh\ncase "$*" in\n  *"option update waas_plan_mail_platform"*) printf '%s %s %s' "$7" "$8" "$9" > "$WAAS_ROOT/count.txt" ;;\nesac\n`, { mode: 0o755 });
      const run = (args: unknown) =>
        execFileSync('php', [AGENT, 'mail-count', Buffer.from(JSON.stringify(args)).toString('base64')], {
          env: { ...process.env, WAAS_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
          encoding: 'utf8',
        });
      try {
        expect(run({ month: '2026-10', sent: 42 })).toContain('WAAS_RESULT {"month":"2026-10","sent":42}');
        expect(readFileSync(join(root, 'count.txt'), 'utf8')).toBe('{"month":"2026-10","sent":42} --format=json --autoload=no');
        for (const [bad, error] of [
          [{ month: 'October', sent: 1 }, 'month must be YYYY-MM'],
          [{ month: '2026-10', sent: -1 }, 'sent must be a whole number'],
          [{ month: '2026-10', sent: '1' }, 'sent must be a whole number'],
        ] as const) {
          let stdout = '';
          try {
            run(bad);
          } catch (err) {
            stdout = String((err as { stdout?: string }).stdout);
          }
          expect(stdout).toBe(`WAAS_ERROR ${error}\n`);
        }
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
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
  *"option get waas_plan_mail_packs"*) echo '{"purchased":10,"used":2}' ;;
  *"option get waas_plan_mail_platform"*) echo '{"month":"${month()}","sent":5}' ;;
  *"option get waas_plan_mail"*) echo '{"month":"${month()}","sent":7}' ;;
esac
`,
    );
    chmodSync(join(bin, 'wp'), 0o755);
    mkdirSync(join(content(), 'uploads'));
    writeFileSync(join(content(), 'uploads/photo.jpg'), Buffer.alloc(3000));
    try {
      const out = execFileSync('php', [AGENT, 'usage', Buffer.from('{}').toString('base64')], {
        env: { ...process.env, WAAS_ROOT: root, PATH: `${bin}:${process.env.PATH}`, WAAS_EMAILS_PER_MONTH: '5' },
        encoding: 'utf8',
      });
      const result = JSON.parse(/^WAAS_RESULT (.*)$/m.exec(out)![1]!);
      // 2 pack emails used in earlier months, and this month's 2 beyond the plan of 5.
      expect(result).toMatchObject({ mailMonth: month(), mailSent: 7, platformSent: 5, packPurchased: 10, packUsed: 4 });
      expect(result.storageBytes).toBeGreaterThan(3000 + 2048);
      expect(new Date(result.measuredAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(JSON.parse(readFileSync(join(root, 'usage.json'), 'utf8')).bytes).toBe(result.storageBytes);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasPhp)('store agent: owner mu-plugin', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'waas-agent-'));
    mkdirSync(join(root, 'wp-content'));
    chmodSync(root, 0o777);
    chmodSync(join(root, 'wp-content'), 0o777);
    execFileSync('php', [AGENT, 'configure', Buffer.from('{}').toString('base64')], { env: { ...process.env, WAAS_ROOT: root } });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Calls one of the mu-plugin's helpers with a stand-in WordPress. */
  const call = (fn: string, ...args: string[]) =>
    execFileSync(
      'php',
      ['-r', `function add_action() {} include ${JSON.stringify(join(root, 'wp-content/mu-plugins/waas-owner.php'))}; echo ${fn}(...json_decode(${JSON.stringify(JSON.stringify(args))}, true));`],
      { encoding: 'utf8' },
    );

  it("picks the store's time zone from its country, and its state where the country has several", () => {
    expect(call('waas_owner_timezone', 'US', 'CA')).toBe('America/Los_Angeles');
    expect(call('waas_owner_timezone', 'US', 'tx')).toBe('America/Chicago');
    expect(call('waas_owner_timezone', 'CA', 'ON')).toBe('America/Toronto');
    expect(call('waas_owner_timezone', 'AU', 'WA')).toBe('Australia/Perth');
    expect(call('waas_owner_timezone', 'GB', '')).toBe('Europe/London');
    expect(call('waas_owner_timezone', 'US', '')).toBe('');
    // Several zones and no map: left alone.
    expect(call('waas_owner_timezone', 'BR', 'SP')).toBe('');
  });

  const hasIntl = hasPhp && execFileSync('php', ['-r', "echo extension_loaded('intl') ? 1 : 0;"], { encoding: 'utf8' }) === '1';
  // The store image has intl; a test machine's PHP may not.
  it.skipIf(!hasIntl)("picks the country's currency", () => {
    expect(call('waas_owner_currency', 'GB')).toBe('GBP');
    expect(call('waas_owner_currency', 'DE')).toBe('EUR');
    expect(call('waas_owner_currency', '')).toBe('');
  });
});

describe.skipIf(!hasPhp)('store agent: plugin choices', () => {
  let root: string;
  let zips: string;
  const plugins = () => join(root, 'wp-content/plugins');
  const rolesFile = () => join(plugins(), 'waas-client-data/roles.json');
  const roles = () => JSON.parse(readFileSync(rolesFile(), 'utf8'));
  const agent = (args: unknown) => {
    try {
      const out = execFileSync('php', [AGENT, 'plugins', Buffer.from(JSON.stringify(args)).toString('base64')], { env: { ...process.env, WAAS_ROOT: root }, encoding: 'utf8' });
      return JSON.parse(/^WAAS_RESULT (.*)$/m.exec(out)![1]!);
    } catch (err) {
      return { error: /WAAS_ERROR (.*)/.exec(String((err as { stdout?: string }).stdout))?.[1] };
    }
  };
  /** A wordpress.org-style zip: a <slug>/ folder with its main file. */
  const pluginZip = (slug: string, main: string) => {
    const dir = join(zips, `src-${slug}`);
    mkdirSync(join(dir, slug), { recursive: true });
    writeFileSync(join(dir, slug, 'uninstall.php'), '<?php // nothing');
    writeFileSync(join(dir, slug, main), `<?php\n/**\n * Plugin Name: ${slug}\n * Version: 1.0\n */`);
    const file = join(zips, `${slug}.zip`);
    execFileSync('zip', ['-qr', file, slug], { cwd: dir });
    chmodSync(file, 0o644);
    return { url: `file://${file}`, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  };
  const add = (slug: string, main: string, siteTypes: string[] = []) => ({ slug, action: 'add', siteTypes, ...pluginZip(slug, main) });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'waas-agent-'));
    zips = mkdtempSync(join(tmpdir(), 'waas-zips-'));
    mkdirSync(join(plugins(), 'waas-client-data'), { recursive: true });
    mkdirSync(join(plugins(), 'wp-fusion-lite'));
    writeFileSync(rolesFile(), JSON.stringify({ website: { title: 'Website', plugins: ['fluentform/fluentform.php', 'wp-fusion-lite/wp-fusion-lite.php'] }, store: { title: 'Store', plugins: ['fluent-cart/fluent-cart.php', 'wp-fusion-lite/wp-fusion-lite.php'] } }));
    execFileSync('chmod', ['-R', '777', root, zips]);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(zips, { recursive: true, force: true });
  });

  it('adds plugins to the site types chosen and switches others off', () => {
    const result = agent({ plugins: [add('contact-form-7', 'wp-contact-form-7.php', ['website']), add('seo-tool', 'seo-tool.php'), { slug: 'wp-fusion-lite', action: 'off', siteTypes: ['store'] }] });
    expect(result.files).toEqual({ 'contact-form-7': 'contact-form-7/wp-contact-form-7.php', 'seo-tool': 'seo-tool/seo-tool.php' });
    expect(existsSync(join(plugins(), 'contact-form-7/wp-contact-form-7.php'))).toBe(true);
    expect(roles().website.plugins).toEqual(['fluentform/fluentform.php', 'wp-fusion-lite/wp-fusion-lite.php', 'contact-form-7/wp-contact-form-7.php', 'seo-tool/seo-tool.php']);
    expect(roles().store.plugins).toEqual(['fluent-cart/fluent-cart.php', 'seo-tool/seo-tool.php']);
    expect(roles().website.title).toBe('Website');
  });

  it('undoes the choices an earlier build applied before applying new ones', () => {
    agent({ plugins: [add('contact-form-7', 'wp-contact-form-7.php'), { slug: 'wp-fusion-lite', action: 'off', siteTypes: [] }] });
    // A later version from an archive with those applied, now with no choices: back to the template.
    expect(agent({ plugins: [] })).toEqual({ files: {} });
    expect(existsSync(join(plugins(), 'contact-form-7'))).toBe(false);
    expect(existsSync(join(plugins(), 'wp-fusion-lite'))).toBe(true);
    expect(roles().store.plugins).toEqual(['fluent-cart/fluent-cart.php', 'wp-fusion-lite/wp-fusion-lite.php']);
    expect(existsSync(join(plugins(), 'waas-client-data/roles.template.json'))).toBe(false);
  });

  it('reads the choices from a file when the build sends one', () => {
    const file = join(zips, 'choices.json');
    writeFileSync(file, JSON.stringify({ plugins: [add('seo-tool', 'seo-tool.php', ['store'])] }));
    chmodSync(file, 0o644);
    expect(agent({ manifest: `file://${file}` }).files).toEqual({ 'seo-tool': 'seo-tool/seo-tool.php' });
    expect(roles().store.plugins).toContain('seo-tool/seo-tool.php');
  });

  it('refuses a zip that does not match, an unknown site type and a template without roles', () => {
    expect(agent({ plugins: [{ ...add('contact-form-7', 'wp-contact-form-7.php'), sha256: '0'.repeat(64) }] }).error).toContain('does not match its SHA-256');
    expect(agent({ plugins: [add('seo-tool', 'seo-tool.php', ['shop'])] }).error).toContain('no site type shop (it has website, store)');
    rmSync(rolesFile());
    expect(agent({ plugins: [add('seo-tool', 'seo-tool.php')] }).error).toContain('has no site types');
  });
});

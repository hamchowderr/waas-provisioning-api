import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { siteReport } from '../../src/sitereport.ts';

/*
 * Moving a site in, end to end on real containers (npm run test:docker): the store agent's `restore` with `import`
 * against MariaDB, as a store runs it (src/provisioner/coolify/compose.ts): a WordPress container and a WP-CLI agent
 * container sharing the WordPress volume, and a MariaDB one, on their own network. The archives are built here the
 * way the AnyPress Export plugin packs them: database.sql, waas.json and wp-content in one gzipped tar.
 *
 * Needs Docker. Without it the suite fails and says so: it is never skipped quietly. The images can be pointed at
 * another registry with WAAS_TEST_MARIADB_IMAGE, WAAS_TEST_WORDPRESS_IMAGE and WAAS_TEST_CLI_IMAGE.
 */

const AGENT = fileURLToPath(new URL('../../src/provisioner/coolify/agent.php', import.meta.url));
const IMAGES = {
  db: process.env.WAAS_TEST_MARIADB_IMAGE ?? 'mirror.gcr.io/library/mariadb:11',
  wordpress: process.env.WAAS_TEST_WORDPRESS_IMAGE ?? 'mirror.gcr.io/library/wordpress:php8.3-apache',
  cli: process.env.WAAS_TEST_CLI_IMAGE ?? 'mirror.gcr.io/library/wordpress:cli-php8.3',
};
const RUN = randomBytes(4).toString('hex');
const NAMES = { network: `waas-it-${RUN}`, volume: `waas-it-wp-${RUN}`, db: `waas-it-db-${RUN}`, wordpress: `waas-it-wp-${RUN}`, agent: `waas-it-agent-${RUN}` };
/** The store's address; the old site's is https://old.example.com. */
const HOME = 'https://store.example.test';
const DB_ENV = ['WORDPRESS_DB_HOST=db', 'WORDPRESS_DB_NAME=wordpress', 'WORDPRESS_DB_USER=wordpress', 'WORDPRESS_DB_PASSWORD=wordpress'];
// As in a store: WP-cron never runs on page loads, and the agent's page cache drop-in is loaded.
const CONFIG_EXTRA = "define('DISABLE_WP_CRON', true); define('WP_CACHE', true);";

const docker = (...args: string[]) => {
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${(res.stderr || res.stdout).slice(-1500)}`);
  return res.stdout;
};
/** A command in the agent container, as the agent runs (www-data). */
const inAgent = (...args: string[]) => docker('exec', '-u', '33:33', '-e', 'HOME=/tmp', NAMES.agent, ...args);
/** WP-CLI without plugins or themes, as the agent's own wp(). */
const wp = (...args: string[]) => inAgent('wp', '--path=/var/www/html', '--skip-plugins', '--skip-themes', ...args).trim();
const option = (name: string) => wp('option', 'get', name);
/** The first column of a query's rows, one per line, exactly as stored (WP-CLI's db query escapes backslashes). */
const sql = (query: string) => wp('eval', `echo implode("\\n", $GLOBALS['wpdb']->get_col(base64_decode('${Buffer.from(query).toString('base64')}')));`);
const fileExists = (path: string) => spawnSync('docker', ['exec', NAMES.agent, 'test', '-e', path]).status === 0;

/** Runs an agent operation and answers its WAAS_RESULT; throws with its WAAS_ERROR. */
function agent(op: string, args: Record<string, unknown> = {}): Record<string, any> {
  const res = spawnSync('docker', ['exec', '-u', '33:33', NAMES.agent, 'php', '/tmp/waas-agent.php', op, Buffer.from(JSON.stringify(args)).toString('base64')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const result = /^WAAS_RESULT (.*)$/m.exec(res.stdout);
  if (res.status !== 0 || !result) throw new Error(`agent ${op}: ${/^WAAS_ERROR (.*)$/m.exec(res.stdout)?.[1] ?? (res.stdout + res.stderr).slice(-1500)}`);
  return JSON.parse(result[1]!);
}

let fixtures: string;
/** The old site's database as `wp db export` wrote it, under the prefix wp_. */
let baseDump: string;

/** WordPress's own prefixed keys, which an export under another prefix names after it. */
const PREFIXED = /'wp_(user_roles|capabilities|user_level|user-settings|user-settings-time|dashboard_quick_press_last_post_id)'/g;

interface Fixture {
  /** The old site's table prefix; wp_ when omitted. */
  prefix?: string;
  /** SQL run after the dump, with {p} for the prefix. */
  sql?: string;
  /** Files in wp-content, besides the theme. */
  files?: Record<string, string>;
  /** waas.json, besides home and tablePrefix. */
  info?: Record<string, unknown>;
  /** The old site's address in waas.json. */
  home?: string;
}

/** Packs an export archive as the plugin does, and answers the URL the agent downloads it from. */
function archive(name: string, f: Fixture = {}): string {
  const prefix = f.prefix ?? 'wp_';
  const dir = join(fixtures, name);
  mkdirSync(join(dir, 'wp-content/themes/plain'), { recursive: true });
  let dump = baseDump;
  if (prefix !== 'wp_') dump = dump.replaceAll('`wp_', '`' + prefix).replace(PREFIXED, `'${prefix}$1'`);
  // As the plugin's dump: no strict mode, so zero dates and the like load as they were.
  dump += `\nSET NAMES utf8mb4;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\nUPDATE \`${prefix}options\` SET option_value = 'plain' WHERE option_name IN ('template', 'stylesheet');\n`;
  dump += (f.sql ?? '').replaceAll('{p}', prefix);
  writeFileSync(join(dir, 'database.sql'), dump);
  writeFileSync(join(dir, 'waas.json'), JSON.stringify({ home: f.home ?? 'https://old.example.com', tablePrefix: prefix, ...f.info }));
  writeFileSync(join(dir, 'wp-content/themes/plain/style.css'), '/*\nTheme Name: Plain\n*/\n');
  writeFileSync(join(dir, 'wp-content/themes/plain/index.php'), "<!doctype html><html><head><?php wp_head(); ?></head><body><h1><?php bloginfo('name'); ?></h1><?php wp_footer(); ?></body></html>\n");
  for (const [path, body] of Object.entries(f.files ?? {})) {
    mkdirSync(dirname(join(dir, 'wp-content', path)), { recursive: true });
    writeFileSync(join(dir, 'wp-content', path), body);
  }
  execFileSync('tar', ['-czf', join(fixtures, `${name}.tar.gz`), '-C', dir, '.']);
  chmodSync(join(fixtures, `${name}.tar.gz`), 0o644);
  return `file:///fixtures/${name}.tar.gz`;
}

/** Moves a site in: the agent's restore with import, then configure as the API's build does. */
function moveIn(name: string, f: Fixture = {}, holdAllow: string[] = []) {
  const restored = agent('restore', { url: archive(name, f), home: HOME, import: true });
  const configured = agent('configure', { home: HOME, options: {}, holdAllow });
  return { restored, configured };
}

const until = (what: string, test: () => boolean, seconds = 120) => {
  const deadline = Date.now() + seconds * 1000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${seconds} s`);
    execFileSync('sleep', ['1']);
  }
};

beforeAll(() => {
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  if (info.status !== 0) {
    throw new Error(`These tests need Docker, and it is not available here: ${(info.stderr || info.stdout).trim().slice(-300)}. Start the Docker daemon, then run npm run test:docker.`);
  }
  fixtures = mkdtempSync(join(tmpdir(), 'waas-import-'));
  chmodSync(fixtures, 0o755);
  docker('network', 'create', NAMES.network);
  docker('volume', 'create', NAMES.volume);
  docker('run', '-d', '--name', NAMES.db, '--network', NAMES.network, '--network-alias', 'db',
    '-e', 'MARIADB_DATABASE=wordpress', '-e', 'MARIADB_USER=wordpress', '-e', 'MARIADB_PASSWORD=wordpress', '-e', 'MARIADB_ROOT_PASSWORD=root', IMAGES.db,
    // As compose.ts starts a store's database.
    '--max-allowed-packet=256M');
  docker('run', '-d', '--name', NAMES.wordpress, '--network', NAMES.network, '--network-alias', 'wordpress', '-v', `${NAMES.volume}:/var/www/html`,
    ...DB_ENV.flatMap((e) => ['-e', e]), '-e', `WORDPRESS_CONFIG_EXTRA=${CONFIG_EXTRA}`, IMAGES.wordpress);
  docker('run', '-d', '--name', NAMES.agent, '--network', NAMES.network, '-v', `${NAMES.volume}:/var/www/html`, '-v', `${AGENT}:/tmp/waas-agent.php:ro`,
    '-v', `${fixtures}:/fixtures:ro`, ...DB_ENV.flatMap((e) => ['-e', e]), '-e', `WORDPRESS_CONFIG_EXTRA=${CONFIG_EXTRA}`, '--entrypoint', 'tail', IMAGES.cli, '-f', '/dev/null');
  until('MariaDB starting', () => spawnSync('docker', ['exec', NAMES.db, 'healthcheck.sh', '--connect', '--innodb_initialized']).status === 0);
  until('WordPress copying its files to the volume', () => fileExists('/var/www/html/wp-config.php') && fileExists('/var/www/html/wp-includes/version.php'));

  // The old site: a WordPress at https://old.example.com with an administrator, exported as the plugin would.
  wp('core', 'install', '--url=https://old.example.com', '--title=Old Shop', '--admin_user=admin', '--admin_email=owner@old.example.com',
    '--admin_password=old-password-not-real', '--skip-email');
  baseDump = inAgent('sh', '-c', 'wp --path=/var/www/html db export - --skip-plugins --skip-themes');
}, 600_000);

afterAll(() => {
  for (const name of [NAMES.agent, NAMES.wordpress, NAMES.db]) spawnSync('docker', ['rm', '-f', name]);
  spawnSync('docker', ['volume', 'rm', '-f', NAMES.volume]);
  spawnSync('docker', ['network', 'rm', NAMES.network]);
  if (fixtures) rmSync(fixtures, { recursive: true, force: true });
});

describe('moving a site in, on MariaDB', () => {
  it("adopts the store's prefix from wpx_, keeping the administrators and the plugins' own options", () => {
    const { restored } = moveIn('wpx', { prefix: 'wpx_', sql: "INSERT INTO `{p}options` (option_name, option_value, autoload) VALUES ('wpx_custom_setting', 'kept', 'no');" });
    expect(restored).toMatchObject({ tablePrefix: 'wpx_', previousHome: 'https://old.example.com', held: true });
    expect(wp('user', 'list', '--role=administrator', '--field=user_login')).toBe('admin');
    expect(sql("SELECT COUNT(*) FROM wp_usermeta WHERE meta_key = 'wp_capabilities'")).toBe('1');
    expect(sql('SHOW TABLES LIKE "wpx%"')).toBe('');
    // A plugin's option that happens to start with the prefix is the plugin's: it keeps its name.
    expect(option('wpx_custom_setting')).toBe('kept');
  });

  it('does not rename core options that start with the prefix (site_ and site_icon, site_logo)', () => {
    const { restored } = moveIn('site', {
      prefix: 'site_',
      sql: "INSERT INTO `{p}options` (option_name, option_value, autoload) VALUES ('site_icon', '41', 'yes'), ('site_logo', '42', 'yes') ON DUPLICATE KEY UPDATE option_value = VALUES(option_value);",
    });
    expect(restored.tablePrefix).toBe('site_');
    expect(option('site_icon')).toBe('41');
    expect(option('site_logo')).toBe('42');
    expect(sql("SELECT COUNT(*) FROM wp_options WHERE option_name LIKE 'wp\\_icon' OR option_name LIKE 'wp\\_logo'")).toBe('0');
    expect(wp('user', 'list', '--role=administrator', '--field=user_login')).toBe('admin');
  });

  it('imports a MySQL 8 dump: utf8mb4_0900_ai_ci, utf8mb3 and MyISAM tables, and zero dates', () => {
    moveIn('mysql8', {
      sql: [
        'CREATE TABLE `{p}mysql8_items` (id bigint unsigned NOT NULL AUTO_INCREMENT, name varchar(191) NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
        "INSERT INTO `{p}mysql8_items` VALUES (1, 'Crème brûlée 🍮');",
        'CREATE TABLE `{p}legacy_log` (id int NOT NULL AUTO_INCREMENT, note varchar(100) NOT NULL, PRIMARY KEY (id)) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;',
        "INSERT INTO `{p}legacy_log` VALUES (1, 'old');",
        "INSERT INTO `{p}posts` (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, guid, post_type)",
        "  VALUES (1, '0000-00-00 00:00:00', '0000-00-00 00:00:00', 'Zero', 'Zero date', '', 'draft', 'zero-date', '', '', '0000-00-00 00:00:00', '0000-00-00 00:00:00', '', '', 'post');",
      ].join('\n'),
    });
    expect(sql('SELECT name FROM wp_mysql8_items')).toBe('Crème brûlée 🍮');
    expect(sql("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_legacy_log'")).toBe('MyISAM');
    expect(sql("SELECT post_date FROM wp_posts WHERE post_name = 'zero-date'")).toBe('0000-00-00 00:00:00');
  });

  it('fails the move at a statement that fails, instead of going on without it', () => {
    expect(() => moveIn('broken', { sql: "INSERT INTO `{p}options` (option_name, option_value) VALUES ('siteurl', 'twice');" })).toThrow(
      /the database could not be imported: .*Duplicate entry 'siteurl'/,
    );
  });

  it('moves every form of the old address to the store, and leaves GUIDs alone', () => {
    const content = [
      'https://old.example.com/a', 'http://old.example.com/b', 'https://www.old.example.com/c', 'http://www.old.example.com/d',
      'https:\\\\/\\\\/old.example.com\\\\/e', 'https%3A%2F%2Fold.example.com%2Ff', 'https://other.example.org/g',
    ].join(' ');
    const { restored } = moveIn('urls', {
      sql: [
        `INSERT INTO \`{p}posts\` (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, guid, post_type)`,
        `  VALUES (1, NOW(), NOW(), '${content}', 'Links', '', 'publish', 'links', '', '', NOW(), NOW(), '', 'https://old.example.com/?p=900', 'page');`,
        `INSERT INTO \`{p}postmeta\` (post_id, meta_key, meta_value) VALUES (1, '_elementor_data', '[{"settings":{"url":"https:\\\\/\\\\/old.example.com\\\\/wp-content\\\\/uploads\\\\/x.jpg"}}]');`,
        `INSERT INTO \`{p}postmeta\` (post_id, meta_key, meta_value) VALUES (1, '_elementor_css', 'a{background:url(https://old.example.com/x.jpg)}');`,
        `UPDATE \`{p}options\` SET option_value = '/home/old/public_html/wp-content/uploads' WHERE option_name = 'upload_path';`,
        `INSERT INTO \`{p}options\` (option_name, option_value, autoload) VALUES ('anypress_export_state', 'a:1:{s:5:"token";s:3:"tok";}', 'off');`,
      ].join('\n'),
      files: {
        'uploads/elementor/css/post-1.css': 'a{background:url(https://old.example.com/x.jpg)}',
        'mu-plugins/custom.php': '<?php // the site\'s own',
        'mu-plugins/sso.php': '<?php // the site\'s own single sign-on',
        'mu-plugins/wpengine-common/plugin.php': '<?php // the old host\'s',
        'mu-plugins/mu-plugin.php': '<?php // the old host\'s',
      },
    });
    const post = sql("SELECT post_content FROM wp_posts WHERE post_name = 'links'");
    expect(post).toBe(
      [
        `${HOME}/a`, `${HOME}/b`, `${HOME}/c`, `${HOME}/d`, 'https:\\/\\/store.example.test\\/e', 'https%3A%2F%2Fstore.example.test%2Ff', 'https://other.example.org/g',
      ].join(' '),
    );
    expect(sql("SELECT guid FROM wp_posts WHERE post_name = 'links'")).toBe('https://old.example.com/?p=900');
    expect(sql("SELECT meta_value FROM wp_postmeta WHERE meta_key = '_elementor_data'")).toContain('https:\\/\\/store.example.test\\/wp-content');
    expect([option('home'), option('siteurl')]).toEqual([HOME, HOME]);
    // What points outside the store, and caches with the old address in them, are gone; the site's own mu-plugins stay.
    expect(sql("SELECT COUNT(*) FROM wp_postmeta WHERE meta_key = '_elementor_css'")).toBe('0');
    expect(sql("SELECT COUNT(*) FROM wp_options WHERE option_name = 'upload_path'")).toBe('0');
    expect(sql("SELECT COUNT(*) FROM wp_options WHERE option_name = 'anypress_export_state'")).toBe('0');
    expect(restored.cleared).toEqual(expect.arrayContaining(['upload_path', '_elementor_css', 'anypress_export_state']));
    expect(fileExists('/var/www/html/wp-content/uploads/elementor/css')).toBe(false);
    expect(fileExists('/var/www/html/wp-content/mu-plugins/wpengine-common')).toBe(false);
    expect(fileExists('/var/www/html/wp-content/mu-plugins/mu-plugin.php')).toBe(false);
    expect(fileExists('/var/www/html/wp-content/mu-plugins/custom.php')).toBe(true);
    expect(fileExists('/var/www/html/wp-content/mu-plugins/sso.php')).toBe(true);
  });

  it('replaces an old home with a path and a port, and a custom content address, with the store\'s', () => {
    const old = 'http://old.example.com:8080/blog';
    const { restored } = moveIn('path', {
      home: old,
      info: { contentUrl: 'http://old.example.com:8080/app' },
      sql: [
        `UPDATE \`{p}options\` SET option_value = '${old}' WHERE option_name IN ('home', 'siteurl');`,
        `INSERT INTO \`{p}posts\` (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, guid, post_type)`,
        `  VALUES (1, NOW(), NOW(), '${old}/hello/ http://old.example.com:8080/app/uploads/a.jpg', 'Path', '', 'publish', 'path', '', '', NOW(), NOW(), '', '${old}/?p=901', 'page');`,
      ].join('\n'),
    });
    expect(sql("SELECT post_content FROM wp_posts WHERE post_name = 'path'")).toBe(`${HOME}/hello/ ${HOME}/wp-content/uploads/a.jpg`);
    expect(option('home')).toBe(HOME);
    // Nothing of that kind was there, so nothing is reported cleared.
    expect(restored.cleared).toEqual([]);
  });
});

/** A post row with the columns WordPress requires, under an id of our own. */
const post = (id: number, type: string, content = '', status = 'publish') =>
  "INSERT INTO `{p}posts` (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, guid, post_type)" +
  ` VALUES (${id}, 1, NOW(), NOW(), '${content}', '${type} ${id}', '', '${status}', '${type}-${id}', '', '', NOW(), NOW(), '', 'https://old.example.com/?p=${id}', '${type}');`;
const meta = (id: number, key: string, value: string) => `INSERT INTO \`{p}postmeta\` (post_id, meta_key, meta_value) VALUES (${id}, '${key}', '${value}');`;
/** PHP's serialize() of a list or a map of strings, as WordPress stores arrays in options. */
const serialize = (value: string[] | Record<string, string>): string => {
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v] as const) : Object.entries(value);
  const str = (v: string) => `s:${Buffer.byteLength(v)}:"${v}";`;
  return `a:${entries.length}:{${entries.map(([k, v]) => (typeof k === 'number' ? `i:${k};` : str(k)) + str(v)).join('')}}`;
};
const pluginFile = (name: string) => `<?php\n/*\nPlugin Name: ${name}\nVersion: 1.2.3\n*/\n`;

describe("what's on a site moved in", () => {
  it('counts Contact Form 7 with Flamingo, WooCommerce with HPOS off, and MailPoet, and never reads a payment key', () => {
    const active = ['contact-form-7/wp-contact-form-7.php', 'flamingo/flamingo.php', 'woocommerce/woocommerce.php', 'mailpoet/mailpoet.php'];
    moveIn('inventory', {
      files: {
        'plugins/contact-form-7/wp-contact-form-7.php': pluginFile('Contact Form 7'),
        'plugins/flamingo/flamingo.php': pluginFile('Flamingo'),
        'plugins/woocommerce/woocommerce.php': pluginFile('WooCommerce'),
        'plugins/mailpoet/mailpoet.php': pluginFile('MailPoet'),
        // Installed, not active: not in the report.
        'plugins/gravityforms/gravityforms.php': pluginFile('Gravity Forms'),
      },
      sql: [
        `UPDATE \`{p}options\` SET option_value = '${serialize(active)}' WHERE option_name = 'active_plugins';`,
        "INSERT INTO `{p}options` (option_name, option_value, autoload) VALUES ('woocommerce_custom_orders_table_enabled', 'no', 'yes');",
        `INSERT INTO \`{p}options\` (option_name, option_value, autoload) VALUES ('woocommerce_stripe_settings', '${serialize({ enabled: 'yes', testmode: 'no', secret_key: 'sk_live_not_a_real_key' })}', 'yes');`,
        `INSERT INTO \`{p}options\` (option_name, option_value, autoload) VALUES ('woocommerce_cod_settings', '${serialize({ enabled: 'yes', title: 'Cash' })}', 'yes');`,
        post(1001, 'wpcf7_contact_form'),
        meta(1001, '_form', '[text* your-name] [email* your-email] [submit]'),
        post(1002, 'wpcf7_contact_form'),
        meta(1002, '_form', '[text* your-name] [tel* your-phone] [submit]'),
        post(1003, 'flamingo_inbound'),
        post(1004, 'flamingo_inbound'),
        post(1005, 'flamingo_inbound', '', 'trash'),
        post(1006, 'page', '<!-- wp:shortcode -->[contact-form-7 id=\"1001\" title=\"Contact\"]<!-- /wp:shortcode -->'),
        post(1007, 'page', 'No form here'),
        post(1008, 'product'),
        post(1009, 'product'),
        post(1010, 'shop_order', '', 'wc-completed'),
        meta(1010, '_customer_user', '0'),
        post(1011, 'shop_order', '', 'wc-processing'),
        meta(1011, '_customer_user', '1'),
        post(1012, 'shop_order', '', 'wc-completed'),
        meta(1012, '_customer_user', '0'),
        // HPOS off: its table is there but holds nothing that counts.
        'CREATE TABLE `{p}wc_orders` (id bigint unsigned NOT NULL, type varchar(20), status varchar(20), customer_id bigint unsigned, PRIMARY KEY (id));',
        'CREATE TABLE `{p}mailpoet_subscribers` (id int NOT NULL AUTO_INCREMENT, status varchar(12) NOT NULL, deleted_at timestamp NULL, PRIMARY KEY (id));',
        "INSERT INTO `{p}mailpoet_subscribers` (status, deleted_at) VALUES ('subscribed', NULL), ('subscribed', NULL), ('unsubscribed', NULL), ('subscribed', NOW());",
        'CREATE TABLE `{p}mailpoet_segments` (id int NOT NULL AUTO_INCREMENT, type varchar(90) NOT NULL, deleted_at timestamp NULL, PRIMARY KEY (id));',
        "INSERT INTO `{p}mailpoet_segments` (type) VALUES ('default'), ('wp_users');",
      ].join('\n'),
    });
    const started = Date.now();
    const check = agent('check-site', { home: HOME });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(check).toMatchObject({ ok: true, loaded: true });
    const { inventory } = check;
    expect(inventory.plugins).toEqual([
      { slug: 'contact-form-7', name: 'Contact Form 7', version: '1.2.3' },
      { slug: 'flamingo', name: 'Flamingo', version: '1.2.3' },
      { slug: 'woocommerce', name: 'WooCommerce', version: '1.2.3' },
      { slug: 'mailpoet', name: 'MailPoet', version: '1.2.3' },
    ]);
    expect(inventory.found).toEqual({
      'contact-form-7': { forms: 2, proFieldForms: 1, entries: 2, flamingo: true, pages: 1 },
      woocommerce: { products: 2, hpos: false, orders: 3, guestOrders: 2, subscriptions: null, liveGateways: ['stripe'] },
      // Its newsletters table isn't there: not counted.
      mailpoet: { subscribers: 2, lists: 1, emails: null },
    });
    expect(inventory.errors).toEqual({});
    expect(inventory.seconds).toBeLessThan(10);
    expect(JSON.stringify(check)).not.toContain('sk_live');

    const report = siteReport(inventory)!;
    expect(report.items.map((i) => [i.plugin, i.route])).toEqual([
      ['Contact Form 7', 'Needs Fluent Forms Pro'],
      ['WooCommerce', 'Needs the FluentCart Migrator add-on'],
      ['MailPoet', 'No Fluent route yet'],
    ]);
    expect(report.items[1]!.blockers.join(' ')).toMatch(/HPOS is off.*Live payment keys came across for Stripe/);
  });

  it('records a probe that fails and still answers the others', () => {
    // A MailPoet table with no status column: its count fails, the rest is counted.
    inAgent('sh', '-c', "wp --path=/var/www/html --skip-plugins --skip-themes db query 'DROP TABLE wp_mailpoet_subscribers; CREATE TABLE wp_mailpoet_subscribers (id int NOT NULL, PRIMARY KEY (id));'");
    const check = agent('check-site', { home: HOME });
    expect(check.inventory.errors).toEqual({ mailpoet: expect.stringMatching(/status/) });
    expect(check.inventory.found).toHaveProperty('woocommerce');
    expect(check.inventory.found).not.toHaveProperty('mailpoet');
  });
});

describe('a site moved in is held until it goes live', () => {
  beforeAll(() => {
    moveIn('held', {}, ['owner@team.example']);
  });

  it('runs no cron while held, and configure leaves it off; go-live turns it on', () => {
    expect(fileExists('/var/www/html/wp-content/.waas-hold')).toBe(true);
    expect(fileExists('/var/www/html/wp-content/.waas-cron')).toBe(false);
    expect(fileExists('/var/www/html/wp-content/mu-plugins/waas-hold.php')).toBe(true);
    expect(agent('configure', {})).toMatchObject({ held: true });
    expect(fileExists('/var/www/html/wp-content/.waas-cron')).toBe(false);
  });

  /** Sends three emails with every plugin loaded; a stand-in mailer after the hold's filter says which reached it. */
  const send = () =>
    JSON.parse(
      inAgent(
        'wp', '--path=/var/www/html', `--url=${HOME}`, 'eval',
        `add_filter('pre_wp_mail', function ($r) { return $r === null ? 'sent' : $r; }, PHP_INT_MAX);
         echo json_encode([
           wp_mail('customer@example.net', 'Your order', 'x'),
           wp_mail(get_option('admin_email'), 'To the admin', 'x'),
           wp_mail('owner@team.example', 'To the owner', 'x'),
           wp_mail(get_option('admin_email'), 'Copied', 'x', ['Cc: customer@example.net']),
         ]);`,
      ).trim(),
    );

  it('holds email to customers, and sends it to the administrator and the owner', () => {
    expect(send()).toEqual([true, 'sent', 'sent', true]);
    const held = JSON.parse(wp('option', 'get', 'waas_hold_mail', '--format=json'));
    expect(held.count).toBe(2);
    expect(held.recent[1]).toMatchObject({ subject: 'Your order', to: 'c***@example.net' });
  });

  it('serves the moved site with its plugins, asks search engines not to index it, and finds a fatal error', () => {
    const check = agent('check-site', { home: HOME });
    expect(check).toMatchObject({ ok: true, home: 200, login: 200, loaded: true, fatal: null });
    const headers = inAgent('php', '-r', `$c = curl_init('http://wordpress/'); curl_setopt_array($c, [CURLOPT_HTTPHEADER => ['Host: store.example.test', 'X-Forwarded-Proto: https', 'Cookie: x=1'], CURLOPT_HEADER => true, CURLOPT_RETURNTRANSFER => true]); echo curl_exec($c);`);
    expect(headers).toMatch(/X-Robots-Tag: noindex, nofollow/i);
    expect(headers).toMatch(/<meta name='robots' content='[^']*noindex/);

    inAgent('sh', '-c', "mkdir -p /var/www/html/wp-content/plugins/broken && printf '<?php\\n/* Plugin Name: Broken */\\nwaas_test_undefined_function();\\n' > /var/www/html/wp-content/plugins/broken/broken.php");
    wp('option', 'update', 'active_plugins', '["broken/broken.php"]', '--format=json');
    try {
      const broken = agent('check-site', { home: HOME });
      expect(broken).toMatchObject({ ok: false, home: 500 });
      expect(broken.fatal).toContain('waas_test_undefined_function');
      expect(broken.fatal).not.toContain('/var/www/html');
    } finally {
      wp('option', 'update', 'active_plugins', '[]', '--format=json');
    }
  });

  it('stays held through a restore, and goes live: cron on, email to everyone', () => {
    const backup = inAgent('sh', '-c', 'cd /tmp && rm -rf b && mkdir b && wp --path=/var/www/html --skip-plugins --skip-themes db export b/database.sql >/dev/null && cp -a /var/www/html/wp-content b/ && cd b && tar -czf /tmp/backup.tar.gz . && echo ok');
    expect(backup.trim()).toBe('ok');
    expect(agent('restore', { url: 'file:///tmp/backup.tar.gz', home: HOME })).toMatchObject({ held: true });
    expect(fileExists('/var/www/html/wp-content/.waas-hold')).toBe(true);
    expect(fileExists('/var/www/html/wp-content/.waas-cron')).toBe(false);

    agent('go-live');
    expect(fileExists('/var/www/html/wp-content/.waas-hold')).toBe(false);
    expect(fileExists('/var/www/html/wp-content/.waas-cron')).toBe(true);
    expect(send()).toEqual(['sent', 'sent', 'sent', 'sent']);
    expect(agent('configure', {})).toMatchObject({ held: false });
  });

  it("compares the export's row counts, passes on its notes, and moves the address WP_SITEURL gave the old site", () => {
    const { restored } = moveIn('counted', {
      sql: "INSERT INTO `{p}posts` (post_title, post_content, post_status, post_type) VALUES ('Linked', 'See https://cms.old.example.com/page', 'publish', 'post');\n",
      info: {
        siteurl: 'https://cms.old.example.com',
        tables: { wp_options: 1, wp_posts: 100000, wp_gone: 3 },
        preflight: {
          notes: [
            { id: 'before', title: 'Before you start', items: ['Free up space.'] },
            { id: 'behind', title: "We'll leave these behind", items: ['Database views: <b>v1</b>'] },
            { id: 'constants', title: 'Re-add these', text: '…', items: ['STRIPE_KEY', 'GF_LICENSE'] },
            { id: 'after', title: 'Check these after the move', items: ['Turn off WP Rocket.'] },
          ],
        },
      },
    });
    expect(restored.rows).toEqual([
      { table: 'wp_posts', exported: 100000, loaded: expect.any(Number) },
      { table: 'wp_gone', exported: 3, loaded: 0 },
    ]);
    expect(restored.notes).toEqual([
      'Left behind on the old site: Database views: v1',
      "Set in the old wp-config.php, which doesn't move: STRIPE_KEY, GF_LICENSE",
      'Turn off WP Rocket.',
    ]);
    expect(sql("SELECT post_content FROM wp_posts WHERE post_title = 'Linked'")).toBe(`See ${HOME}/page`);
  });

  it('moves in a row past MariaDB\'s 16 MB default packet, as one statement', () => {
    const big = 'x'.repeat(20 * 1024 * 1024);
    moveIn('big-row', { sql: `INSERT INTO \`{p}options\` (option_name, option_value, autoload) VALUES ('big_row', '${big}', 'no');\n` });
    expect(sql("SELECT LENGTH(option_value) FROM wp_options WHERE option_name = 'big_row'")).toBe(String(big.length));
  });

  it('fails a backup restore at a statement that fails, instead of reporting a partly loaded database as restored', () => {
    const broken = inAgent('sh', '-c', "cd /tmp && rm -rf r && mkdir r && wp --path=/var/www/html --skip-plugins --skip-themes db export r/database.sql >/dev/null && printf \"INSERT INTO wp_options (option_name, option_value) VALUES ('siteurl', 'twice');\\n\" >> r/database.sql && cd r && tar -czf /tmp/broken.tar.gz . && echo ok");
    expect(broken.trim()).toBe('ok');
    expect(() => agent('restore', { url: 'file:///tmp/broken.tar.gz', home: HOME })).toThrow(/the database could not be restored: .*Duplicate entry 'siteurl'/);
  });
});

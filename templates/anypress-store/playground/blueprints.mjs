// Writes one WordPress Playground blueprint per site type (<type>.json here), built like a real store of that type:
// the store template's theme, plugins and versions (build.sh, theme.sh), its must-use plugins, presets and CRM set-up,
// and AnyPress Client with ANYPRESS_TENANT_ROLES set, so only that type's plugins are on. Each one opens in the
// visitor's own browser ("Try it" on anypress.io and the dashboard's demo pages); nothing is made on the server.
//   node templates/anypress-store/playground/blueprints.mjs          write them
//   node templates/anypress-store/playground/blueprints.mjs --check  fail when one is out of date (CI)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(HERE, '..');
/** The template's own files, from this repository's main branch (raw.githubusercontent.com lets any site read them). */
const RAW = 'https://raw.githubusercontent.com/hamchowderr/waas-provisioning-api/main/templates/anypress-store';
/**
 * Release zips through the AnyPress API: GitHub's release downloads don't let a page read them, so Playground in a
 * browser can't, and AnyPress Client's releases are not GitHub downloads at all (it gets its latest stable release).
 */
const ZIPS = 'https://api.anypress.io/branding/demo-files';
const CLIENT_ZIP = `${ZIPS}/anypress-client.zip`;

/** The site types AnyPress sells (roles.json; `store` is the older name of `everything` and is not sold). */
export const SOLD_TYPES = ['website', 'bookings', 'online-store', 'community', 'everything', 'highlevel'];

const build = readFileSync(resolve(TEMPLATE, 'build.sh'), 'utf8');
const theme = readFileSync(resolve(TEMPLATE, 'theme.sh'), 'utf8');
const roles = JSON.parse(readFileSync(resolve(TEMPLATE, 'roles.json'), 'utf8'));
/**
 * The sample business is made in three runs of sample/run.php, each with only its parts, so the loader says what it is
 * adding while the visitor waits. More runs would say more but each boots WordPress again, which costs seconds.
 */
const SAMPLE_STEPS = [
  { parts: ['mail', 'blog', 'forms'], caption: 'Writing six months of blog posts' },
  {
    parts: ['shop', 'bookings', 'support', 'affiliates', 'community'],
    types: ['bookings', 'online-store', 'community', 'everything'],
    caption: (type) =>
      ({
        bookings: 'Booking three months of sessions',
        'online-store': 'Taking six months of orders',
        community: 'Filling the community',
        everything: 'Taking orders, bookings and members',
      })[type],
  },
  {
    parts: ['extras', 'crm', 'automations', 'logins', 'newsletter', 'pages'],
    caption: (type) => (type === 'highlevel' ? "Building the business's pages" : "Sending the newsletter and building the pages"),
  },
];

/** Sample content for the demo (sample/, started by sample/run.php), so the visitor sees the site type working. */
const SAMPLE = resolve(HERE, 'sample');
const sample = readdirSync(SAMPLE)
  .filter((name) => name.endsWith('.php'))
  .sort()
  .map((name) => ({ step: 'writeFile', path: `/wordpress/anypress-sample/${name}`, data: readFileSync(resolve(SAMPLE, name), 'utf8') }));

const list = (name) =>
  build
    .match(new RegExp(`^${name}="\\n([\\s\\S]*?)\\n"`, 'm'))[1]
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/));
const pin = (source, name) => source.match(new RegExp(`^${name}=\\$\\{${name}:-([^}]+)\\}`, 'm'))[1];

const THEME_VERSION = pin(theme, 'THEME_VERSION');
const BLOCKS_VERSION = pin(build, 'BLOCKS_VERSION');
const PLUGINS = list('PLUGINS');
const OFF_PLUGINS = list('OFF_PLUGINS');
const VENDORED = list('VENDORED');

/** build.sh's install and configure commands, as PHP. */
const setup = (slugs) => `<?php
require '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
wp_set_current_user(1);
global $wp_rewrite;
$wp_rewrite->set_permalink_structure('/%postname%/');
// The MCP Adapter first, as AnyPress Client turns it on on every store: FluentToolkit loads its own copy of the adapter
// when the plugin isn't on yet, and the plugin's classes can't load after that.
if (file_exists(WP_PLUGIN_DIR . '/mcp-adapter/mcp-adapter.php')) activate_plugin('mcp-adapter/mcp-adapter.php');
$files = [];
foreach (get_plugins() as $file => $data) {
    if (in_array(dirname($file), ${JSON.stringify(['anypress-client', ...slugs])}, true)) $files[] = $file;
}
activate_plugins($files);
foreach (['hello-world' => 'post', 'sample-page' => 'page', 'privacy-policy' => 'page'] as $slug => $type) {
    $post = get_page_by_path($slug, OBJECT, $type);
    if ($post) wp_delete_post($post->ID, true);
}
foreach (get_comments(['fields' => 'ids']) as $id) wp_delete_comment($id, true);
update_option('wp_page_for_privacy_policy', 0);
(new \\FluentCart\\App\\CPT\\Pages())->createPages();
update_option('show_on_front', 'page');
update_option('page_on_front', get_page_by_path('shop')->ID);
foreach (get_posts(['post_type' => 'page', 'numberposts' => -1, 'fields' => 'ids']) as $id) update_post_meta($id, '_anypress_needs', 'fluent-cart/fluent-cart.php');
foreach (['blogname' => 'My Store', 'timezone_string' => 'UTC', 'gmt_offset' => 0, 'date_format' => 'F j, Y', 'time_format' => 'H:i', 'default_comment_status' => 'closed', 'default_ping_status' => 'closed', 'default_pingback_flag' => 0, 'blog_public' => 0, 'users_can_register' => 0] as $name => $value) update_option($name, $value);
`;

/** The blueprint for one site type. */
export function blueprint(type) {
  // Every plugin the template installs and turns on, as build.sh does, so its presets and CRM set-up run as they do there;
  // AnyPress Client then turns off the ones this site type doesn't list. The MCP Adapter is on on every store;
  // LeadConnector only matters on HighLevel sites.
  const org = [...PLUGINS, ...OFF_PLUGINS.filter(([slug]) => slug === 'mcp-adapter' || (slug === 'leadconnector' && type === 'highlevel'))];
  const install = (url, caption) => ({ step: 'installPlugin', pluginData: { resource: 'url', url, caption }, options: { activate: false } });
  const file = (path, name) => ({ step: 'writeFile', path, data: { resource: 'url', url: `${RAW}/${name}`, caption: 'Setting up the site' } });
  const slugs = [...PLUGINS.map(([slug]) => slug), ...VENDORED.map(([slug]) => slug), 'anypress-blocks'];

  return {
    $schema: 'https://playground.wordpress.net/blueprint-schema.json',
    meta: {
      title: `AnyPress: ${roles[type].title}`,
      author: 'hamchowderr',
      description: `A new AnyPress ${roles[type].title.toLowerCase()} site, as a store of this type starts: the AnyPress theme, its plugins and settings. Runs in your browser; nothing is saved.`,
      categories: ['AnyPress'],
    },
    landingPage: '/',
    preferredVersions: { php: '8.3', wp: 'latest' },
    features: { networking: true },
    steps: [
      { step: 'login' },
      {
        step: 'installTheme',
        themeData: { resource: 'url', url: `${ZIPS}/anypress-theme-v${THEME_VERSION}.zip`, caption: 'Installing the AnyPress theme' },
        options: { activate: true, targetFolderName: 'anypress' },
      },
      ...org.map(([slug, version]) => install(`https://downloads.wordpress.org/plugin/${slug}.${version}.zip`, `Installing ${slug}`)),
      ...VENDORED.map(([slug, version]) => install(`${RAW}/plugins/${slug}-${version}.zip`, `Installing ${slug}`)),
      install(`${ZIPS}/anypress-blocks-v${BLOCKS_VERSION}.zip`, 'Installing AnyPress Blocks'),
      install(CLIENT_ZIP, 'Installing AnyPress Client'),
      { step: 'mkdir', path: '/wordpress/wp-content/plugins/anypress-client-data' },
      file('/wordpress/wp-content/plugins/anypress-client-data/roles.json', 'roles.json'),
      file('/wordpress/wp-content/mu-plugins/anypress-store.php', 'mu-plugins/anypress-store.php'),
      file('/wordpress/wp-content/mu-plugins/anypress-patterns.php', 'mu-plugins/anypress-patterns.php'),
      file('/wordpress/wp-content/mu-plugins/anypress-crm-lifecycle.php', 'mu-plugins/anypress-crm-lifecycle.php'),
      // As on a store: a tenant of this site type, so AnyPress Client turns off every plugin the type doesn't list.
      {
        step: 'writeFile',
        path: '/wordpress/wp-content/mu-plugins/0-anypress-store-env.php',
        data: `<?php putenv('ANYPRESS_IS_TENANT=true'); define('ANYPRESS_TENANT_ROLES', '${type}');`,
      },
      file('/wordpress/presets.php', 'presets.php'),
      { step: 'mkdir', path: '/wordpress/crm' },
      file('/wordpress/crm/setup.php', 'crm/setup.php'),
      file('/wordpress/crm/emails.json', 'crm/emails.json'),
      // What build.sh does on the template once, in the same order: pretty links, its plugins on, the sample content
      // gone, FluentCart's pages with the shop as home (hidden again on site types without it), the shared settings,
      // then presets.php and the CRM set-up.
      { step: 'runPHP', code: setup(slugs), progress: { caption: 'Setting up the site' } },
      { step: 'runPHP', code: "<?php require '/wordpress/wp-load.php'; wp_set_current_user(1); require '/wordpress/presets.php';", progress: { caption: 'Applying settings' } },
      { step: 'runPHP', code: "<?php require '/wordpress/wp-load.php'; wp_set_current_user(1); require '/wordpress/crm/setup.php'; flush_rewrite_rules();", progress: { caption: 'Setting up the CRM' } },
      // build.sh runs under WP-CLI, so a new store makes its starter pages on its first page load (anypress-patterns.php).
      // These steps are page loads of their own: start that over, so the visitor's first page makes them as a store does.
      { step: 'runPHP', code: "<?php require '/wordpress/wp-load.php'; foreach (get_posts(['post_type' => 'page', 'post_status' => 'any', 'numberposts' => -1, 'meta_query' => [['key' => '_anypress_needs', 'compare' => 'NOT EXISTS']]]) as $p) wp_delete_post($p->ID, true); delete_option('anypress_starter_pages_made'); delete_option('anypress_starter_pages_lock');" },
      // Not on a new store: a sample business for the demo only (posts, contacts, forms, orders, bookings, tickets,
      // affiliates, a community and a course), set up in the plugins this site type has on.
      { step: 'mkdir', path: '/wordpress/anypress-sample' },
      ...sample,
      ...SAMPLE_STEPS.filter((s) => !s.types || s.types.includes(type)).map((s) => ({
        step: 'runPHP',
        code: `<?php define('ANYPRESS_SAMPLE_PARTS', ${JSON.stringify(s.parts)}); require '/wordpress/anypress-sample/run.php';`,
        progress: { caption: typeof s.caption === 'function' ? s.caption(type) : s.caption },
      })),
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const type of SOLD_TYPES) {
    const path = resolve(HERE, `${type}.json`);
    const json = `${JSON.stringify(blueprint(type), null, '\t')}\n`;
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {}
    if (current === json) continue;
    if (check) {
      console.error(`${type}.json is out of date: run node templates/anypress-store/playground/blueprints.mjs`);
      stale++;
    } else writeFileSync(path, json);
  }
  process.exit(stale ? 1 : 0);
}

import { readFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { DEFAULT_SIZE, SIZES, type Size } from '../../plans.ts';

/** The agent script, shipped to each store through an environment variable (no image registry). */
export const AGENT_SCRIPT = readFileSync(new URL('./agent.php', import.meta.url), 'utf8');

const VERSION = /^\d+(\.\d+){0,2}$/;

/** Per-store limits (docs/coolify.md). WordPress's CPU, memory and Apache workers come from the store's size (plans.ts). */
export const LIMITS = { db: { mem: '384m' }, agent: { mem: '256m' } };

/**
 * Starts the official image as usual, after capping Apache's workers. Apache's default of 150 lets about 20
 * visitors at once push a store with every template plugin past its 512 MB, and the kernel then kills
 * workers mid-request. With 8 (about 30 MB each) a small store stays near 270 MB and later visitors wait in
 * Apache's queue; one CPU is busy from about 5 at once, so more workers than the size's CPUs can keep busy
 * would not serve pages any faster. conf-enabled loads after mods-enabled, so these values win. No `$`:
 * Coolify would interpolate it.
 */
const workersConf = (workers: number) =>
  [
    '<IfModule mpm_prefork_module>',
    'StartServers 2',
    'MinSpareServers 2',
    'MaxSpareServers 4',
    `MaxRequestWorkers ${workers}`,
    'MaxConnectionsPerChild 500',
    '</IfModule>',
  ].join('\\n');
/** Keeps the exact Apache and PHP versions out of response headers and error pages (Server, X-Powered-By). */
const HIDE_VERSIONS_CONF = ['ServerTokens Prod', 'ServerSignature Off'].join('\\n');
const HIDE_VERSIONS_INI = 'expose_php = Off';
const wordpressEntrypoint = (workers: number) => [
  'sh',
  '-c',
  `printf '${workersConf(workers)}\\n' > /etc/apache2/conf-enabled/waas-workers.conf && ` +
    `printf '${HIDE_VERSIONS_CONF}\\n' > /etc/apache2/conf-enabled/waas-hide-versions.conf && ` +
    `printf '${HIDE_VERSIONS_INI}\\n' > /usr/local/etc/php/conf.d/waas-hide-versions.ini && ` +
    'exec docker-entrypoint.sh apache2-foreground',
];

/**
 * Defines every phpConstant from WAAS_CONSTANTS_B64 (base64 JSON) in wp-config, through the
 * official image's WORDPRESS_CONFIG_EXTRA. Written without `$`, which Docker Compose and Coolify
 * would both try to interpolate; `@` keeps a redefinition of a constant the image already set
 * from printing a warning.
 *
 * WP-cron does not run on page loads (DISABLE_WP_CRON): a quiet store would run its scheduled
 * jobs late or never. The store's `wp-cron` scheduled task runs them every minute instead
 * (CRON_TASK in provisioner.ts). WP_CACHE loads the page cache drop-in the agent installs (install_cache in
 * agent.php). A phpConstant of the same name comes first and wins.
 */
const CONFIG_EXTRA = [
  "@array_map('define',",
  "array_keys(json_decode(base64_decode((string) getenv('WAAS_CONSTANTS_B64')), true) ?: []),",
  "array_values(json_decode(base64_decode((string) getenv('WAAS_CONSTANTS_B64')), true) ?: []));",
  "defined('DISABLE_WP_CRON') || define('DISABLE_WP_CRON', true);",
  "defined('WP_CACHE') || define('WP_CACHE', true);",
].join(' ');

/** The image a store or version site runs, e.g. wordpress:6.8-php8.3-apache. */
export function wordpressImage(wordPressVersion: string, phpVersion: string): string {
  if (!VERSION.test(wordPressVersion) || !VERSION.test(phpVersion)) throw new Error(`Unsupported WordPress ${wordPressVersion} / PHP ${phpVersion}`);
  return `wordpress:${wordPressVersion}-php${phpVersion}-apache`;
}

/**
 * The Docker Compose file of one store (or version site): WordPress, MariaDB and the WP-CLI agent. A store has a
 * size (plans.ts); a version site has none and runs as small, without quotas.
 */
export function renderCompose(input: { wordPressVersion: string; phpVersion: string; size?: Size }): string {
  const image = wordpressImage(input.wordPressVersion, input.phpVersion);
  const size = SIZES[input.size ?? DEFAULT_SIZE];
  // The plan's quotas, read by the waas-plan mu-plugin (agent.php). Literal values, not Coolify variables: a new
  // size re-renders the compose file anyway. Version sites get none, so the mu-plugin does nothing there.
  const quotas = input.size ? { WAAS_STORAGE_GB: String(size.storageGb), WAAS_EMAILS_PER_MONTH: String(size.emailsPerMonth) } : {};
  const wpEnv = {
    WORDPRESS_DB_HOST: 'db',
    WORDPRESS_DB_NAME: 'wordpress',
    WORDPRESS_DB_USER: 'wordpress',
    // Coolify generates SERVICE_PASSWORD_* values; the API never sees them.
    WORDPRESS_DB_PASSWORD: '${SERVICE_PASSWORD_DB}',
    WORDPRESS_CONFIG_EXTRA: CONFIG_EXTRA,
    WAAS_CONSTANTS_B64: '${WAAS_CONSTANTS_B64:-}',
    // The mail relay's settings, read by the waas-mail mu-plugin (agent.php); empty on version sites.
    WAAS_MAIL_B64: '${WAAS_MAIL_B64:-}',
    // The store's site key: WaaS Client accepts site-editing requests signed with it (src/sitekeys.ts).
    WAAS_SITE_KEY: '${WAAS_SITE_KEY:-}',
    WPCS_IS_TENANT: 'true',
    ...quotas,
  };
  const compose = {
    services: {
      wordpress: {
        image,
        restart: 'unless-stopped',
        entrypoint: wordpressEntrypoint(size.workers),
        environment: wpEnv,
        volumes: ['wp:/var/www/html'],
        depends_on: { db: { condition: 'service_healthy' } },
        mem_limit: size.mem,
        cpus: size.cpus,
        healthcheck: { test: ['CMD', 'php', '-r', "exit(@fsockopen('127.0.0.1', 80) ? 0 : 1);"], interval: '10s', timeout: '5s', retries: 10 },
      },
      db: {
        image: 'mariadb:11',
        restart: 'unless-stopped',
        environment: {
          MARIADB_DATABASE: 'wordpress',
          MARIADB_USER: 'wordpress',
          MARIADB_PASSWORD: '${SERVICE_PASSWORD_DB}',
          MARIADB_ROOT_PASSWORD: '${SERVICE_PASSWORD_ROOT}',
        },
        volumes: ['db:/var/lib/mysql'],
        mem_limit: LIMITS.db.mem,
        healthcheck: { test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'], interval: '10s', timeout: '5s', retries: 10 },
      },
      agent: {
        image: `wordpress:cli-php${input.phpVersion}`,
        restart: 'unless-stopped',
        user: '33:33',
        environment: { ...wpEnv, WAAS_AGENT_B64: Buffer.from(AGENT_SCRIPT).toString('base64'), WAAS_INIT_PASSWORD: '${WAAS_INIT_PASSWORD:-}' },
        command: ['php', '-r', "file_put_contents('/tmp/waas-agent.php', base64_decode(getenv('WAAS_AGENT_B64'))); while (true) sleep(3600);"],
        volumes: ['wp:/var/www/html'],
        depends_on: ['wordpress'],
        mem_limit: LIMITS.agent.mem,
        healthcheck: { test: ['CMD', 'php', '-r', "exit(is_file('/tmp/waas-agent.php') ? 0 : 1);"], interval: '5s', timeout: '5s', retries: 10 },
      },
    },
    volumes: { wp: {}, db: {} },
  };
  return stringify(compose, { lineWidth: 0 });
}

/** The phpConstants as the WAAS_CONSTANTS_B64 value: base64 of a JSON object of name → value. */
export function encodeConstants(constants: Record<string, { value: string }>): string {
  const plain = Object.fromEntries(Object.entries(constants).map(([name, c]) => [name, c.value]));
  for (const name of Object.keys(plain)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid PHP constant name: ${name}`);
  }
  return Buffer.from(JSON.stringify(plain)).toString('base64');
}

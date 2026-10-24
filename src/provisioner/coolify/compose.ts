import { readFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { DEFAULT_SIZE, SIZES, type Size } from '../../plans.ts';

/** The agent script, shipped to each store through an environment variable (no image registry). */
export const AGENT_SCRIPT = readFileSync(new URL('./agent.php', import.meta.url), 'utf8');

const VERSION = /^\d+(\.\d+){0,2}$/;

/** Per-store limits (docs/coolify.md). WordPress's CPU, memory and Apache workers come from the store's size (plans.ts). */
export const LIMITS = { db: { mem: '384m' }, agent: { mem: '256m', cpus: 0.5 } };

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
 * jobs late or never. The agent container runs them every 5 minutes instead (AGENT_COMMAND).
 * WP_CACHE loads the page cache drop-in the agent installs (install_cache in agent.php). A phpConstant of the same name comes first and wins.
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

const WP = 'php -d memory_limit=192M /usr/local/bin/wp';

/** How long one cron command may run, in seconds (busybox `timeout` in the wordpress:cli image). */
export const CRON_LIMIT = 120;

/**
 * The agent container's command: it writes the agent script, then runs the store's cron (WP-cron and Action
 * Scheduler) every 5 minutes, one run after another, while the store is configured and not suspended (CRON_FLAG
 * and FLAG in agent.php). It used to be a Coolify scheduled task per store, but each run was a Coolify job and a
 * "task done" event, and on 2026-10-23 those jammed the queue that deploys and service starts wait in. The first
 * run waits a random 1 to 5 minutes, so stores that start together don't all run at once. Each command is stopped
 * after CRON_LIMIT seconds, as the Coolify task's timeout used to: a queue that never empties (an action that keeps
 * rescheduling itself) would otherwise keep one run going, and a core busy, forever. Written without `$`, which
 * Docker Compose and Coolify would both try to interpolate.
 */
export const AGENT_COMMAND = [
  "file_put_contents('/tmp/waas-agent.php', base64_decode(getenv('WAAS_AGENT_B64')));",
  'sleep(random_int(60, 300));',
  'while (true) {',
  "if (is_file('/var/www/html/wp-content/.waas-cron') && !is_file('/var/www/html/wp-content/.waas-suspended')) {",
  `passthru('timeout ${CRON_LIMIT} ${WP} action-scheduler run --quiet'); passthru('timeout ${CRON_LIMIT} ${WP} cron event run --due-now --quiet');`,
  '}',
  'sleep(300);',
  '}',
].join(' ');

/**
 * Health checks run every minute: each one is a process in the container, and with every store's three containers
 * checking every 5 or 10 seconds they added up to over a thousand a minute. While a container starts they run every
 * 2 seconds, so a new or restarted store is seen healthy as soon as it is.
 */
const HEALTH = { interval: '60s', timeout: '5s', retries: 3, start_period: '180s', start_interval: '2s' };

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
    WAAS_IS_TENANT: 'true',
    // The same flag under the old platform's prefix, for template versions with WaaS Client before 2.4.0.
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
        healthcheck: { test: ['CMD', 'php', '-r', "exit(@fsockopen('127.0.0.1', 80) ? 0 : 1);"], ...HEALTH },
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
        // As many cores as the plan's WordPress gets (the load tests ran the database unlimited, and it never needed
        // more), so one store's database can't take the whole server either.
        cpus: size.cpus,
        healthcheck: { test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'], ...HEALTH },
      },
      agent: {
        image: `wordpress:cli-php${input.phpVersion}`,
        restart: 'unless-stopped',
        user: '33:33',
        environment: { ...wpEnv, WAAS_AGENT_B64: Buffer.from(AGENT_SCRIPT).toString('base64'), WAAS_INIT_PASSWORD: '${WAAS_INIT_PASSWORD:-}' },
        command: ['php', '-r', AGENT_COMMAND],
        volumes: ['wp:/var/www/html'],
        depends_on: ['wordpress'],
        mem_limit: LIMITS.agent.mem,
        // Cron and the agent's operations (backups, restores) never get more than half a core, whatever a store's
        // plugins do: on 2026-10-24 one store's agent ran a core flat out on a shared server.
        cpus: LIMITS.agent.cpus,
        healthcheck: { test: ['CMD', 'php', '-r', "exit(is_file('/tmp/waas-agent.php') ? 0 : 1);"], ...HEALTH },
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

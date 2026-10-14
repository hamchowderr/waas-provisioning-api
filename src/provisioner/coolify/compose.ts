import { readFileSync } from 'node:fs';
import { stringify } from 'yaml';

/** The agent script, shipped to each store through an environment variable (no image registry). */
export const AGENT_SCRIPT = readFileSync(new URL('./agent.php', import.meta.url), 'utf8');

const VERSION = /^\d+(\.\d+){0,2}$/;

/** Per-store limits (docs/coolify.md). */
export const LIMITS = { wordpress: { mem: '512m', cpus: 1 }, db: { mem: '384m' }, agent: { mem: '256m' } };

/**
 * Defines every phpConstant from WAAS_CONSTANTS_B64 (base64 JSON) in wp-config, through the
 * official image's WORDPRESS_CONFIG_EXTRA. Written without `$`, which Docker Compose and Coolify
 * would both try to interpolate; `@` keeps a redefinition of a constant the image already set
 * from printing a warning.
 *
 * WP-cron does not run on page loads (DISABLE_WP_CRON): a quiet store would run its scheduled
 * jobs late or never. The store's `wp-cron` scheduled task runs them every minute instead
 * (CRON_TASK in provisioner.ts). A phpConstant of the same name comes first and wins.
 */
const CONFIG_EXTRA = [
  "@array_map('define',",
  "array_keys(json_decode(base64_decode((string) getenv('WAAS_CONSTANTS_B64')), true) ?: []),",
  "array_values(json_decode(base64_decode((string) getenv('WAAS_CONSTANTS_B64')), true) ?: []));",
  "defined('DISABLE_WP_CRON') || define('DISABLE_WP_CRON', true);",
].join(' ');

/** The image a store or version site runs, e.g. wordpress:6.8-php8.3-apache. */
export function wordpressImage(wordPressVersion: string, phpVersion: string): string {
  if (!VERSION.test(wordPressVersion) || !VERSION.test(phpVersion)) throw new Error(`Unsupported WordPress ${wordPressVersion} / PHP ${phpVersion}`);
  return `wordpress:${wordPressVersion}-php${phpVersion}-apache`;
}

/** The Docker Compose file of one store (or version site): WordPress, MariaDB and the WP-CLI agent. */
export function renderCompose(input: { wordPressVersion: string; phpVersion: string }): string {
  const image = wordpressImage(input.wordPressVersion, input.phpVersion);
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
    WPCS_IS_TENANT: 'true',
  };
  const compose = {
    services: {
      wordpress: {
        image,
        restart: 'unless-stopped',
        environment: wpEnv,
        volumes: ['wp:/var/www/html'],
        depends_on: { db: { condition: 'service_healthy' } },
        mem_limit: LIMITS.wordpress.mem,
        cpus: LIMITS.wordpress.cpus,
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

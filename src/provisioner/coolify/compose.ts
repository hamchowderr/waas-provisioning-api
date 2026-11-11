import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { stringify } from 'yaml';
import { DEFAULT_SIZE, SIZES, type Size } from '../../plans.ts';

/** The agent script, shipped to each store through an environment variable (no image registry). */
export const AGENT_SCRIPT = readFileSync(new URL('./agent.php', import.meta.url), 'utf8');

/**
 * The agent script as the WAAS_AGENT_GZ value: gzipped, then base64. Linux refuses to start a container with any one
 * environment variable over 128 KiB ("argument list too long"); the script alone passed that in base64 on 2026-10-30.
 */
export const AGENT_GZ = gzipSync(AGENT_SCRIPT, { level: 9 }).toString('base64');

/** Linux's limit on one environment variable (MAX_ARG_STRLEN), with room for its name. */
export const ENV_VALUE_LIMIT = 128 * 1024 - 64;

const VERSION = /^\d+(\.\d+){0,2}$/;

/** Per-store limits (docs/coolify.md). PHP's CPU, memory and workers come from the store's size (plans.ts). */
const LIMITS = { web: { mem: '128m' }, db: { mem: '384m' }, agent: { mem: '256m', cpus: 0.5 }, redis: { mem: '64m', cpus: 0.25 } };

/**
 * A store's object cache: its own Redis, holding what WordPress and its plugins look up again and again (options,
 * users, FluentCommunity's settings and feeds) in memory instead of asking the database each time. It helps most
 * where visitors are logged in, which the page cache never serves (community members), and WPManageNinja
 * recommends it for FluentCommunity. Nothing is written to disk (the database stays the only copy), and the least
 * used keys go first once it holds REDIS_MAX. WordPress reaches it through the object-cache.php drop-in the agent
 * installs (install_object_cache in agent.php), which does nothing in a store without WAAS_REDIS_HOST.
 */
const REDIS_MAX = '48mb';
const redisService = () => ({
  image: 'redis:8-alpine',
  restart: 'unless-stopped',
  command: ['redis-server', '--maxmemory', REDIS_MAX, '--maxmemory-policy', 'allkeys-lru', '--save', '', '--appendonly', 'no'],
  mem_limit: LIMITS.redis.mem,
  cpus: LIMITS.redis.cpus,
  healthcheck: { test: ['CMD', 'redis-cli', 'ping'], ...HEALTH },
});

/**
 * PHP-FPM's workers, capped by the store's size. One worker serves one PHP request at a time; more visitors at once wait
 * in Nginx's queue instead of running the store out of memory (each worker is about 45 MB with the template's plugins;
 * docs/coolify.md). Workers start as visitors arrive and go again when the store is quiet, and each is replaced after
 * 500 requests so a slow leak in a plugin can't grow for ever. zz- loads after the image's own zz-docker.conf.
 */
const fpmConf = (workers: number) =>
  [
    '[www]',
    'pm = dynamic',
    `pm.max_children = ${workers}`,
    'pm.start_servers = 2',
    'pm.min_spare_servers = 1',
    'pm.max_spare_servers = 3',
    'pm.max_requests = 500',
    // A little past max_execution_time (phpIni), for a request stuck outside PHP's own clock (a slow database call).
    'request_terminate_timeout = 150s',
  ].join('\\n');
/** Keeps the exact PHP version out of response headers (X-Powered-By); Nginx's is hidden by server_tokens. */
const HIDE_VERSIONS_INI = 'expose_php = Off';

/**
 * PHP's limits, raised from the official image's defaults (128 MB memory, 2 MB uploads, 8 MB posts, a 128 MB OPcache
 * with 8 MB of strings for 4,000 files). WordPress's hosting handbook recommends 256 MB of memory
 * (make.wordpress.org/hosting/handbook/server-environment/) and an OPcache sized for the site (…/performance/): with
 * the template's plugins (about 12,000 PHP files) the default OPcache and its strings buffer were both full after
 * about 20 kinds of page. Uploads stay within the plan's storage (the waas-plan mu-plugin); their size is uploadMb's.
 */
const phpIni = (upload: number) => [
  'memory_limit = 256M',
  `upload_max_filesize = ${upload}M`,
  `post_max_size = ${upload}M`,
  'max_execution_time = 120',
  'opcache.memory_consumption = 192',
  'opcache.interned_strings_buffer = 32',
  'opcache.max_accelerated_files = 20000',
].join('\\n');

/**
 * The largest upload a store takes, in MB. Community and everything stores (the ones with an object cache) take
 * 512 MB, for the videos members post from their phones; the rest keep 64 MB. A domain proxied by Cloudflare is
 * still held to Cloudflare's own limit (100 MB on its Free and Pro plans).
 */
const uploadMb = (community: boolean | undefined) => (community ? 512 : 64);

/**
 * Cloudflare's addresses (cloudflare.com/ips, 2026-11-11). Some stores' domains are proxied by Cloudflare, and a
 * visitor's address then reaches the store behind one of these as well as Coolify's proxy.
 */
const CLOUDFLARE_IPS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32',
  '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

/** The path Nginx's health check asks for: an empty answer from Nginx itself, never from PHP. */
const NGINX_HEALTH = '/.waas-nginx';

/**
 * The store's web server: Nginx in front of PHP-FPM, as WPManageNinja recommends for the Fluent plugins and as
 * WordPress documents it (developer.wordpress.org/advanced-administration/server/web-server/nginx/).
 *
 * - Files that exist are served by Nginx; everything else goes to WordPress (its pretty permalinks).
 * - A suspended store (the .waas-suspended flag, agent.php) answers 503 with its unavailable page before PHP runs.
 * - No PHP runs from uploads, and nothing hidden (.htaccess, the agent's flags) is served. Nginx doesn't read
 *   .htaccess, so the folders the template's plugins lock that way are locked here: Fluent Support's attachments and
 *   LeadConnector's logs entirely, and Fluent Snippets' PHP files (its CSS and JS stay public).
 * - The same response headers as before (no MIME sniffing, a referrer policy, HSTS), each only where WordPress didn't
 *   set its own, and no frame policy: AI apps and the dashboard frame store pages. Files WordPress versions with ?ver=
 *   are cached by browsers for a year (fonts, CSS, JS) or a month (images), the handbook's "Static cache".
 * - The visitor's own address, from Coolify's proxy and Cloudflare's, so FluentAuth's login limits count each visitor.
 * - PHP is looked up by name on each request, so Nginx starts before PHP does and follows it when it restarts.
 *
 * Written as base64: the file is full of `$`, which Coolify would interpolate.
 */
const nginxConf = (upload: number) => [
  'server_tokens off;',
  `client_max_body_size ${upload}m;`,
  'gzip on;',
  'gzip_vary on;',
  'gzip_proxied any;',
  'gzip_comp_level 5;',
  'gzip_min_length 1024;',
  'gzip_types text/plain text/css text/javascript application/javascript application/json application/xml application/rss+xml image/svg+xml font/ttf;',
  ...['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', ...CLOUDFLARE_IPS].map((range) => `set_real_ip_from ${range};`),
  'real_ip_header X-Forwarded-For;',
  'real_ip_recursive on;',
  'resolver 127.0.0.11 valid=10s ipv6=off;',
  'map $upstream_http_x_content_type_options $waas_nosniff { "" nosniff; default ""; }',
  'map $upstream_http_referrer_policy $waas_referrer { "" strict-origin-when-cross-origin; default ""; }',
  'map $upstream_http_strict_transport_security $waas_hsts { "" "max-age=31536000"; default ""; }',
  'server {',
  '  listen 80 default_server;',
  '  server_name _;',
  '  root /var/www/html;',
  '  index index.php index.html;',
  // Nginx's own redirects (a folder without its slash, /wp-admin) keep the visitor's scheme and port.
  '  absolute_redirect off;',
  '  add_header X-Content-Type-Options $waas_nosniff always;',
  '  add_header Referrer-Policy $waas_referrer always;',
  '  add_header Strict-Transport-Security $waas_hsts always;',
  '  set $waas_down "";',
  '  if (-f $document_root/wp-content/.waas-suspended) { set $waas_down 1; }',
  '  if ($uri = /wp-content/waas-unavailable.html) { set $waas_down ""; }',
  `  if ($uri = ${NGINX_HEALTH}) { set $waas_down ""; }`,
  '  if ($waas_down) { return 503; }',
  '  error_page 503 /wp-content/waas-unavailable.html;',
  '  location = /wp-content/waas-unavailable.html { expires -1; }',
  `  location = ${NGINX_HEALTH} { access_log off; return 204; }`,
  '  location = /favicon.ico { log_not_found off; access_log off; try_files $uri /index.php?$args; }',
  '  location = /robots.txt { log_not_found off; access_log off; try_files $uri /index.php?$args; }',
  '  location ~ /\\.(?!well-known/) { deny all; }',
  '  location ^~ /wp-content/uploads/fluent-support/ { deny all; }',
  '  location ^~ /wp-content/leadconnector-logs/ { deny all; }',
  '  location ~* ^/wp-content/(fluent-snippet-storage|uploads/fluent-snippets)/.*\\.php$ { deny all; }',
  '  location ~* ^/wp-content/uploads/.*\\.(php|phtml|phar|php[3-8])$ { deny all; }',
  '  location ~* \\.(css|js|mjs|woff2?|ttf|otf|eot)$ { expires 1y; access_log off; try_files $uri /index.php?$args; }',
  '  location ~* \\.(png|jpe?g|gif|webp|avif|svg|ico)$ { expires 1M; access_log off; try_files $uri /index.php?$args; }',
  '  location / { try_files $uri $uri/ /index.php?$args; }',
  '  location ~ \\.php$ {',
  '    try_files $uri =404;',
  '    include fastcgi_params;',
  '    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
  '    fastcgi_param HTTP_PROXY "";',
  '    fastcgi_read_timeout 150s;',
  '    fastcgi_buffers 16 16k;',
  '    fastcgi_buffer_size 32k;',
  '    set $waas_php php:9000;',
  '    fastcgi_pass $waas_php;',
  '  }',
  '}',
  '',
].join('\n');

const phpEntrypoint = (workers: number, upload: number) => [
  'sh',
  '-c',
  `printf '${fpmConf(workers)}\\n' > /usr/local/etc/php-fpm.d/zz-waas.conf && ` +
    `printf '${HIDE_VERSIONS_INI}\\n' > /usr/local/etc/php/conf.d/waas-hide-versions.ini && ` +
    `printf '${phpIni(upload)}\\n' > /usr/local/etc/php/conf.d/waas-php.ini && ` +
    // The official image sets WordPress up (wp-config, the files on a new volume) only for a php-fpm command.
    'exec docker-entrypoint.sh php-fpm',
];

const nginxEntrypoint = (upload: number) => [
  'sh',
  '-c',
  `echo ${Buffer.from(nginxConf(upload)).toString('base64')} | base64 -d > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'`,
];

/** The Nginx release stores run: the stable line (nginx.org/en/download.html), following its patch releases. */
export const NGINX_IMAGE = 'nginx:1.30-alpine';

/**
 * Defines every phpConstant from WAAS_CONSTANTS_B64 (base64 JSON) in wp-config, through the
 * official image's WORDPRESS_CONFIG_EXTRA. Written without `$`, which Docker Compose and Coolify
 * would both try to interpolate; `@` keeps a redefinition of a constant the image already set
 * from printing a warning.
 *
 * WP-cron does not run on page loads (DISABLE_WP_CRON): a quiet store would run its scheduled
 * jobs late or never. The agent container runs them every minute instead (AGENT_COMMAND).
 * WP_CACHE loads the page cache drop-in the agent installs (install_cache in agent.php). A phpConstant of the same name comes first and wins.
 */
const CONFIG_EXTRA = [
  "@array_map('define',",
  "array_keys(json_decode(base64_decode((string) getenv('WAAS_CONSTANTS_B64')), true) ?: []),",
  "array_values(json_decode(base64_decode((string) getenv('WAAS_CONSTANTS_B64')), true) ?: []));",
  "defined('DISABLE_WP_CRON') || define('DISABLE_WP_CRON', true);",
  "defined('WP_CACHE') || define('WP_CACHE', true);",
  // WordPress's hardening guide: no theme and plugin file editor in wp-admin (developer.wordpress.org/advanced-administration/security/hardening/).
  "defined('DISALLOW_FILE_EDIT') || define('DISALLOW_FILE_EDIT', true);",
].join(' ');

/** The image a store or version site's PHP runs, e.g. wordpress:6.8-php8.3-fpm. */
function wordpressImage(wordPressVersion: string, phpVersion: string): string {
  if (!VERSION.test(wordPressVersion) || !VERSION.test(phpVersion)) throw new Error(`Unsupported WordPress ${wordPressVersion} / PHP ${phpVersion}`);
  return `wordpress:${wordPressVersion}-php${phpVersion}-fpm`;
}

const WP = 'php -d memory_limit=192M /usr/local/bin/wp';

/** How long one cron command may run, in seconds (busybox `timeout` in the wordpress:cli image). */
export const CRON_LIMIT = 120;

/**
 * The agent container's command: it writes the agent script, then runs the store's cron (WP-cron and Action
 * Scheduler) every minute, as FluentCRM asks (fluentcrm.com/docs/fluentcrm-cron-job-basics-and-checklist/), one run after another, while the store is configured and not suspended (CRON_FLAG
 * and FLAG in agent.php). It used to be a Coolify scheduled task per store, but each run was a Coolify job and a
 * "task done" event, and on 2026-10-23 those jammed the queue that deploys and service starts wait in. The first
 * run waits a random 1 to 5 minutes, so stores that start together don't all run at once. Each command is stopped
 * after CRON_LIMIT seconds, as the Coolify task's timeout used to: a queue that never empties (an action that keeps
 * rescheduling itself) would otherwise keep one run going, and a core busy, forever. Written without `$`, which
 * Docker Compose and Coolify would both try to interpolate.
 */
export const AGENT_COMMAND = [
  "file_put_contents('/tmp/waas-agent.php', gzdecode(base64_decode(getenv('WAAS_AGENT_GZ'))));",
  'sleep(random_int(60, 300));',
  'while (true) {',
  "if (is_file('/var/www/html/wp-content/.waas-cron') && !is_file('/var/www/html/wp-content/.waas-suspended')) {",
  `passthru('timeout ${CRON_LIMIT} ${WP} action-scheduler run --quiet'); passthru('timeout ${CRON_LIMIT} ${WP} cron event run --due-now --quiet');`,
  '}',
  'sleep(60);',
  '}',
].join(' ');

/**
 * Health checks run every minute: each one is a process in the container, and with every store's three containers
 * checking every 5 or 10 seconds they added up to over a thousand a minute. While a container starts they run every
 * 2 seconds, so a new or restarted store is seen healthy as soon as it is.
 */
const HEALTH = { interval: '60s', timeout: '5s', retries: 3, start_period: '180s', start_interval: '2s' };

/**
 * The Traefik service the website assistant's chat panel declares on its own container (a label in
 * agent/panel/Dockerfile): every store's /.assistant router sends its requests there.
 */
const ASSISTANT_PANEL_SERVICE = 'website-assistant-panel';

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The labels that send https://<each of the store's domains>/.assistant to the website assistant's panel, so the
 * store's owner opens it on their own website. The proxy does it, not WordPress: a reply streams for a while, and
 * passing it through would hold one of the store's few PHP workers the whole time. The rule is longer than
 * Coolify's own Host(...) && PathPrefix(`/`), so Traefik tries it first; plain http is sent to https by Coolify's
 * router as for every other path. Each domain's certificate is the one the store already has.
 */
function assistantLabels(router: string, domains: string[]): string[] {
  if (!/^[a-z0-9-]+$/.test(router)) throw new Error(`Invalid router name: ${router}`);
  const hosts = domains.map((d) => d.toLowerCase());
  for (const host of hosts) if (!DOMAIN.test(host)) throw new Error(`Invalid store domain: ${host}`);
  if (!hosts.length) return [];
  const name = `traefik.http.routers.${router}`;
  return [
    `${name}.entryPoints=https`,
    `${name}.rule=(${hosts.map((h) => `Host(\`${h}\`)`).join(' || ')}) && (Path(\`/.assistant\`) || PathPrefix(\`/.assistant/\`))`,
    `${name}.service=${ASSISTANT_PANEL_SERVICE}@docker`,
    `${name}.tls=true`,
    `${name}.tls.certresolver=letsencrypt`,
  ];
}

/**
 * The Docker Compose file of one store (or version site): Nginx, WordPress on PHP-FPM, MariaDB and the WP-CLI agent. A store has a
 * size (plans.ts); a version site has none and runs as small, without quotas. A store also has `assistant`: its
 * router name and domains for the website assistant on its own domain (assistantLabels).
 */
export function renderCompose(input: {
  wordPressVersion: string;
  phpVersion: string;
  size?: Size;
  assistant?: { router: string; domains: string[] };
  /** The store's own Redis object cache (redisService): community and everything stores. */
  cache?: boolean;
}): string {
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
    // The store's site key: AnyPress Client accepts site-editing requests signed with it (src/sitekeys.ts).
    ANYPRESS_SITE_KEY: '${WAAS_SITE_KEY:-}',
    // Tells AnyPress Client it runs on a customer's store.
    ANYPRESS_IS_TENANT: 'true',
    ...quotas,
    ...(input.cache ? { WAAS_REDIS_HOST: 'redis' } : {}),
  };
  const compose = {
    services: {
      // The service Coolify gives the store's domains (urlsFor in provisioner.ts): its web server.
      wordpress: {
        image: NGINX_IMAGE,
        restart: 'unless-stopped',
        entrypoint: nginxEntrypoint(uploadMb(input.cache)),
        volumes: ['wp:/var/www/html:ro'],
        depends_on: ['php'],
        mem_limit: LIMITS.web.mem,
        cpus: size.cpus,
        healthcheck: { test: ['CMD', 'wget', '-q', '-O', '/dev/null', `http://127.0.0.1${NGINX_HEALTH}`], ...HEALTH },
        ...(input.assistant ? { labels: assistantLabels(input.assistant.router, input.assistant.domains) } : {}),
      },
      php: {
        image,
        restart: 'unless-stopped',
        entrypoint: phpEntrypoint(size.workers, uploadMb(input.cache)),
        environment: wpEnv,
        volumes: ['wp:/var/www/html'],
        depends_on: { db: { condition: 'service_healthy' }, ...(input.cache ? { redis: { condition: 'service_started' } } : {}) },
        mem_limit: size.mem,
        cpus: size.cpus,
        healthcheck: { test: ['CMD', 'php', '-r', "exit(@fsockopen('127.0.0.1', 9000) ? 0 : 1);"], ...HEALTH },
      },
      db: {
        image: 'mariadb:11',
        restart: 'unless-stopped',
        // One row is one packet, and a moved-in site can hold a row (a big option, a page builder's post) past
        // MariaDB's 16 MB default. The buffer only grows when such a packet arrives.
        command: ['--max-allowed-packet=256M'],
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
        environment: { ...wpEnv, WAAS_AGENT_GZ: AGENT_GZ, WAAS_INIT_PASSWORD: '${WAAS_INIT_PASSWORD:-}' },
        command: ['php', '-r', AGENT_COMMAND],
        volumes: ['wp:/var/www/html'],
        depends_on: ['php'],
        mem_limit: LIMITS.agent.mem,
        // Cron and the agent's operations (backups, restores) never get more than half a core, whatever a store's
        // plugins do: on 2026-10-24 one store's agent ran a core flat out on a shared server.
        cpus: LIMITS.agent.cpus,
        healthcheck: { test: ['CMD', 'php', '-r', "exit(is_file('/tmp/waas-agent.php') ? 0 : 1);"], ...HEALTH },
      },
      ...(input.cache ? { redis: redisService() } : {}),
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

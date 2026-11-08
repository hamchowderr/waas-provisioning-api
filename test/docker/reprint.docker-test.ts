import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationToken, newReprintKey } from '../../src/imports.ts';
import { Secrets } from '../../src/secrets.ts';

/*
 * Copying a site in with WordPress's Reprint, end to end on real containers (npm run test:docker): an old site, a
 * WordPress with the Reprint plugin from wordpress.org that has authorized the store's Migration Token, and a store as
 * compose.ts runs one (WordPress and the WP-CLI agent sharing the volume, MariaDB). The store's agent copies the old
 * site with the official Reprint client (`restore` with `reprint`) and builds itself from it.
 *
 * Plain http between the containers: the agent allows it only with WAAS_REPRINT_ALLOW_HTTP, which no store has. Needs
 * Docker and the internet (the Reprint plugin and client come from wordpress.org).
 */

const AGENT = fileURLToPath(new URL('../../src/provisioner/coolify/agent.php', import.meta.url));
const IMAGES = {
  db: process.env.WAAS_TEST_MARIADB_IMAGE ?? 'mirror.gcr.io/library/mariadb:11',
  wordpress: process.env.WAAS_TEST_WORDPRESS_IMAGE ?? 'mirror.gcr.io/library/wordpress:php8.3-apache',
  cli: process.env.WAAS_TEST_CLI_IMAGE ?? 'mirror.gcr.io/library/wordpress:cli-php8.3',
};
/** The version of the Reprint plugin the old site runs; the agent pins the client (REPRINT_VERSION). */
const REPRINT_PLUGIN = 'https://downloads.wordpress.org/plugin/reprint.0.11.6.zip';
const RUN = randomBytes(4).toString('hex');
const N = {
  network: `waas-rp-${RUN}`,
  db: `waas-rp-db-${RUN}`,
  storeVolume: `waas-rp-store-${RUN}`,
  store: `waas-rp-store-${RUN}`,
  agent: `waas-rp-agent-${RUN}`,
  oldVolume: `waas-rp-old-${RUN}`,
  old: `waas-rp-old-${RUN}`,
  oldCli: `waas-rp-oldcli-${RUN}`,
};
const HOME = 'https://store.example.test';
/** The old site, as the store's agent reaches it. */
const OLD = 'http://oldsite';
const dbEnv = (name: string) => ['WORDPRESS_DB_HOST=db', `WORDPRESS_DB_NAME=${name}`, 'WORDPRESS_DB_USER=wordpress', 'WORDPRESS_DB_PASSWORD=wordpress'];
const CONFIG_EXTRA = "define('DISABLE_WP_CRON', true);";

const docker = (...args: string[]) => {
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${(res.stderr || res.stdout).slice(-1500)}`);
  return res.stdout;
};
const inContainer = (name: string, ...args: string[]) => docker('exec', '-u', '33:33', '-e', 'HOME=/tmp', name, ...args);
/** WP-CLI on the store, or on the old site. */
const wp = (...args: string[]) => inContainer(N.agent, 'wp', '--path=/var/www/html', '--skip-plugins', '--skip-themes', ...args).trim();
const oldWp = (...args: string[]) => inContainer(N.oldCli, 'wp', '--path=/var/www/html', ...args).trim();
const exists = (name: string, path: string) => spawnSync('docker', ['exec', name, 'test', '-e', path]).status === 0;

function agent(op: string, args: Record<string, unknown> = {}): Record<string, any> {
  const res = spawnSync('docker', ['exec', '-u', '33:33', N.agent, 'php', '/tmp/waas-agent.php', op, Buffer.from(JSON.stringify(args)).toString('base64')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const result = /^WAAS_RESULT (.*)$/m.exec(res.stdout);
  if (res.status !== 0 || !result) throw new Error(`agent ${op}: ${/^WAAS_ERROR (.*)$/m.exec(res.stdout)?.[1] ?? (res.stdout + res.stderr).slice(-1500)}`);
  return JSON.parse(result[1]!);
}

const until = (what: string, test: () => boolean, seconds = 120) => {
  const deadline = Date.now() + seconds * 1000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${seconds} s`);
    spawnSync('sleep', ['1']);
  }
};

const secrets = new Secrets(randomBytes(32).toString('base64'));
/** The store's key, as the API keeps it, and the one an old site never authorized. */
let key: string;
let otherKey: string;

beforeAll(async () => {
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  if (info.status !== 0) throw new Error(`These tests need Docker, and it is not available here: ${(info.stderr || info.stdout).trim().slice(-300)}.`);
  const stored = await newReprintKey(secrets);
  key = secrets.decrypt(stored);
  otherKey = secrets.decrypt(await newReprintKey(secrets));

  docker('network', 'create', N.network);
  docker('volume', 'create', N.storeVolume);
  docker('volume', 'create', N.oldVolume);
  docker('run', '-d', '--name', N.db, '--network', N.network, '--network-alias', 'db',
    '-e', 'MARIADB_DATABASE=wordpress', '-e', 'MARIADB_USER=wordpress', '-e', 'MARIADB_PASSWORD=wordpress', '-e', 'MARIADB_ROOT_PASSWORD=root', IMAGES.db, '--max-allowed-packet=256M');
  until('MariaDB starting', () => spawnSync('docker', ['exec', N.db, 'healthcheck.sh', '--connect', '--innodb_initialized']).status === 0);
  docker('exec', N.db, 'mariadb', '-uroot', '-proot', '-e', "CREATE DATABASE oldsite; GRANT ALL ON oldsite.* TO 'wordpress'@'%';");

  // The old site, with its own database on the same server.
  docker('run', '-d', '--name', N.old, '--network', N.network, '--network-alias', 'oldsite', '-v', `${N.oldVolume}:/var/www/html`,
    ...dbEnv('oldsite').flatMap((e) => ['-e', e]), '-e', `WORDPRESS_CONFIG_EXTRA=${CONFIG_EXTRA}`, IMAGES.wordpress);
  docker('run', '-d', '--name', N.oldCli, '--network', N.network, '-v', `${N.oldVolume}:/var/www/html`, ...dbEnv('oldsite').flatMap((e) => ['-e', e]),
    '--entrypoint', 'tail', IMAGES.cli, '-f', '/dev/null');
  // The store.
  docker('run', '-d', '--name', N.store, '--network', N.network, '-v', `${N.storeVolume}:/var/www/html`,
    ...dbEnv('wordpress').flatMap((e) => ['-e', e]), '-e', `WORDPRESS_CONFIG_EXTRA=${CONFIG_EXTRA}`, IMAGES.wordpress);
  docker('run', '-d', '--name', N.agent, '--network', N.network, '-v', `${N.storeVolume}:/var/www/html`, '-v', `${AGENT}:/tmp/waas-agent.php:ro`,
    ...dbEnv('wordpress').flatMap((e) => ['-e', e]), '-e', `WORDPRESS_CONFIG_EXTRA=${CONFIG_EXTRA}`, '-e', 'WAAS_REPRINT_ALLOW_HTTP=1',
    '--entrypoint', 'tail', IMAGES.cli, '-f', '/dev/null');
  until('WordPress copying its files', () => exists(N.oldCli, '/var/www/html/wp-config.php') && exists(N.agent, '/var/www/html/wp-config.php'));

  oldWp('core', 'install', `--url=${OLD}`, '--title=Old Shop', '--admin_user=admin', '--admin_email=owner@old.example.com', '--admin_password=old-password-not-real', '--skip-email');
  oldWp('post', 'create', '--post_title=Hello from the old site', '--post_status=publish', `--post_content=<!-- wp:paragraph --><p><a href="${OLD}/about/">About</a></p><!-- /wp:paragraph -->`);
  oldWp('eval', `update_option('ap_probe', ['link' => '${OLD}/shop/']); wp_mkdir_p(WP_CONTENT_DIR . '/uploads/2026/11'); file_put_contents(WP_CONTENT_DIR . '/uploads/2026/11/photo.txt', 'a photo');`);
  // Reprint from wordpress.org, which has authorized the store's Migration Token (as the owner pastes it there).
  oldWp('plugin', 'install', REPRINT_PLUGIN, '--activate');
  const keys = Buffer.from(`<?php\nreturn [${JSON.stringify(migrationToken(secrets, stored))}];\n`).toString('base64');
  inContainer(N.oldCli, 'sh', '-c', `echo ${keys} | base64 -d > /var/www/html/wp-content/plugins/reprint/public-keys.php`);
  // The store's own WordPress, before the move.
  wp('core', 'install', `--url=${HOME}`, '--title=Store', '--admin_user=waas-admin', '--admin_email=admin@example.invalid', '--admin_password=x', '--skip-email');
}, 900_000);

afterAll(() => {
  for (const name of [N.agent, N.store, N.oldCli, N.old, N.db]) spawnSync('docker', ['rm', '-f', name]);
  for (const volume of [N.storeVolume, N.oldVolume]) spawnSync('docker', ['volume', 'rm', '-f', volume]);
  spawnSync('docker', ['network', 'rm', N.network]);
});

describe('copying a site in with Reprint', () => {
  it("copies the old site's database and wp-content into the store and moves its address", () => {
    const restored = agent('restore', { reprint: { site: OLD, key }, home: HOME, import: true });
    expect(restored).toMatchObject({ database: true, content: true, held: true, previousHome: OLD, source: { home: OLD, tablePrefix: 'wp_' } });
    agent('configure', { home: HOME, options: {}, holdAllow: [] });
    expect(wp('option', 'get', 'home')).toBe(HOME);
    expect(wp('option', 'get', 'blogname')).toBe('Old Shop');
    expect(wp('post', 'list', '--post_type=post', '--field=post_title')).toContain('Hello from the old site');
    expect(wp('option', 'pluck', 'ap_probe', 'link')).toBe(`${HOME}/shop/`);
    expect(inContainer(N.agent, 'cat', '/var/www/html/wp-content/uploads/2026/11/photo.txt')).toBe('a photo');
    expect(wp('user', 'list', '--role=administrator', '--field=user_login')).toBe('admin');
    // The old site's Reprint stays behind, and so do the store's copy, progress and key.
    expect(exists(N.agent, '/var/www/html/wp-content/plugins/reprint')).toBe(false);
    expect(inContainer(N.agent, 'sh', '-c', 'ls /tmp/waas-reprint').trim()).toBe('reprint-0.11.6.phar');
  });

  it("copies again, bringing what was added on the old site since", () => {
    oldWp('post', 'create', '--post_title=Posted after the first copy', '--post_status=publish');
    agent('restore', { reprint: { site: OLD, key }, home: HOME, import: true });
    expect(wp('post', 'list', '--post_type=post', '--field=post_title')).toContain('Posted after the first copy');
    expect(wp('option', 'get', 'home')).toBe(HOME);
  });

  it('fails with Reprint\'s code when the old site has not authorized the key, leaving the store as it was', () => {
    expect(() => agent('restore', { reprint: { site: OLD, key: otherKey }, home: HOME, import: true })).toThrow(/reprint AUTH_UNKNOWN_KEY/);
    expect(wp('post', 'list', '--post_type=post', '--field=post_title')).toContain('Posted after the first copy');
  });

  it('refuses plain http without the test switch, and an address that is not one', () => {
    expect(() => agent('restore', { reprint: { site: 'ftp://oldsite', key }, home: HOME, import: true })).toThrow(/the old site address and the key are required/);
  });
});

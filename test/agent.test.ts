import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

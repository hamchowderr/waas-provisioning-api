// The site-type blueprints (templates/anypress-store/playground): one per site type sold, generated from the store
// template, so "Try it" opens a site built like a real store of that type.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../templates/anypress-store/playground/', import.meta.url);
const roles = JSON.parse(readFileSync(new URL('../templates/anypress-store/roles.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TYPES = ['website', 'bookings', 'online-store', 'community', 'everything', 'highlevel'];

describe('site-type Playground blueprints', () => {
  it('are up to date with the store template', () => {
    expect(() => execFileSync('node', [new URL('blueprints.mjs', DIR).pathname, '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it.each(TYPES)('%s is a store of that type: AnyPress Client on, with ANYPRESS_TENANT_ROLES set', (type) => {
    expect(roles[type]).toBeDefined();
    const bp = JSON.parse(readFileSync(new URL(`${type}.json`, DIR), 'utf8'));
    const env = bp.steps.find((s: { path?: string }) => s.path?.endsWith('0-anypress-store-env.php'));
    expect(env.data).toContain(`define('ANYPRESS_TENANT_ROLES', '${type}')`);
    const setup = bp.steps.find((s: { step: string; code?: string }) => s.step === 'runPHP' && s.code?.includes('activate_plugins('));
    expect(setup.code).toContain('"anypress-client"');
    expect(JSON.stringify(bp)).not.toMatch(/ollie|twentytwenty/i);
    const leadconnector = bp.steps.some((s: { pluginData?: { url?: string } }) => s.pluginData?.url?.includes('/leadconnector.'));
    expect(leadconnector).toBe(type === 'highlevel');
  });
});

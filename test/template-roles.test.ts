// The store template's site types (templates/anypress-store/roles.json): AnyPress Client turns off every plugin a
// site's type doesn't list, so the ones every site needs must stay in every type.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const roles = JSON.parse(readFileSync(new URL('../templates/anypress-store/roles.json', import.meta.url), 'utf8')) as Record<
  string,
  { title: string; plugins: string[] }
>;

// FluentAuth, FluentSnippets (code snippets and shortcodes), FluentHub (FluentToolkit) and AnyPress Blocks.
const EVERY_SITE = [
  'fluent-security/fluent-security.php',
  'easy-code-manager/easy-code-manager.php',
  'fluent-toolkit/fluent-toolkit.php',
  'anypress-blocks/anypress-blocks.php',
];

describe('store template site types', () => {
  it.each(Object.keys(roles))('%s keeps the plugins every site needs', (role) => {
    expect(roles[role]!.plugins).toEqual(expect.arrayContaining(EVERY_SITE));
  });

  it('HighLevel sites keep WP Fusion and LeadConnector, and no Fluent business plugin', () => {
    const plugins = roles.highlevel!.plugins;
    expect(plugins).toEqual(expect.arrayContaining(['wp-fusion-lite/wp-fusion-lite.php', 'leadconnector/leadconnector.php']));
    for (const p of ['fluent-crm/fluent-crm.php', 'fluentform/fluentform.php', 'fluent-cart/fluent-cart.php', 'fluent-booking/fluent-booking.php']) {
      expect(plugins).not.toContain(p);
    }
  });
});

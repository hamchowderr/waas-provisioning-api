// The check an uploaded premium plugin zip goes through (src/pluginzip.ts) before any version installs it.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectPluginZip, PluginZipError } from '../src/pluginzip.ts';
import { makeZip, pluginZip } from './zip.ts';

const refused = (bytes: Uint8Array) => {
  try {
    inspectPluginZip(bytes);
  } catch (err) {
    expect(err).toBeInstanceOf(PluginZipError);
    return (err as Error).message;
  }
  throw new Error('the zip was accepted');
};

describe('plugin zip check', () => {
  it('reads the plugin from a zip as vendors ship it', () => {
    const bytes = pluginZip('gravityforms');
    expect(inspectPluginZip(bytes)).toEqual({
      slug: 'gravityforms',
      file: 'gravityforms/gravityforms.php',
      name: 'gravityforms Pro',
      version: '2.9.1',
      requiresPhp: '7.4',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    });
    // Stored (uncompressed) zips, a main file named otherwise, and macOS clutter are fine.
    const other = makeZip(
      {
        'my-addon/loader.php': '<?php // helper\n',
        'my-addon/plugin.php': '<?php\n/*\nPlugin Name: My Add-on */\n',
        '__MACOSX/my-addon/._plugin.php': 'x',
        'my-addon/.DS_Store': 'x',
      },
      { deflate: false },
    );
    expect(inspectPluginZip(other)).toMatchObject({ slug: 'my-addon', file: 'my-addon/plugin.php', name: 'My Add-on', version: null });
  });

  it('refuses zips that are not one plugin', () => {
    expect(refused(new Uint8Array(Buffer.from('not a zip at all, just text')))).toBe('The file is not a zip');
    expect(refused(makeZip({ 'a.php': '<?php', 'b/b.php': '<?php' }))).toContain('one folder');
    expect(refused(makeZip({ 'one/one.php': '<?php\n/* Plugin Name: One */', 'two/two.php': '<?php' }))).toContain('one folder');
    expect(refused(makeZip({ 'Bad_Name/x.php': '<?php\n/* Plugin Name: X */' }))).toContain('lowercase');
    expect(refused(makeZip({ 'theme/style.css': '/* Theme Name: T */' }))).toContain('Plugin Name');
    expect(refused(makeZip({ 'p/../../evil.php': '<?php' }))).toContain('unsafe path');
    expect(refused(pluginZip('locked', '1.0').slice(0, 0))).toBe('The file is not a zip');
    expect(refused(makeZip({ 'locked/locked.php': '<?php\n/* Plugin Name: L */' }, { encrypted: true }))).toBe('The zip is password protected');
  });

  it('refuses the code hacked or nulled copies carry', () => {
    const cases: [string, string][] = [
      ['<?php eval(base64_decode("ZWNobyAx"));', 'runs decoded code'],
      ['<?php @eval( gzinflate(base64_decode($x)) );', 'runs decoded code'],
      ['<?php eval($_POST["c"]);', 'runs code sent in a request'],
      ['<?php assert(stripslashes($_REQUEST["c"]));', 'runs code sent in a request'],
      ["<?php preg_replace('/.*/e', $_GET['x'], '');", 'preg_replace /e'],
      ['<?php $f = create_function("", base64_decode($p));', 'builds functions'],
      ['<?php // FilesMan', 'web shell'],
      [`<?php $p = '${'QUJD'.repeat(2100)}'; eval($p);`, 'large encoded payload'],
    ];
    for (const [code, what] of cases) {
      expect(refused(pluginZip('nulled', '1.0', { 'nulled/includes/license.php': code }))).toContain(what);
    }
    // Ordinary code that only mentions these words passes.
    expect(inspectPluginZip(pluginZip('clean', '1.0', { 'clean/includes/x.php': '<?php $s = base64_decode($token); echo esc_html($s); // eval is evil' })).slug).toBe('clean');
  });
});

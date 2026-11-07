import { createHash } from 'node:crypto';
import { PLUGIN_SLUG } from './wporg.ts';
import { listEntries, openZip, readEntry, type Entry, type ZipFile } from './zip.ts';

/**
 * Checks an uploaded plugin zip (a premium plugin a seller bought, docs/plugin-choices.md) before any version
 * can install it: a plain zip, one top-level folder named like a plugin slug, a main PHP file with a
 * "Plugin Name:" header, no paths that climb out of that folder, and none of the obfuscation that hacked or
 * "nulled" copies of premium plugins carry.
 */

export interface PluginZipInfo {
  slug: string;
  /** "slug/file.php", as WordPress names it in active_plugins. */
  file: string;
  name: string;
  version: string | null;
  requiresPhp: string | null;
  sha256: string;
  sizeBytes: number;
}

export class PluginZipError extends Error {}

/** All files unpacked at most; zip bombs stop here. */
const MAX_UNPACKED = 300 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

/**
 * Code that only hacked copies need: running decoded or decompressed strings, eval of request input, and
 * the shells and loaders malware drops. Real premium plugins don't do these.
 */
const MALWARE: [RegExp, string][] = [
  [/\beval\s*\(\s*(?:base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|hex2bin|rawurldecode)\s*\(/i, 'runs decoded code (eval of base64_decode, gzinflate or similar)'],
  [/\b(?:assert|eval)\s*\(\s*(?:stripslashes\s*\(\s*)?\$_(?:GET|POST|REQUEST|COOKIE|SERVER)\b/i, 'runs code sent in a request'],
  [/\bpreg_replace\s*\(\s*(['"])([^\w\s])[^'"\n]{0,500}\2[imsxuADSUX]*e[imsxuADSUX]*\1/, 'runs code through preg_replace /e'],
  [/\bcreate_function\s*\(\s*(['"])\1\s*,\s*(?:base64_decode|gzinflate|\$_)/i, 'builds functions from decoded or request input'],
  [/\b(?:FilesMan|WSO\s+\d|c99shell|r57shell|b374k|IndoXploit|Alfa\s*Shell)\b/, 'contains a known web shell'],
  [/\$\w+\s*=\s*['"](?:[A-Za-z0-9+/]{4}){2000,}={0,2}['"]\s*;\s*(?:@?eval|\$\w+\s*\()/, 'hides a large encoded payload it runs'],
];

/** The zip's entries, with yauzl's checks turned into messages a seller can act on. */
async function open(zip: Buffer): Promise<{ file: ZipFile; list: Entry[] }> {
  const file = await openZip(zip).catch(() => {
    throw new PluginZipError('The file is not a zip');
  });
  if (file.entryCount > MAX_ENTRIES) throw new PluginZipError(`The zip has more than ${MAX_ENTRIES} files`);
  const list = await listEntries(file).catch((err: Error) => {
    if (/absolute path|invalid relative path|invalid characters/.test(err.message)) throw new PluginZipError(`The zip has an unsafe path: ${err.message.replace(/^.*?: /, '')}`);
    throw new PluginZipError('The zip is damaged');
  });
  if (list.some((e) => e.isEncrypted())) throw new PluginZipError('The zip is password protected');
  return { file, list };
}

async function unpack(file: ZipFile, entry: Entry): Promise<Buffer> {
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new PluginZipError(`${entry.fileName} uses a compression method WordPress can't unpack`);
  try {
    return await readEntry(file, entry, MAX_UNPACKED);
  } catch {
    throw new PluginZipError(`${entry.fileName} in the zip can't be unpacked`);
  }
}

/** A plugin header field ("Version: 1.2.3"), as WordPress's get_file_data reads it. */
function header(text: string, field: string): string | null {
  const m = new RegExp(`^[ \\t/*#@]*${field}:(.*)$`, 'mi').exec(text);
  const value = m?.[1]!.replace(/\s*(?:\*\/|\?>).*$/, '').trim();
  return value ? value.slice(0, 200) : null;
}

export async function inspectPluginZip(bytes: Uint8Array): Promise<PluginZipInfo> {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { file, list: all } = await open(zip);
  try {
    return await inspect(zip, file, all);
  } finally {
    file.close();
  }
}

async function inspect(zip: Buffer, file: ZipFile, all: Entry[]): Promise<PluginZipInfo> {
  // Folder entries carry no data; the checks below are about files.
  const list = all
    .filter((e) => !e.fileName.endsWith('/'))
    .map((e) => Object.assign(e, { name: e.fileName, size: e.uncompressedSize }))
    .filter((e) => !e.name.startsWith('__MACOSX/') && !/(^|\/)\.DS_Store$/.test(e.name));
  if (!list.length) throw new PluginZipError('The zip is empty');
  const tops = new Set(list.map((e) => e.name.split('/')[0]));
  const [slug] = tops;
  if (tops.size !== 1 || !list.some((e) => e.name.startsWith(`${slug}/`))) {
    throw new PluginZipError('The zip must hold one folder with the plugin in it, as plugin zips from the vendor do');
  }
  if (!PLUGIN_SLUG.test(slug!)) throw new PluginZipError(`The plugin folder "${slug}" must be lowercase letters, digits and dashes`);
  if (list.reduce((sum, e) => sum + e.size, 0) > MAX_UNPACKED) throw new PluginZipError('The plugin is larger than 300 MB unpacked');

  let main: { file: string; text: string } | null = null;
  const topPhp = list.filter((e) => /^[^/]+\/[^/]+\.php$/i.test(e.name)).sort((a, b) => Number(b.name === `${slug}/${slug}.php`) - Number(a.name === `${slug}/${slug}.php`));
  for (const e of topPhp) {
    const text = (await unpack(file, e)).subarray(0, 8192).toString('utf8');
    if (header(text, 'Plugin Name')) {
      main = { file: e.name, text };
      break;
    }
  }
  if (!main) throw new PluginZipError(`No PHP file in ${slug}/ has a "Plugin Name:" header, so WordPress wouldn't see a plugin`);

  for (const e of list) {
    if (!/\.(php|phtml|inc)$/i.test(e.name) || e.size === 0) continue;
    const code = (await unpack(file, e)).toString('latin1');
    for (const [pattern, what] of MALWARE) {
      if (pattern.test(code)) throw new PluginZipError(`${e.name} ${what}. Upload the plugin as the vendor ships it.`);
    }
  }

  return {
    slug: slug!,
    file: main.file,
    name: header(main.text, 'Plugin Name')!,
    version: header(main.text, 'Version'),
    requiresPhp: header(main.text, 'Requires PHP'),
    sha256: createHash('sha256').update(zip).digest('hex'),
    sizeBytes: zip.length,
  };
}

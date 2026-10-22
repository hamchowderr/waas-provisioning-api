// A small zip writer for tests: plugin zips the upload check reads, built in memory.
import { crc32, deflateRawSync } from 'node:zlib';

/** files: path → contents. deflate compresses them as most zips do; stored otherwise. */
export function makeZip(files: Record<string, string | Buffer>, { deflate = true, encrypted = false } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(files)) {
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    const packed = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const fields = (header: Buffer, at: number) => {
      header.writeUInt16LE(encrypted ? 1 : 0, at);
      header.writeUInt16LE(deflate ? 8 : 0, at + 2);
      header.writeUInt32LE(crc32(data), at + 8);
      header.writeUInt32LE(packed.length, at + 12);
      header.writeUInt32LE(data.length, at + 16);
      header.writeUInt16LE(nameBytes.length, at + 20);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    fields(local, 6);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    fields(central, 8);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** A premium plugin as its vendor ships it. */
export const pluginZip = (slug: string, version = '2.9.1', extra: Record<string, string> = {}) =>
  makeZip({
    [`${slug}/`]: '',
    [`${slug}/${slug}.php`]: `<?php\n/**\n * Plugin Name: ${slug.replace(/-/g, ' ')} Pro\n * Version: ${version}\n * Requires PHP: 7.4\n */\nrequire __DIR__ . '/includes/main.php';\n`,
    [`${slug}/includes/main.php`]: '<?php\nfunction pro_main() { return defined("PRO_LICENSE_KEY"); }\n',
    ...extra,
  });

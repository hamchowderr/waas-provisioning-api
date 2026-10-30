import { describe, expect, it } from 'vitest';
import { readZipEntry } from '../src/zipentry.ts';
import { makeZip } from './zip.ts';

function ranged(zip: Uint8Array) {
  const reads: [number, number][] = [];
  const read = async (start: number, end: number) => {
    reads.push([start, end]);
    return Buffer.from(zip.subarray(start, end + 1));
  };
  return { read, reads };
}

describe('readZipEntry', () => {
  const roles = JSON.stringify({ 'website-small': { plugins: ['waas-client/waas-client.php'] } });
  const files = { 'wp-content/plugins/a/a.php': '<?php // a', 'wp-content/plugins/waas-client-data/roles.json': roles, 'wp-content/themes/t/style.css': 'x'.repeat(5000) };

  for (const deflate of [true, false]) {
    it(`reads one file (${deflate ? 'deflated' : 'stored'})`, async () => {
      const zip = makeZip(files, { deflate });
      const { read } = ranged(zip);
      const bytes = await readZipEntry(read, zip.length, 'wp-content/plugins/waas-client-data/roles.json', 1024 * 1024);
      expect(bytes?.toString('utf8')).toBe(roles);
    });
  }

  it('returns null for a file the zip lacks', async () => {
    const zip = makeZip(files);
    expect(await readZipEntry(ranged(zip).read, zip.length, 'wp-content/missing.json', 1024)).toBeNull();
  });

  it('refuses a file larger than the limit', async () => {
    const zip = makeZip(files);
    await expect(readZipEntry(ranged(zip).read, zip.length, 'wp-content/themes/t/style.css', 100)).rejects.toThrow(/larger than/);
  });

  it('refuses what is not a zip', async () => {
    const junk = new Uint8Array(100);
    await expect(readZipEntry(ranged(junk).read, junk.length, 'x', 100)).rejects.toThrow(/Not a zip/);
  });
});

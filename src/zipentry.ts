import { inflateRawSync } from 'node:zlib';

/** Reads bytes start..end (inclusive) of the archive. */
export type ReadRange = (start: number, end: number) => Promise<Buffer>;

/** The end of central directory record plus the longest comment it can have. */
const TAIL = 22 + 65535;

/**
 * One file from a zip read with range requests, without fetching the whole archive: the end record,
 * the central directory, then just that file. Null when the zip has no such file. Zip64 is refused:
 * the archives read here (a version's code) are far below 4 GB.
 */
export async function readZipEntry(read: ReadRange, size: number, name: string, maxBytes: number): Promise<Buffer | null> {
  const tailStart = Math.max(0, size - TAIL);
  const tail = await read(tailStart, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip');
  const count = tail.readUInt16LE(eocd + 10);
  const dirSize = tail.readUInt32LE(eocd + 12);
  const dirAt = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirAt === 0xffffffff || dirSize === 0xffffffff) throw new Error('Zip64 archives are not supported');
  const dir = dirAt >= tailStart ? tail.subarray(dirAt - tailStart, dirAt - tailStart + dirSize) : await read(dirAt, dirAt + dirSize - 1);

  for (let at = 0, n = 0; n < count; n++) {
    if (at + 46 > dir.length || dir.readUInt32LE(at) !== 0x02014b50) throw new Error('The zip is damaged');
    const nameLength = dir.readUInt16LE(at + 28);
    const entryName = dir.toString('utf8', at + 46, at + 46 + nameLength);
    if (entryName === name) {
      const method = dir.readUInt16LE(at + 10);
      const compressedSize = dir.readUInt32LE(at + 20);
      const unpacked = dir.readUInt32LE(at + 24);
      const offset = dir.readUInt32LE(at + 42);
      if (unpacked > maxBytes || compressedSize > maxBytes) throw new Error(`${name} is larger than ${maxBytes} bytes`);
      // The local header's name and extra field lengths can differ from the central directory's.
      const local = await read(offset, offset + 29);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('The zip is damaged');
      const start = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = compressedSize ? await read(start, start + compressedSize - 1) : Buffer.alloc(0);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
      throw new Error(`${name} uses an unsupported compression method`);
    }
    at += 46 + nameLength + dir.readUInt16LE(at + 30) + dir.readUInt16LE(at + 32);
  }
  return null;
}

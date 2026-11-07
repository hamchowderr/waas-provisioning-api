import { Readable } from 'node:stream';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

/**
 * Zip reading for the API, on yauzl: it checks the archive's structure and sizes, refuses names that are
 * absolute or climb out with "..", turns backslashes into slashes and reads Zip64.
 */
export type { Entry, ZipFile };

/** Reads bytes start..end (inclusive) of an archive held somewhere else (a bucket). */
export type ReadRange = (start: number, end: number) => Promise<Buffer>;

class RangeReader extends yauzl.RandomAccessReader {
  constructor(private readonly fetchRange: ReadRange) {
    super();
  }

  // yauzl's end is exclusive.
  override _readStreamForRange(start: number, end: number): Readable {
    const read = this.fetchRange;
    return Readable.from(
      (async function* () {
        if (end > start) yield await read(start, end - 1);
      })(),
    );
  }
}

const options = { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: false };

export const openZip = (bytes: Buffer) => yauzl.fromBufferPromise(bytes, options);

export const openRemoteZip = (read: ReadRange, size: number) => yauzl.fromRandomAccessReaderPromise(new RangeReader(read), size, options);

/** Every entry's metadata (the central directory), in archive order. */
export async function listEntries(zip: ZipFile): Promise<Entry[]> {
  const list: Entry[] = [];
  for await (const entry of zip.eachEntry()) list.push(entry);
  return list;
}

/** One entry's unpacked bytes, refused past `maxBytes` so a zip bomb stops early. */
export async function readEntry(zip: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) throw new Error(`${entry.fileName} is larger than ${maxBytes} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of await zip.openReadStreamPromise(entry)) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new Error(`${entry.fileName} is larger than ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

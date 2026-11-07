import { listEntries, openRemoteZip, readEntry, type ReadRange } from './zip.ts';

export type { ReadRange };

/**
 * One file from a zip read with range requests, without fetching the whole archive: yauzl reads the end
 * record and the central directory, then just that file. Null when the zip has no such file.
 */
export async function readZipEntry(read: ReadRange, size: number, name: string, maxBytes: number): Promise<Buffer | null> {
  const zip = await openRemoteZip(read, size).catch(() => {
    throw new Error('Not a zip');
  });
  try {
    const entry = (await listEntries(zip)).find((e) => e.fileName === name);
    if (!entry) return null;
    if (entry.compressedSize > maxBytes) throw new Error(`${name} is larger than ${maxBytes} bytes`);
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new Error(`${name} uses an unsupported compression method`);
    return await readEntry(zip, entry, maxBytes);
  } finally {
    zip.close();
  }
}

import { describe, expect, it } from 'vitest';
import { hashSecret, verifySecret } from '../src/keys.ts';

describe('secret hashing', () => {
  it('stores a salted scrypt hash, never the secret', async () => {
    const hash = await hashSecret('example-secret');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
    expect(hash).not.toContain('example-secret');
    expect(await hashSecret('example-secret')).not.toBe(hash);
  });

  it('verifies the right secret and rejects others', async () => {
    const hash = await hashSecret('example-secret');
    expect(await verifySecret('example-secret', hash)).toBe(true);
    expect(await verifySecret('example-secreT', hash)).toBe(false);
    expect(await verifySecret('example-secret', 'plain-text')).toBe(false);
  });

  it('remembers a match, so the next check of the same secret skips scrypt, and never remembers a miss', async () => {
    const hash = await hashSecret('busy-secret');
    let started = performance.now();
    expect(await verifySecret('busy-secret', hash)).toBe(true);
    const slow = performance.now() - started;
    started = performance.now();
    expect(await verifySecret('busy-secret', hash)).toBe(true);
    expect(performance.now() - started).toBeLessThan(slow);
    // A different secret against the same hash is still checked in full, and still wrong.
    expect(await verifySecret('busy-secreT', hash)).toBe(false);
    // A new hash (a rotated key) is checked in full too.
    expect(await verifySecret('busy-secret', await hashSecret('other-secret'))).toBe(false);
  });
});

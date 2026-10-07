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
});

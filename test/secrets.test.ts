import { describe, expect, it } from 'vitest';
import { Secrets } from '../src/secrets.ts';
import { TEST_SECRETS_KEY } from './helpers.ts';

describe('Secrets', () => {
  const secrets = new Secrets(TEST_SECRETS_KEY);

  it('round-trips and never repeats a ciphertext', () => {
    const a = secrets.encrypt('example-password');
    expect(a).not.toContain('example-password');
    expect(secrets.encrypt('example-password')).not.toBe(a);
    expect(secrets.decrypt(a)).toBe('example-password');
  });

  it('rejects a tampered value and a short key', () => {
    const [v, iv, tag, ct] = secrets.encrypt('example').split(':');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => secrets.decrypt([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
    expect(() => new Secrets(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});

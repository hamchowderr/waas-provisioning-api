import { describe, expect, it } from 'vitest';
import { callerAddress, recordWrongKey, tooManyWrongKeys } from '../src/keyattempts.ts';

describe('wrong API keys per address', () => {
  it('turns an address away after 20 wrong keys in 10 minutes, then lets it try again', () => {
    const ip = '203.0.113.50';
    const start = 1_000_000;
    for (let i = 0; i < 19; i++) recordWrongKey(ip, start);
    expect(tooManyWrongKeys(ip, start)).toBe(false);
    recordWrongKey(ip, start);
    expect(tooManyWrongKeys(ip, start)).toBe(true);
    expect(tooManyWrongKeys('203.0.113.51', start)).toBe(false);
    expect(tooManyWrongKeys(ip, start + 10 * 60_000 + 1)).toBe(false);
  });

  it('only counts a real address, so calls from inside the server are never turned away', () => {
    expect(callerAddress(undefined)).toBeNull();
    expect(callerAddress('not an ip')).toBeNull();
    expect(callerAddress(' 2001:db8::1 ')).toBe('2001:db8::1');
    recordWrongKey(null);
    expect(tooManyWrongKeys(null)).toBe(false);
  });
});

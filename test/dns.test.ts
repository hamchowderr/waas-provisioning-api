import { describe, expect, it } from 'vitest';
import { dnsSafeLabel, isReservedDomain } from '../src/tenants.ts';

// sslip.io takes trailing -<digits> together with the IP after it (v1-0-0.191.101.15.236.sslip.io
// resolves to 0.191.101.15), so generated labels must not end that way.
describe('dnsSafeLabel', () => {
  it('appends the suffix only to labels ending in -<digits> or made of digits', () => {
    expect(dnsSafeLabel('v1-0-0', 'v')).toBe('v1-0-0-v');
    expect(dnsSafeLabel('live-check-1', 'v')).toBe('live-check-1-v');
    expect(dnsSafeLabel('2026', 'v')).toBe('2026-v');
    expect(dnsSafeLabel('t-00000123', 's')).toBe('t-00000123-s');
    expect(dnsSafeLabel('store-v2-12345678', 'v')).toBe('store-v2-12345678-v');
  });

  it('leaves every other label as it is, so existing domains keep their names', () => {
    for (const label of ['v100', 'v1-0-0-x', 'store-v2', 'v1-1-beta', 't-a046bdb7', 't-1234567a', 'version', 'store-v2-a0b5d79e']) {
      expect(dnsSafeLabel(label, 'v')).toBe(label);
    }
  });
});

describe('isReservedDomain', () => {
  it('reserves the platform domain and reserved labels directly under it', () => {
    expect(isReservedDomain('anypress.io', 'anypress.io')).toBe(true);
    expect(isReservedDomain('www.anypress.io', 'anypress.io')).toBe(true);
    expect(isReservedDomain('stores.anypress.io', 'anypress.io')).toBe(true);
    expect(isReservedDomain('my-shop.anypress.io', 'anypress.io')).toBe(false);
    expect(isReservedDomain('www.example.com', 'anypress.io')).toBe(false);
    expect(isReservedDomain('www.notanypress.io', 'anypress.io')).toBe(false);
  });

  it('reserves nothing when no platform domain is set', () => {
    expect(isReservedDomain('www.anypress.io', undefined)).toBe(false);
  });
});

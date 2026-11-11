// The one price list (src/pricing.ts) that GET /pricing serves to anypress.io and the dashboard.
import { describe, expect, it } from 'vitest';
import { createAjv } from '../src/openapi.ts';
import { PRICE_LIST, siteTypePriceCents } from '../src/pricing.ts';

describe('price list', () => {
  it('matches its contract', () => {
    const validate = createAjv().getSchema('spec#/components/schemas/PriceList')!;
    expect(validate(PRICE_LIST), JSON.stringify(validate.errors)).toBe(true);
  });

  it('prices each size and year from the Small monthly price', () => {
    const community = PRICE_LIST.siteTypes.find((t) => t.key === 'community')!;
    expect(community.monthly).toEqual({ small: 49, medium: 98, large: 196 });
    expect(community.yearly).toEqual({ small: 490, medium: 980, large: 1960 });
    expect(PRICE_LIST.siteTypes.map((t) => t.monthly.small)).toEqual([12, 19, 29, 49, 79]);
  });

  it('gives reseller bills the same prices, in cents', () => {
    expect(siteTypePriceCents('everything', 'large')).toBe(31600);
    expect(siteTypePriceCents('store', 'medium')).toBe(5800);
    expect(siteTypePriceCents('highlevel', 'small')).toBeUndefined();
  });

  it('lists care: three packages with yearly at ten months, and the extra hour for care customers below the plain hour', () => {
    expect(PRICE_LIST.care.packages.map((p) => [p.name, p.monthly, p.yearly])).toEqual([
      ['Care', 79, 790],
      ['Care Plus', 199, 1990],
      ['Care Pro', 449, 4490],
    ]);
    const hour = PRICE_LIST.care.services.find((s) => s.key === 'one-hour')!;
    const extra = PRICE_LIST.care.services.find((s) => s.key === 'extra-hour')!;
    expect([hour.price, hour.careOnly, extra.price, extra.careOnly]).toEqual([125, false, 100, true]);
  });
});

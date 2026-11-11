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
});

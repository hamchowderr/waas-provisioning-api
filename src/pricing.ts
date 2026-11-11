/**
 * AnyPress's one price list. Every price anypress.io, the dashboard and reseller bills show comes from here,
 * served to them at GET /pricing. Change a price here, and nowhere else in this repository; the shop's checkout
 * prices and emails are kept in the shop and must be changed to match.
 */
import type { Size } from './plans.ts';

/** Each site type's Small monthly price in US dollars, in the order the site lists them. */
const SITE_TYPE_PRICES = [
  { key: 'website', name: 'Website', small: 12 },
  { key: 'bookings', name: 'Bookings', small: 19 },
  { key: 'online-store', name: 'Online store', small: 29 },
  { key: 'community', name: 'Community & courses', small: 49 },
  { key: 'everything', name: 'Everything', small: 79 },
] as const;

/** Medium is twice Small and Large four times. */
const SIZE_TIMES: Record<Size, number> = { small: 1, medium: 2, large: 4 };

/** A year costs this many months. */
const YEARLY_MONTHS = 10;

/** Volume savings off every site's price, by how many live sites one customer has. */
const VOLUME_TIERS = [
  { sites: 3, percent: 10 },
  { sites: 10, percent: 20 },
  { sites: 25, percent: 30 },
];

/** What a new reseller pays, as a discount off each site's price (resellers.wholesale_percent's default). */
const WHOLESALE_PERCENT = 40;

/** What an affiliate earns of a customer's first payment. */
const AFFILIATE_PERCENT = 30;

export interface PriceList {
  currency: 'USD';
  siteTypes: { key: string; name: string; monthly: Record<Size, number>; yearly: Record<Size, number> }[];
  sizeTimes: Record<Size, number>;
  yearlyMonths: number;
  volumeTiers: { sites: number; percent: number }[];
  wholesalePercent: number;
  affiliatePercent: number;
}

const bySize = (f: (size: Size) => number) =>
  Object.fromEntries((Object.keys(SIZE_TIMES) as Size[]).map((s) => [s, f(s)])) as Record<Size, number>;

/** The whole price list, in dollars, as GET /pricing serves it. */
export const PRICE_LIST: PriceList = {
  currency: 'USD',
  siteTypes: SITE_TYPE_PRICES.map((t) => ({
    key: t.key,
    name: t.name,
    monthly: bySize((s) => t.small * SIZE_TIMES[s]),
    yearly: bySize((s) => t.small * SIZE_TIMES[s] * YEARLY_MONTHS),
  })),
  sizeTimes: SIZE_TIMES,
  yearlyMonths: YEARLY_MONTHS,
  volumeTiers: VOLUME_TIERS,
  wholesalePercent: WHOLESALE_PERCENT,
  affiliatePercent: AFFILIATE_PERCENT,
};

/**
 * A site type's monthly list price for a size, in US cents, or undefined for a type with no public price
 * (HighLevel). `store` is the older name of `online-store`.
 */
export function siteTypePriceCents(siteType: string, size: Size): number | undefined {
  const key = siteType === 'store' ? 'online-store' : siteType;
  const type = SITE_TYPE_PRICES.find((t) => t.key === key);
  return type ? type.small * SIZE_TIMES[size] * 100 : undefined;
}

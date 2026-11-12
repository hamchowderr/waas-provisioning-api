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

/**
 * Care: monthly packages of changes for one website, and one-time services, sold on the shop by Otaku Solutions.
 * A year of a package costs YEARLY_MONTHS months. `answer` is how soon a request is answered.
 */
const CARE_PACKAGES = [
  { key: 'care', name: 'Care', monthly: 79, minutes: 30, answer: '2 business days', call: false },
  { key: 'care-plus', name: 'Care Plus', monthly: 199, minutes: 120, answer: '1 business day', call: false },
  { key: 'care-pro', name: 'Care Pro', monthly: 449, minutes: 300, answer: 'the same business day', call: true },
] as const;

/** One-time care services. `careOnly`: sold only for a website with a care package (extra time at the care price). */
const CARE_SERVICES = [
  { key: 'set-up-my-site', name: 'Set up my site for me', price: 299, minutes: 0, careOnly: false },
  { key: 'move-my-site-in', name: 'Move my site in for me', price: 199, minutes: 0, careOnly: false },
  { key: 'one-hour', name: 'One hour of changes', price: 125, minutes: 60, careOnly: false },
  { key: 'extra-hour', name: 'Extra hour for care customers', price: 100, minutes: 60, careOnly: true },
] as const;

/** Free days at the start of a new website plan, one trial per person (AnyPress Host checks at checkout). */
const TRIAL_DAYS = 7;

/** Add-ons for one website: extra emails (one-time, never expire) and extra storage (monthly, stackable). */
const PACKS = {
  email: { emails: 10000, price: 5 },
  storage: { gb: 25, monthly: 5 },
};

export interface PriceList {
  currency: 'USD';
  siteTypes: { key: string; name: string; monthly: Record<Size, number>; yearly: Record<Size, number> }[];
  sizeTimes: Record<Size, number>;
  yearlyMonths: number;
  trialDays: number;
  volumeTiers: { sites: number; percent: number }[];
  wholesalePercent: number;
  affiliatePercent: number;
  care: {
    packages: { key: string; name: string; monthly: number; yearly: number; minutes: number; answer: string; call: boolean }[];
    services: { key: string; name: string; price: number; minutes: number; careOnly: boolean }[];
  };
  packs: { email: { emails: number; price: number }; storage: { gb: number; monthly: number } };
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
  trialDays: TRIAL_DAYS,
  volumeTiers: VOLUME_TIERS,
  wholesalePercent: WHOLESALE_PERCENT,
  affiliatePercent: AFFILIATE_PERCENT,
  care: {
    packages: CARE_PACKAGES.map((p) => ({ ...p, yearly: p.monthly * YEARLY_MONTHS })),
    services: CARE_SERVICES.map((s) => ({ ...s })),
  },
  packs: { email: { ...PACKS.email }, storage: { ...PACKS.storage } },
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

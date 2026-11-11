// The nightly price check (src/pricecheck.ts): the shop's checkout prices and pages against the price list.
import { describe, expect, it, vi } from 'vitest';
import { checkShopPrices, dollarAmounts, loadPriceCheckConfig, runPriceCheck } from '../src/pricecheck.ts';
import { PRICE_LIST } from '../src/pricing.ts';

const SIZES = ['small', 'medium', 'large'] as const;

/** A shop whose products match the price list, changed by `edit`. */
function shop(edit: (products: any[]) => void = () => {}, page = '<p>Website from <b>$12</b> a month, $1,960 a year.</p>') {
  const products = PRICE_LIST.siteTypes.flatMap((t) =>
    SIZES.map((s) => ({
      post_name: `${t.key}-${s}`,
      post_title: `${t.name} (${s})`,
      post_excerpt: `${t.name}. $${t.monthly[s]} a month.`,
      variants: [
        { item_price: t.monthly[s] * 100, other_info: { repeat_interval: 'monthly' } },
        { item_price: t.yearly[s] * 100, other_info: { repeat_interval: 'yearly' } },
      ],
    })),
  );
  products.push({ post_name: 'email-pack-10000', post_title: 'Email pack', post_excerpt: '$5', variants: [{ item_price: 500, other_info: null }] } as any);
  edit(products);
  return vi.fn(async (url: string | URL | Request) =>
    String(url).includes('/wp-json/fluent-cart/')
      ? new Response(JSON.stringify({ products: { products: { data: products } } }))
      : new Response(page),
  ) as unknown as typeof fetch;
}

const config = { shopUrl: 'https://shop.example.com', pages: ['/shop/'] };

describe('price check', () => {
  it('passes a shop that matches the list', async () => {
    expect(await checkShopPrices(config, shop())).toEqual([]);
  });

  it('names a checkout price, a description and a page that differ', async () => {
    const fetchFn = shop((products) => {
      const community = products.find((p) => p.post_name === 'community-small');
      community.variants[0].item_price = 3900;
      community.post_excerpt = 'Courses for $39 a month.';
      products.splice(products.findIndex((p) => p.post_name === 'website-large'), 1);
    }, '<p>Community from $39 a month</p>');
    expect(await checkShopPrices(config, fetchFn)).toEqual([
      'Website large: no product "website-large" in the shop',
      'Community & courses (small): the shop charges $39 monthly, the list says $49',
      "Community & courses (small): its description says $39, which isn't its price",
      "https://shop.example.com/shop/ shows $39, which the price list doesn't have",
    ]);
  });

  it('reads dollar amounts with commas and cents', () => {
    expect(dollarAmounts('$1,960 or $49.00, not 12')).toEqual([1960, 49]);
  });

  it('reports a shop it cannot read as a difference', async () => {
    const down = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const log = { log: vi.fn(), error: vi.fn() };
    const problems = await runPriceCheck({ ...config, schedule: '' }, {}, down, log);
    expect(problems).toEqual(["The check couldn't read the shop: the shop's products didn't load (HTTP 503)"]);
    expect(log.error).toHaveBeenCalled();
  });

  it('finds the shop from BRAND_DOMAIN, and turns off', () => {
    expect(loadPriceCheckConfig({}, 'anypress.io')).toEqual({ shopUrl: 'https://shop.anypress.io', pages: ['/shop/'], schedule: '43 3 * * *' });
    expect(loadPriceCheckConfig({ SHOP_URL: 'https://store.example.com/', PRICE_CHECK_PAGES: '/plans/, /pricing/' })?.pages).toEqual(['/plans/', '/pricing/']);
    expect(loadPriceCheckConfig({ PRICE_CHECK: 'off' }, 'anypress.io')).toBeUndefined();
    expect(loadPriceCheckConfig({})).toBeUndefined();
  });
});

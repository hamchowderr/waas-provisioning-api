/**
 * The nightly price check: the shop's checkout prices and plan pages against the one price list
 * (src/pricing.ts). The shop keeps its own copy of every price (FluentCart products and page text), so a
 * price changed in the price list but not in the shop shows up here the next night, and the platform admins
 * get an email listing every difference. Read-only: it reads the shop's public FluentCart products and pages.
 *
 * Set SHOP_URL to the shop (default https://shop.<BRAND_DOMAIN>) and PRICE_CHECK_PAGES to the shop's pages
 * that list prices (default /shop/); PRICE_CHECK=off turns it off.
 */
import type { PgBoss } from 'pg-boss';
import { sendPriceCheckFailed, type AuthMail } from './authmail.ts';
import { PRICE_LIST } from './pricing.ts';
import type { Size } from './plans.ts';

const PRICE_CHECK_QUEUE = 'price-check';

export interface PriceCheckConfig {
  shopUrl: string;
  pages: string[];
  schedule: string;
}

export function loadPriceCheckConfig(env: NodeJS.ProcessEnv, brandDomain?: string): PriceCheckConfig | undefined {
  if (env.PRICE_CHECK?.trim().toLowerCase() === 'off') return undefined;
  const shopUrl = (env.SHOP_URL?.trim() || (brandDomain ? `https://shop.${brandDomain}` : '')).replace(/\/+$/, '');
  if (!shopUrl) return undefined;
  if (!/^https?:\/\//.test(shopUrl)) throw new Error('SHOP_URL must be an http(s) address');
  const pages = (env.PRICE_CHECK_PAGES ?? '/shop/').split(',').map((p) => p.trim()).filter(Boolean);
  return { shopUrl, pages, schedule: env.PRICE_CHECK_SCHEDULE?.trim() || '43 3 * * *' };
}

interface ShopVariant {
  variation_title?: string;
  item_price?: number | string;
  other_info?: { repeat_interval?: string } | null;
}
interface ShopProduct {
  post_name: string;
  post_title: string;
  post_excerpt?: string;
  post_status?: string;
  variants?: ShopVariant[];
}

const SIZES: Size[] = ['small', 'medium', 'large'];

/** Every price the price list has, in whole dollars: what a page may show. */
const listedDollars = () => new Set([0, ...PRICE_LIST.siteTypes.flatMap((t) => SIZES.flatMap((s) => [t.monthly[s], t.yearly[s]]))]);

/** The dollar amounts in a text: "$1,960" and "$49.00" are 1960 and 49. */
export function dollarAmounts(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g)].map((m) => Number(m[1]!.replaceAll(',', '')) + Number(m[2] ?? 0) / 100);
}

const money = (n: number) => `$${Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2)}`;
const stripTags = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&#0?36;|&dollar;/g, '$');

/**
 * Every difference between the shop and the price list, in words. Each plan product (`<site type>-<size>`, as the
 * shop names them) must exist with a monthly and a yearly price equal to the list's, and its short description and
 * each listed page may only show prices the list has. An empty list means the shop matches.
 */
export async function checkShopPrices(config: Pick<PriceCheckConfig, 'shopUrl' | 'pages'>, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const problems: string[] = [];
  const res = await fetchFn(`${config.shopUrl}/wp-json/fluent-cart/v2/public/products?per_page=100`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`the shop's products didn't load (HTTP ${res.status})`);
  const body = (await res.json()) as { products?: { products?: { data?: ShopProduct[] } } };
  const products = new Map((body.products?.products?.data ?? []).map((p) => [p.post_name, p]));
  const allowed = listedDollars();

  for (const type of PRICE_LIST.siteTypes) {
    for (const size of SIZES) {
      const slug = `${type.key}-${size}`;
      const product = products.get(slug);
      if (!product) {
        problems.push(`${type.name} ${size}: no product "${slug}" in the shop`);
        continue;
      }
      for (const [period, want] of [['monthly', type.monthly[size]], ['yearly', type.yearly[size]]] as const) {
        const variant = product.variants?.find((v) => v.other_info?.repeat_interval === period);
        const cents = Number(variant?.item_price);
        if (!variant) problems.push(`${product.post_title}: no ${period} price in the shop (the list says ${money(want)})`);
        else if (cents !== want * 100) problems.push(`${product.post_title}: the shop charges ${money(cents / 100)} ${period}, the list says ${money(want)}`);
      }
      const ownPrices = new Set([0, type.monthly[size], type.yearly[size]]);
      for (const amount of dollarAmounts(product.post_excerpt ?? '')) {
        if (!ownPrices.has(amount)) problems.push(`${product.post_title}: its description says ${money(amount)}, which isn't its price`);
      }
    }
  }

  for (const page of config.pages) {
    const url = new URL(page, `${config.shopUrl}/`).toString();
    const pageRes = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!pageRes.ok) {
      problems.push(`${url} didn't load (HTTP ${pageRes.status})`);
      continue;
    }
    const wrong = [...new Set(dollarAmounts(stripTags(await pageRes.text())).filter((a) => !allowed.has(a)))];
    if (wrong.length) problems.push(`${url} shows ${wrong.map(money).join(', ')}, which the price list doesn't have`);
  }
  return problems;
}

export interface PriceCheckAlerts {
  mail?: AuthMail;
  to?: string[];
}

/** Runs the check on its schedule, emailing the admins when the shop differs or can't be read. */
export async function startPriceCheck(
  boss: PgBoss,
  config: PriceCheckConfig | undefined,
  alerts: PriceCheckAlerts = {},
  { fetchFn = fetch, log = console }: { fetchFn?: typeof fetch; log?: Pick<Console, 'log' | 'error'> } = {},
): Promise<void> {
  if (!config) {
    if (await boss.getQueue(PRICE_CHECK_QUEUE)) await boss.unschedule(PRICE_CHECK_QUEUE);
    return;
  }
  if (!(await boss.getQueue(PRICE_CHECK_QUEUE))) await boss.createQueue(PRICE_CHECK_QUEUE, { retryLimit: 0, deleteAfterSeconds: 7 * 24 * 3600 });
  await boss.schedule(PRICE_CHECK_QUEUE, config.schedule);
  await boss.work(PRICE_CHECK_QUEUE, { pollingIntervalSeconds: 60 }, () => runPriceCheck(config, alerts, fetchFn, log));
}

/** One run: the differences, logged and emailed. Never throws. */
export async function runPriceCheck(
  config: PriceCheckConfig,
  alerts: PriceCheckAlerts,
  fetchFn: typeof fetch = fetch,
  log: Pick<Console, 'log' | 'error'> = console,
): Promise<string[]> {
  let problems: string[];
  try {
    problems = await checkShopPrices(config, fetchFn);
  } catch (err) {
    problems = [`The check couldn't read the shop: ${(err as Error).message}`];
  }
  if (!problems.length) {
    log.log(`price check: ${config.shopUrl} matches the price list`);
    return problems;
  }
  log.error(`price check: ${config.shopUrl} differs from the price list:\n- ${problems.join('\n- ')}`);
  if (alerts.mail) {
    for (const to of alerts.to ?? []) {
      try {
        await sendPriceCheckFailed(alerts.mail, to, { shop: config.shopUrl, problems });
      } catch (err) {
        log.error(`price check: email to ${to} failed: ${(err as Error).message}`);
      }
    }
  }
  return problems;
}

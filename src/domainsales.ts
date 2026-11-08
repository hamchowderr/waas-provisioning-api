// Buying a domain for a store (docs/domains.md). The buyer searches, picks an available name and pays a Stripe invoice;
// once it is paid the domain is registered at the registrar (Name.com, through its official SDK @namecom/core-api), its
// DNS is pointed at the stores (A and AAAA for the domain and www) and it becomes the store's main address. Nothing is
// registered before the invoice is paid, and nothing is charged twice. Renewals are invoiced 30 days before the domain
// expires, charged to the card on file when there is one, and renewed at the registrar once paid. A worker on its own
// queue moves orders along every few minutes.
import { NamecomClient, NamecomEnvironment, NamecomError } from '@namecom/core-api';
import type { PgBoss } from 'pg-boss';
import type { Deps } from './app.ts';
import { withTransaction, type Pool } from './db.ts';
import { defaultNet, storeAddresses, type DomainConnectNet } from './domainconnect.ts';
import { badRequest, conflict, HttpError } from './errors.ts';
import { Stripe, type InvoiceSender } from './stripe.ts';
import { addTenantDomain } from './routes/domains.ts';
import { Status } from './status.ts';
import { domainInUse, normalizeDomain } from './tenants.ts';

export const DOMAIN_SALES_QUEUE = 'domain-sales';

/** Endings sold by default: common, with no extra registry paperwork and no residency rules. */
const DEFAULT_TLDS = ['com', 'net', 'org', 'co', 'io', 'shop', 'store', 'online', 'site', 'biz', 'info', 'app', 'dev', 'xyz'];

/** Days a buyer has to pay a new domain's invoice before the order is let go. */
const PAY_DAYS = 2;
/** Renewals are invoiced this many days before the domain expires. */
const RENEW_DAYS = 30;

export interface Contact {
  firstName: string;
  lastName: string;
  companyName?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  zip: string;
  /** Two-letter country code, US. */
  country: string;
  email: string;
  /** +<country code>.<number>, +1.5555555555. */
  phone: string;
}

export interface DomainOffer {
  domainName: string;
  available: boolean;
  /** What the buyer pays for the first year, in cents (USD). Null when not available. */
  priceCents: number | null;
  /** What each later year costs, in cents (USD). Null when not available. */
  renewalPriceCents: number | null;
  /** Why it can't be bought: taken, premium, ending not sold. */
  reason: string | null;
}

/** The registrar, as domain sales use it; a fake in tests. Prices in cents. */
export interface Registrar {
  search(keyword: string, tlds: string[]): Promise<RegistrarResult[]>;
  check(domains: string[]): Promise<RegistrarResult[]>;
  /** Registers for one year with WHOIS privacy on and the registrar's own auto-renew off. Returns the expiry date. */
  register(domain: string, costCents: number, contact: Contact): Promise<{ expiresAt: string | null }>;
  /** The domain's expiry date when it is in our account already (a retried registration), else null. */
  owned(domain: string): Promise<{ expiresAt: string | null } | null>;
  addRecord(domain: string, record: { type: 'A' | 'AAAA'; host: string; answer: string }): Promise<void>;
  renew(domain: string): Promise<{ expiresAt: string | null }>;
  authCode(domain: string): Promise<string>;
}

export interface RegistrarResult {
  domainName: string;
  purchasable: boolean;
  premium: boolean;
  costCents: number | null;
  renewalCostCents: number | null;
  reason: string | null;
}

export interface DomainSalesConfig {
  registrar: Registrar;
  stripe: InvoiceSender;
  /** Added to the registrar's price for each year, in cents. */
  markupCents: number;
  tlds: string[];
  /**
   * Storefronts without a reseller that may sell domains at their own checkout (the platform's own shop). A reseller's
   * storefronts always may: their domains are on the reseller's monthly bill.
   */
  shopProducts: string[];
}

const cents = (dollars: number | null | undefined) => (typeof dollars === 'number' ? Math.round(dollars * 100) : null);

/** The official Name.com SDK behind the Registrar interface. */
export class NameCom implements Registrar {
  private readonly sdk: NamecomClient;

  constructor(username: string, token: string, sandbox: boolean, fetchFn?: typeof fetch) {
    this.sdk = new NamecomClient({
      username,
      password: token,
      environment: sandbox ? NamecomEnvironment.Sandbox : NamecomEnvironment.Production,
      timeoutInSeconds: 60,
      maxRetries: 2,
      ...(fetchFn ? { fetch: fetchFn } : {}),
    });
  }

  private async call<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof NamecomError) {
        const body = err.body as { message?: string; details?: string } | undefined;
        throw new RegistrarError(err.statusCode ?? 0, `Name.com ${what}: ${body?.message ?? err.message}${body?.details ? ` (${body.details})` : ''}`);
      }
      throw err;
    }
  }

  private static result(r: { domainName: string; purchasable: boolean; premium?: boolean; purchasePrice?: number; renewalPrice?: number; reason?: string }): RegistrarResult {
    return {
      domainName: r.domainName.toLowerCase(),
      purchasable: r.purchasable,
      premium: !!r.premium,
      costCents: cents(r.purchasePrice),
      renewalCostCents: cents(r.renewalPrice),
      reason: r.reason ?? null,
    };
  }

  async search(keyword: string, tlds: string[]) {
    const res = await this.call('search', () => this.sdk.domains.search({ keyword, tldFilter: tlds, timeout: 5000 }));
    return (res.results ?? []).map(NameCom.result);
  }

  async check(domains: string[]) {
    const res = await this.call('check availability', () => this.sdk.domains.checkAvailability({ domainNames: domains }));
    return (res.results ?? []).map(NameCom.result);
  }

  async register(domain: string, costCents: number, contact: Contact) {
    const c = { ...contact, companyName: contact.companyName ?? '', address2: contact.address2 ?? '' };
    const res = await this.call('register', () =>
      this.sdk.domains.createDomain({
        domain: { domainName: domain, privacyEnabled: true, autorenewEnabled: false, contacts: { registrant: c, admin: c, tech: c, billing: c } },
        purchasePrice: costCents / 100,
        purchaseType: 'registration',
        years: 1,
      }),
    );
    return { expiresAt: res.domain?.expireDate ?? null };
  }

  async owned(domain: string) {
    try {
      const d = await this.sdk.domains.getDomain({ domainName: domain });
      return { expiresAt: d.expireDate ?? null };
    } catch (err) {
      if (err instanceof NamecomError && err.statusCode === 404) return null;
      throw err;
    }
  }

  async addRecord(domain: string, record: { type: 'A' | 'AAAA'; host: string; answer: string }) {
    await this.call('add DNS record', () => this.sdk.dns.createRecord({ domainName: domain, host: record.host, type: record.type, answer: record.answer, ttl: 300 }));
  }

  async renew(domain: string) {
    const res = await this.call('renew', () => this.sdk.domains.renewDomain({ domainName: domain, years: 1 }));
    return { expiresAt: res.domain?.expireDate ?? null };
  }

  async authCode(domain: string) {
    const res = await this.call('transfer code', () => this.sdk.domains.getAuthCodeForDomain({ domainName: domain }));
    return (res as { authCode?: string }).authCode ?? '';
  }
}

export class RegistrarError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * On when NAMECOM_USERNAME, a Name.com token and STRIPE_SECRET_KEY are set. NAMECOM_SANDBOX (default on) uses Name.com's
 * test system with NAMECOM_TEST_TOKEN (and NAMECOM_TEST_USERNAME, else the username plus -test): set it to off, with
 * NAMECOM_TOKEN, only for real sales. DOMAIN_MARKUP_CENTS (default 500) is added to each year's price;
 * DOMAIN_TLDS lists the endings sold. DOMAIN_SHOP_PRODUCTS lists storefronts without a reseller (the platform's own shop)
 * that may take payment for domains at their own checkout.
 */
export function loadDomainSalesConfig(env: NodeJS.ProcessEnv, fetchFn?: typeof fetch): DomainSalesConfig | undefined {
  const username = env.NAMECOM_USERNAME?.trim();
  const sandbox = env.NAMECOM_SANDBOX?.trim() !== 'off';
  const token = (sandbox ? env.NAMECOM_TEST_TOKEN || env.NAMECOM_TOKEN : env.NAMECOM_TOKEN)?.trim();
  const stripeKey = env.STRIPE_SECRET_KEY?.trim();
  if (!username || !token || username === 'paste-here' || token === 'paste-here' || !stripeKey) return undefined;
  const markupCents = Number(env.DOMAIN_MARKUP_CENTS ?? 500);
  if (!Number.isInteger(markupCents) || markupCents < 0) throw new Error('DOMAIN_MARKUP_CENTS must be a whole number of cents');
  const tlds = env.DOMAIN_TLDS?.trim() ? env.DOMAIN_TLDS.split(',').map((t) => t.trim().toLowerCase().replace(/^\./, '')).filter(Boolean) : DEFAULT_TLDS;
  // Name.com's test system uses the username with -test appended (NAMECOM_TEST_USERNAME, when set).
  const testUser = env.NAMECOM_TEST_USERNAME?.trim();
  const login = !sandbox ? username : testUser && testUser !== 'paste-here' ? testUser : username.endsWith('-test') ? username : `${username}-test`;
  const shopProducts = (env.DOMAIN_SHOP_PRODUCTS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  return { registrar: new NameCom(login, token, sandbox, fetchFn), stripe: new Stripe(stripeKey, fetchFn), markupCents, tlds, shopProducts };
}

function salesOf(deps: Deps): DomainSalesConfig {
  if (!deps.domainSales) throw new HttpError(503, 'Buying domains is not set up on this server yet');
  return deps.domainSales;
}

const tldOf = (domain: string) => domain.slice(domain.indexOf('.') + 1);

function offer(config: DomainSalesConfig, r: RegistrarResult, inUse: boolean): DomainOffer {
  const sold = config.tlds.includes(tldOf(r.domainName));
  const reason = !sold
    ? `Domains ending in .${tldOf(r.domainName)} are not sold here`
    : r.premium
      ? 'This is a premium domain with a special price; it is not sold here'
      : inUse || !r.purchasable || r.costCents === null
        ? 'This domain is taken'
        : null;
  return {
    domainName: r.domainName,
    available: reason === null,
    priceCents: reason === null ? r.costCents! + config.markupCents : null,
    renewalPriceCents: reason === null ? (r.renewalCostCents ?? r.costCents!) + config.markupCents : null,
    reason,
  };
}

/**
 * Names to buy for a keyword or an exact domain: an exact name (with a dot) is checked live, a keyword gets
 * suggestions across the endings sold. Prices include the markup.
 */
export async function searchDomains(deps: Deps, query: string): Promise<DomainOffer[]> {
  const config = salesOf(deps);
  const q = query.trim().toLowerCase();
  if (!q || q.length > 63) throw badRequest('Send a name to search for (query)');
  let results: RegistrarResult[];
  if (q.includes('.')) {
    results = await config.registrar.check([normalizeDomain(q)]);
  } else {
    const keyword = q.replace(/[^a-z0-9-]/g, '');
    if (!keyword) throw badRequest('Send a name to search for (query)');
    const found = await config.registrar.search(keyword, config.tlds);
    // Search reads cached data, so a live check confirms the names shown as available.
    const purchasable = found.filter((r) => r.purchasable && !r.premium).map((r) => r.domainName).slice(0, 20);
    const live = purchasable.length ? await config.registrar.check(purchasable) : [];
    results = [...live, ...found.filter((r) => !purchasable.includes(r.domainName))];
  }
  const offers: DomainOffer[] = [];
  for (const r of results) offers.push(offer(config, r, await domainInUse(deps.pool, r.domainName, deps.config.platformDomain, deps.config.brandDomain)));
  return offers.sort((a, b) => Number(b.available) - Number(a.available));
}

export interface BoughtDomain {
  id: string;
  tenantId: string | null;
  domainName: string;
  status: 'awaiting_payment' | 'registering' | 'active' | 'cancelled' | 'failed' | 'expired';
  /** invoice: the buyer pays our Stripe invoices. storefront: the shop took the payment and renews it with its own orders. */
  paidBy: 'invoice' | 'storefront';
  /** The shop's order, for a domain paid for at a storefront. */
  reference: string | null;
  priceCents: number;
  renewalPriceCents: number;
  /** Where the buyer pays: the Stripe invoice page while the order waits for payment, else null. */
  payUrl: string | null;
  autoRenew: boolean;
  /** The renewal invoice to pay, while one is open. */
  renewalPayUrl: string | null;
  expiresAt: string | null;
  error: string | null;
  dateCreated: string;
}

const toBought = (r: Record<string, any>): BoughtDomain => ({
  id: r.id,
  tenantId: r.tenant_id ?? null,
  domainName: r.domain_name,
  status: r.status,
  paidBy: r.paid_by ?? 'invoice',
  reference: r.reference ?? null,
  priceCents: r.price_cents,
  renewalPriceCents: r.renewal_price_cents,
  payUrl: r.status === 'awaiting_payment' ? (r.hosted_invoice_url ?? null) : null,
  autoRenew: r.auto_renew,
  renewalPayUrl: r.renewal_invoice_id ? (r.renewal_invoice_url ?? null) : null,
  expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
  error: r.error ?? null,
  dateCreated: new Date(r.date_created).toISOString(),
});

const PHONE = /^\+\d{1,3}\.\d{4,14}$/;

/** Checks a registrant contact; every field the registries need is there. */
export function parseContact(input: unknown): Contact {
  const c = (input ?? {}) as Record<string, unknown>;
  const text = (name: string, required = true, max = 200) => {
    const v = c[name];
    if (v === undefined || v === null || v === '') {
      if (required) throw badRequest(`contact.${name} is required`);
      return undefined;
    }
    if (typeof v !== 'string' || v.trim().length > max) throw badRequest(`contact.${name} must be text of at most ${max} characters`);
    return v.trim();
  };
  const contact: Contact = {
    firstName: text('firstName')!,
    lastName: text('lastName')!,
    companyName: text('companyName', false),
    address1: text('address1')!,
    address2: text('address2', false),
    city: text('city')!,
    state: text('state')!,
    zip: text('zip', true, 20)!,
    country: text('country', true, 2)!.toUpperCase(),
    email: text('email')!.toLowerCase(),
    phone: text('phone', true, 20)!,
  };
  if (!/^[A-Z]{2}$/.test(contact.country)) throw badRequest('contact.country must be a two-letter country code, such as US');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email)) throw badRequest('contact.email must be an email address');
  if (!PHONE.test(contact.phone)) throw badRequest('contact.phone must look like +1.5555555555 (country code, a dot, then the number)');
  return contact;
}

export interface PaidAtStorefront {
  /** The shop's order. A repeat with the same reference answers the domain already bought and registers nothing. */
  reference: string;
}

/** Wakes the worker so a domain paid for at a storefront is registered now, not at the next 5-minute pass. */
async function wakeWorker(deps: Deps) {
  try {
    await deps.boss.send(DOMAIN_SALES_QUEUE, {});
  } catch {
    // The 5-minute pass registers it.
  }
}

/** Whether a storefront may take the payment for domains itself: a reseller's storefront, or one listed as a shop. */
async function maySellAtStorefront(deps: Deps, config: DomainSalesConfig, productId: string): Promise<boolean> {
  if (config.shopProducts.includes(productId)) return true;
  const { rows } = await deps.pool.query<{ reseller_id: string | null }>('SELECT reseller_id FROM products WHERE id = $1', [productId]);
  return !!rows[0]?.reseller_id;
}

/**
 * Orders a domain for a store: confirms it is available at a normal price, holds the name, and sends the buyer a
 * Stripe invoice. Registration happens once it is paid (processDomainSales). With `paid`, the storefront has already
 * taken the payment at its own checkout: no invoice is sent and the domain is registered straight away. A reseller's
 * storefront then pays for it on its monthly bill.
 */
export async function buyDomain(
  deps: Deps,
  tenant: { id: string; product_id: string },
  domainName: string,
  contactInput: unknown,
  paid?: PaidAtStorefront,
): Promise<BoughtDomain> {
  const config = salesOf(deps);
  const domain = normalizeDomain(domainName);
  if (paid) {
    const reference = paid.reference.trim();
    if (!reference || reference.length > 200) throw badRequest('reference must be the shop order, at most 200 characters');
    paid = { reference };
    const { rows: earlier } = await deps.pool.query('SELECT * FROM bought_domains WHERE product_id = $1 AND reference = $2', [tenant.product_id, reference]);
    if (earlier[0]) {
      if (earlier[0].domain_name !== domain || earlier[0].tenant_id !== tenant.id) throw conflict(`The order ${reference} already bought ${earlier[0].domain_name}`);
      return toBought(earlier[0]);
    }
    if (!(await maySellAtStorefront(deps, config, tenant.product_id))) throw new HttpError(403, 'This storefront does not take payment for domains itself; buy without a reference to get an invoice');
  }
  const contact = parseContact(contactInput);
  if (await domainInUse(deps.pool, domain, deps.config.platformDomain, deps.config.brandDomain)) throw conflict(`${domain} is already in use on this platform`);
  const [result] = await config.registrar.check([domain]);
  const o = offer(config, result ?? { domainName: domain, purchasable: false, premium: false, costCents: null, renewalCostCents: null, reason: null }, false);
  if (!o.available) throw conflict(`${domain} can't be bought: ${o.reason}`);

  let row: Record<string, any>;
  try {
    row = await withTransaction(deps.pool, async (client) => {
      const made = (await client.query(
        `INSERT INTO bought_domains (product_id, tenant_id, domain_name, status, cost_cents, price_cents, renewal_cost_cents, renewal_price_cents, contact, paid_by, reference)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [
          tenant.product_id,
          tenant.id,
          domain,
          paid ? 'registering' : 'awaiting_payment',
          result!.costCents,
          o.priceCents,
          result!.renewalCostCents ?? result!.costCents,
          o.renewalPriceCents,
          JSON.stringify(contact),
          paid ? 'storefront' : 'invoice',
          paid?.reference ?? null,
        ],
      )).rows[0]!;
      if (paid) {
        await client.query("INSERT INTO bought_domain_charges (bought_domain_id, product_id, kind, amount_cents, reference) VALUES ($1, $2, 'registration', $3, $4)", [
          made.id,
          tenant.product_id,
          o.priceCents,
          paid.reference,
        ]);
      }
      return made;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict(`${domain} is already being bought`);
    throw err;
  }
  if (paid) {
    await wakeWorker(deps);
    return toBought(row);
  }

  try {
    const customer = await config.stripe.createCustomer({
      email: contact.email,
      name: `${contact.firstName} ${contact.lastName}`,
      metadata: { boughtDomainId: row.id, domain },
      idempotencyKey: `domain:${row.id}:customer`,
    });
    const invoice = await config.stripe.sendInvoice(
      {
        customer,
        chargeAutomatically: false,
        daysUntilDue: PAY_DAYS,
        description: `The domain ${domain} for one year. It is registered as soon as this invoice is paid.`,
        metadata: { boughtDomainId: row.id, domain, kind: 'domain' },
        lines: [{ amountCents: o.priceCents!, description: `${domain}, 1 year` }],
        idempotencyKey: `domain:${row.id}`,
      },
      async (invoiceId) => {
        await deps.pool.query('UPDATE bought_domains SET stripe_customer_id = $2, stripe_invoice_id = $3, date_updated = now() WHERE id = $1', [row.id, customer, invoiceId]);
      },
    );
    row = (await deps.pool.query('UPDATE bought_domains SET stripe_customer_id = $2, stripe_invoice_id = $3, hosted_invoice_url = $4, date_updated = now() WHERE id = $1 RETURNING *', [
      row.id,
      customer,
      invoice.id,
      invoice.hostedInvoiceUrl,
    ])).rows[0]!;
  } catch (err) {
    await deps.pool.query("UPDATE bought_domains SET status = 'cancelled', error = $2, date_updated = now() WHERE id = $1", [row.id, 'The invoice could not be made']);
    console.error(`domain ${domain}: the invoice could not be made:`, err);
    throw new HttpError(502, 'The invoice for this domain could not be made; try again in a minute');
  }
  return toBought(row);
}

export async function listBoughtDomains(pool: Pool, tenantId: string): Promise<BoughtDomain[]> {
  const { rows } = await pool.query('SELECT * FROM bought_domains WHERE tenant_id = $1 ORDER BY date_created DESC', [tenantId]);
  return rows.map(toBought);
}

async function activeDomain(pool: Pool, tenantId: string, domainName: string) {
  const domain = normalizeDomain(domainName);
  const { rows } = await pool.query("SELECT * FROM bought_domains WHERE tenant_id = $1 AND domain_name = $2 AND status = 'active'", [tenantId, domain]);
  if (!rows[0]) throw badRequest(`${domain} is not a domain bought for this store`);
  return rows[0];
}

/** Turns renewal on or off. Off: the domain expires at the end of its year unless it is moved to another registrar. */
export async function setAutoRenew(deps: Deps, tenantId: string, domainName: string, autoRenew: boolean): Promise<BoughtDomain> {
  const row = await activeDomain(deps.pool, tenantId, domainName);
  if (row.paid_by === 'storefront') throw badRequest(`${row.domain_name} renews with its subscription at the shop; cancel it there to stop renewing`);
  const { rows } = await deps.pool.query('UPDATE bought_domains SET auto_renew = $2, date_updated = now() WHERE id = $1 RETURNING *', [row.id, autoRenew]);
  return toBought(rows[0]);
}

/**
 * Renews a domain paid for at a storefront, once the shop has taken the renewal payment (its subscription renewed).
 * `reference` is the renewal order: a repeat renews nothing more. Answers the domain with its new expiry date.
 */
export async function renewAtStorefront(deps: Deps, tenantId: string, domainName: string, reference: string): Promise<BoughtDomain> {
  const config = salesOf(deps);
  const ref = reference.trim();
  if (!ref || ref.length > 200) throw badRequest('reference must be the shop order, at most 200 characters');
  const domain = normalizeDomain(domainName);
  const { rows } = await deps.pool.query("SELECT * FROM bought_domains WHERE tenant_id = $1 AND domain_name = $2 AND status IN ('active', 'expired') ORDER BY date_created DESC LIMIT 1", [
    tenantId,
    domain,
  ]);
  const row = rows[0];
  if (!row) throw badRequest(`${domain} is not a domain bought for this store`);
  if (row.paid_by !== 'storefront') throw badRequest(`${domain} is renewed by its own invoice, not at the storefront`);
  // Held for the whole renewal, so a repeat racing the first waits for it and then finds its charge.
  return withTransaction(deps.pool, async (client) => {
    await client.query('SELECT id FROM bought_domains WHERE id = $1 FOR UPDATE', [row.id]);
    const { rows: done } = await client.query('SELECT 1 FROM bought_domain_charges WHERE bought_domain_id = $1 AND reference = $2', [row.id, ref]);
    if (!done[0]) {
      const renewed = await config.registrar.renew(domain);
      const base = row.expires_at ? new Date(row.expires_at).getTime() : Date.now();
      const next = renewed.expiresAt ?? new Date(base + 365 * 86400_000).toISOString();
      await client.query("UPDATE bought_domains SET status = 'active', expires_at = $2, error = NULL, date_updated = now() WHERE id = $1", [row.id, next]);
      await client.query("INSERT INTO bought_domain_charges (bought_domain_id, product_id, kind, amount_cents, reference) VALUES ($1, $2, 'renewal', $3, $4)", [
        row.id,
        row.product_id,
        row.renewal_price_cents,
        ref,
      ]);
    }
    return toBought((await client.query('SELECT * FROM bought_domains WHERE id = $1', [row.id])).rows[0]);
  });
}

/** The code that moves the domain to another registrar: the owner can always take it with them. */
export async function transferCode(deps: Deps, tenantId: string, domainName: string): Promise<{ domainName: string; authCode: string }> {
  const config = salesOf(deps);
  const row = await activeDomain(deps.pool, tenantId, domainName);
  return { domainName: row.domain_name, authCode: await config.registrar.authCode(row.domain_name) };
}

/** What the worker needs; tests pass the same. */
export interface DomainSalesWork {
  pool: Pool;
  config: DomainSalesConfig;
  storesDomain: string;
  ipv6?: string;
  net?: DomainConnectNet;
  /** Adds the domain to the store as its main address (addTenantDomain). */
  attach(tenantId: string, domain: string, main: boolean): Promise<void>;
  now?: () => Date;
  log?: Pick<Console, 'error'>;
}

async function setStatus(pool: Pool, id: string, status: string, fields: Record<string, unknown> = {}) {
  const keys = Object.keys(fields);
  await pool.query(
    `UPDATE bought_domains SET status = $2, date_updated = now()${keys.map((k, i) => `, ${k} = $${i + 3}`).join('')} WHERE id = $1`,
    [id, status, ...keys.map((k) => fields[k])],
  );
}

/** Registers a paid domain, points it at the stores and makes it the store's main address. */
async function register(work: DomainSalesWork, row: Record<string, any>) {
  const { pool, config } = work;
  const domain: string = row.domain_name;
  if (row.status !== 'registering') {
    await setStatus(pool, row.id, 'registering');
  }
  // A retry after a stop mid-way: the domain may be ours already.
  let registered = await config.registrar.owned(domain);
  if (!registered) {
    const [live] = await config.registrar.check([domain]);
    if (!live?.purchasable || live.premium || live.costCents === null || live.costCents > row.cost_cents) {
      const why = !live?.purchasable ? 'it was taken before the payment came in' : 'its price went up at the registrar';
      const refund = row.paid_by === 'storefront' ? `Refund the shop order ${row.reference}` : 'Refund the invoice';
      await setStatus(pool, row.id, 'failed', { error: `Paid, but ${domain} could not be registered: ${why}. ${refund}.` });
      // Nothing is owed for a domain that was never registered.
      await pool.query("DELETE FROM bought_domain_charges WHERE bought_domain_id = $1 AND kind = 'registration'", [row.id]);
      work.log?.error(`domain ${domain} (${row.id}): paid but not registered: ${why}; ${refund.toLowerCase()} ${row.stripe_invoice_id ?? ''}`.trim());
      return;
    }
    registered = await config.registrar.register(domain, live.costCents, row.contact as Contact);
  }
  const { ip, ipv6 } = await storeAddresses(work.storesDomain, work.net ?? defaultNet, work.ipv6);
  for (const host of ['', 'www']) {
    await config.registrar.addRecord(domain, { type: 'A', host, answer: ip });
    if (ipv6) await config.registrar.addRecord(domain, { type: 'AAAA', host, answer: ipv6 });
  }
  await setStatus(pool, row.id, 'active', { expires_at: registered.expiresAt, error: null });
  if (row.tenant_id) {
    await work.attach(row.tenant_id, domain, true);
    await work.attach(row.tenant_id, `www.${domain}`, false);
  }
}

/**
 * One pass of the worker: registers paid orders, lets unpaid ones go, sends renewal invoices and renews paid ones.
 * Each order is handled on its own, so one failure doesn't hold up the rest.
 */
export async function processDomainSales(work: DomainSalesWork): Promise<void> {
  const { pool, config } = work;
  const now = work.now?.() ?? new Date();
  const log = work.log ?? console;

  const { rows: open } = await pool.query("SELECT * FROM bought_domains WHERE status IN ('awaiting_payment', 'registering') ORDER BY date_created");
  for (const row of open) {
    try {
      if (row.status === 'registering') {
        await register(work, row);
        continue;
      }
      if (!row.stripe_invoice_id) continue;
      const invoice = await config.stripe.getInvoice(row.stripe_invoice_id);
      if (invoice.status === 'paid') await register(work, row);
      else if (invoice.status === 'void' || invoice.status === 'uncollectible') await setStatus(pool, row.id, 'cancelled', { error: 'The invoice was not paid' });
    } catch (err) {
      log.error(`domain ${row.domain_name} (${row.id}):`, err);
      await pool.query('UPDATE bought_domains SET error = $2, date_updated = now() WHERE id = $1', [row.id, err instanceof Error ? err.message : String(err)]);
    }
  }

  // Renewals: invoice those expiring within RENEW_DAYS, renew those whose invoice is paid.
  const soon = new Date(now.getTime() + RENEW_DAYS * 86400_000);
  const { rows: due } = await pool.query("SELECT * FROM bought_domains WHERE status = 'active' AND paid_by = 'invoice' AND auto_renew AND expires_at IS NOT NULL AND (expires_at < $1 OR renewal_invoice_id IS NOT NULL)", [soon]);
  for (const row of due) {
    try {
      if (!row.renewal_invoice_id) {
        const expires = new Date(row.expires_at).toISOString().slice(0, 10);
        const card = row.stripe_customer_id ? await config.stripe.hasCardOnFile(row.stripe_customer_id) : false;
        const invoice = await config.stripe.sendInvoice(
          {
            customer: row.stripe_customer_id,
            chargeAutomatically: card,
            daysUntilDue: 14,
            description: `Renewal of ${row.domain_name} for one more year (it expires on ${expires}).`,
            metadata: { boughtDomainId: row.id, domain: row.domain_name, kind: 'domain-renewal', expires },
            lines: [{ amountCents: row.renewal_price_cents, description: `${row.domain_name}, 1 more year` }],
            idempotencyKey: `domain:${row.id}:renew:${expires}`,
          },
          async (invoiceId) => {
            await pool.query('UPDATE bought_domains SET renewal_invoice_id = $2, date_updated = now() WHERE id = $1', [row.id, invoiceId]);
          },
        );
        await pool.query('UPDATE bought_domains SET renewal_invoice_id = $2, renewal_invoice_url = $3, date_updated = now() WHERE id = $1', [row.id, invoice.id, invoice.hostedInvoiceUrl]);
        continue;
      }
      const invoice = await config.stripe.getInvoice(row.renewal_invoice_id);
      if (invoice.status === 'paid') {
        const renewed = await config.registrar.renew(row.domain_name);
        const next = renewed.expiresAt ?? new Date(new Date(row.expires_at).getTime() + 365 * 86400_000).toISOString();
        await pool.query('UPDATE bought_domains SET expires_at = $2, renewal_invoice_id = NULL, renewal_invoice_url = NULL, error = NULL, date_updated = now() WHERE id = $1', [row.id, next]);
      } else if (invoice.status === 'void' || invoice.status === 'uncollectible') {
        await pool.query("UPDATE bought_domains SET auto_renew = false, renewal_invoice_id = NULL, renewal_invoice_url = NULL, error = 'The renewal invoice was not paid', date_updated = now() WHERE id = $1", [row.id]);
      }
    } catch (err) {
      log.error(`domain renewal ${row.domain_name} (${row.id}):`, err);
      await pool.query('UPDATE bought_domains SET error = $2, date_updated = now() WHERE id = $1', [row.id, err instanceof Error ? err.message : String(err)]);
    }
  }

  // Domains past their expiry date without a renewal stop counting as active.
  await pool.query("UPDATE bought_domains SET status = 'expired', date_updated = now() WHERE status = 'active' AND expires_at < $1 AND renewal_invoice_id IS NULL", [now]);
}

/** Runs processDomainSales every 5 minutes while buying domains is set up. */
export async function startDomainSales(boss: PgBoss, work: Omit<DomainSalesWork, 'config'> & { config?: DomainSalesConfig }): Promise<void> {
  const { config } = work;
  if (!config) {
    if (await boss.getQueue(DOMAIN_SALES_QUEUE)) await boss.unschedule(DOMAIN_SALES_QUEUE);
    return;
  }
  if (!(await boss.getQueue(DOMAIN_SALES_QUEUE))) await boss.createQueue(DOMAIN_SALES_QUEUE, { retryLimit: 0, expireInSeconds: 1800 });
  await boss.schedule(DOMAIN_SALES_QUEUE, '*/5 * * * *');
  await boss.work(DOMAIN_SALES_QUEUE, { pollingIntervalSeconds: 60 }, () => processDomainSales({ ...work, config }));
}

/** Adds a bought domain to its store (main address, or an extra one for www), unless the store is going or failed. */
export function storeAttacher(deps: Deps): DomainSalesWork['attach'] {
  return async (tenantId, domain, main) => {
    const { rows } = await deps.pool.query('SELECT id, product_id, external_id, status FROM tenants WHERE id = $1', [tenantId]);
    const tenant = rows[0];
    if (!tenant || tenant.status === Status.Removing || tenant.status === Status.Failed) return;
    await addTenantDomain(deps, tenant, domain, main);
  };
}

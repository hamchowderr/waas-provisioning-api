// Buying a domain for a store (src/domainsales.ts, docs/domains.md): search, order, the Stripe invoice, registration
// once it is paid, DNS, the store's new main address, renewals and the transfer code. Name.com and Stripe are fakes.
// Responses are checked against openapi/waas-provisioning-api.yaml.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDomainSalesConfig, parseContact, processDomainSales, storeAttacher, type DomainSalesConfig, type DomainSalesWork, type Registrar, type RegistrarResult } from '../src/domainsales.ts';
import { createAjv, spec } from '../src/openapi.ts';
import { Status } from '../src/status.ts';
import type { InvoiceSender, NewInvoice, StripeInvoice } from '../src/stripe.ts';
import { setup, waitFor, type TestContext, OWNER } from './helpers.ts';

const ajv = createAjv();
const valid = (operationId: string, body: unknown) => {
  for (const item of Object.values(spec.paths as Record<string, Record<string, any>>)) {
    for (const op of Object.values(item)) {
      if (op?.operationId !== operationId) continue;
      const schema = JSON.parse(JSON.stringify(op.responses['200'].content['application/json'].schema).replaceAll('"#/components', '"spec#/components'));
      const validate = ajv.compile(schema);
      expect(validate(body), ajv.errorsText(validate.errors)).toBe(true);
      return;
    }
  }
  throw new Error(operationId);
};

const CONTACT = {
  firstName: 'Ada',
  lastName: 'Baker',
  address1: '1 Main St',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  country: 'us',
  email: 'Ada@Example.com',
  phone: '+1.5125550100',
};

/** A registrar with a few names: taken.com is taken, gold.com premium, the rest $10 a year. */
class FakeRegistrar implements Registrar {
  owned_ = new Map<string, string>();
  records: string[] = [];
  registered: Array<{ domain: string; costCents: number; email: string }> = [];
  renewed: string[] = [];
  takenLater = new Set<string>();

  private result(domainName: string): RegistrarResult {
    const taken = domainName === 'taken.com' || this.takenLater.has(domainName) || this.owned_.has(domainName);
    const premium = domainName === 'gold.com';
    return { domainName, purchasable: !taken, premium, costCents: taken ? null : premium ? 250_000 : 1000, renewalCostCents: taken ? null : 1200, reason: taken ? 'unavailable' : null };
  }
  async search(keyword: string, tlds: string[]) {
    return tlds.slice(0, 3).map((tld) => this.result(`${keyword}.${tld}`)).concat(this.result('taken.com'));
  }
  async check(domains: string[]) {
    return domains.map((d) => this.result(d));
  }
  async register(domain: string, costCents: number, contact: { email: string }) {
    this.registered.push({ domain, costCents, email: contact.email });
    this.owned_.set(domain, '2027-11-08T00:00:00Z');
    return { expiresAt: '2027-11-08T00:00:00Z' };
  }
  async owned(domain: string) {
    const expiresAt = this.owned_.get(domain);
    return expiresAt ? { expiresAt } : null;
  }
  async addRecord(domain: string, r: { type: string; host: string; answer: string }) {
    this.records.push(`${domain} ${r.type} ${r.host || '@'} ${r.answer}`);
  }
  async renew(domain: string) {
    this.renewed.push(domain);
    return { expiresAt: '2028-11-08T00:00:00Z' };
  }
  async authCode() {
    return 'EPP-CODE-1';
  }
}

class FakeStripe implements InvoiceSender {
  invoices = new Map<string, StripeInvoice & { input: NewInvoice }>();
  card = false;
  async createCustomer({ idempotencyKey }: { idempotencyKey: string }) {
    return `cus_${idempotencyKey.split(':')[1]!.slice(0, 8)}`;
  }
  async hasCardOnFile() {
    return this.card;
  }
  async sendInvoice(input: NewInvoice, onDraft: (id: string) => Promise<void>) {
    const id = `in_${this.invoices.size + 1}`;
    await onDraft(id);
    const invoice = { id, status: 'open' as const, hostedInvoiceUrl: `https://invoice.stripe.example/${id}`, input };
    this.invoices.set(id, invoice);
    return invoice;
  }
  async getInvoice(id: string) {
    return this.invoices.get(id)!;
  }
  async deleteDraft() {}
  pay(id: string, status: StripeInvoice['status'] = 'paid') {
    this.invoices.get(id)!.status = status;
  }
}

let t: TestContext;
let registrar: FakeRegistrar;
let stripe: FakeStripe;
let work: DomainSalesWork;
let store: { id: string; externalId: string };
const net = {
  resolve4: async (name: string) => (name === 'www.stores.waas.example' ? ['203.0.113.7'] : []),
  resolve6: async (name: string) => (name === 'www.stores.waas.example' ? ['2001:db8::7'] : []),
  resolveTxt: async () => [],
  resolveNs: async () => [],
  fetch: (async () => new Response('', { status: 404 })) as typeof fetch,
};

async function newTenant(name: string) {
  const body = (await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name } })).json()) as { id: string; externalId: string };
  await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${body.externalId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  return body;
}

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  store = await newTenant('Bakery');
});
afterAll(async () => {
  await t.close();
});

describe('domain sales', () => {
  it('is off without Name.com and Stripe, and with the Infisical placeholders', async () => {
    expect((await t.call('GET', '/v1/tenants/domains/search?query=mybakery')).status).toBe(503);
    expect(loadDomainSalesConfig({ NAMECOM_USERNAME: 'paste-here', NAMECOM_TOKEN: 'paste-here', STRIPE_SECRET_KEY: 'rk_test_x' })).toBeUndefined();
    expect(loadDomainSalesConfig({ NAMECOM_USERNAME: 'anypress', NAMECOM_TEST_TOKEN: 'tok' })).toBeUndefined();
    const on = loadDomainSalesConfig({ NAMECOM_USERNAME: 'anypress', NAMECOM_TEST_TOKEN: 'tok', STRIPE_SECRET_KEY: 'rk_test_x' })!;
    expect(on.markupCents).toBe(500);
    expect(on.tlds).toContain('com');
    expect(on.shopProducts).toEqual([]);
    expect(loadDomainSalesConfig({ NAMECOM_USERNAME: 'a', NAMECOM_TOKEN: 't', STRIPE_SECRET_KEY: 'rk_test_x', DOMAIN_SHOP_PRODUCTS: ' p1, p2 ' })!.shopProducts).toEqual(['p1', 'p2']);
    expect(() => loadDomainSalesConfig({ NAMECOM_USERNAME: 'a', NAMECOM_TOKEN: 't', STRIPE_SECRET_KEY: 'rk_test_x', DOMAIN_MARKUP_CENTS: '1.5' })).toThrow();

    registrar = new FakeRegistrar();
    stripe = new FakeStripe();
    const config: DomainSalesConfig = { registrar, stripe, markupCents: 500, tlds: ['com', 'net', 'shop'], shopProducts: [] };
    t.deps.domainSales = config;
    t.deps.domainConnectNet = net;
    work = { pool: t.pool, config, storesDomain: 'stores.waas.example', net, attach: storeAttacher(t.deps), log: { error: () => {} } };
  });

  it('searches with prices that include the markup, and says why a name cannot be bought', async () => {
    const res = await t.call('GET', '/v1/tenants/domains/search?query=mybakery');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: any[] };
    valid('searchDomainsToBuy', body);
    expect(body.results[0]).toEqual({ domainName: 'mybakery.com', available: true, priceCents: 1500, renewalPriceCents: 1700, reason: null });
    expect(body.results.find((r) => r.domainName === 'taken.com')).toMatchObject({ available: false, reason: 'This domain is taken' });

    const exact = async (q: string) => ((await (await t.call('GET', `/v1/tenants/domains/search?query=${q}`)).json()) as { results: any[] }).results[0];
    expect(await exact('gold.com')).toMatchObject({ available: false, priceCents: null });
    expect((await exact('mybakery.io')).reason).toMatch(/\.io are not sold/);
    expect((await t.call('GET', '/v1/tenants/domains/search?query=')).status).toBe(400);
  });

  it('checks the contact the domain is registered to', () => {
    expect(parseContact(CONTACT)).toMatchObject({ country: 'US', email: 'ada@example.com', phone: '+15125550100' });
    // Name.com only takes +<country code><number>, so the usual ways of writing a number are tidied first.
    expect(parseContact({ ...CONTACT, phone: '+1 (512) 555-0100' }).phone).toBe('+15125550100');
    expect(() => parseContact({ ...CONTACT, phone: '512-555-0100' })).toThrow(/phone/);
    expect(() => parseContact({ ...CONTACT, country: 'USA' })).toThrow(/country/);
    expect(() => parseContact({ ...CONTACT, city: undefined })).toThrow(/city/);
  });

  it('sends an invoice, registers once it is paid, points the DNS and makes it the main address', async () => {
    const buy = (domainName: string, externalId = store.externalId) => t.call('POST', `/v1/tenants/domains/buy?externalId=${externalId}`, { body: { domainName, contact: CONTACT } });
    expect((await buy('taken.com')).status).toBe(409);
    expect((await buy('gold.com')).status).toBe(409);

    const res = await buy('MyBakery.com');
    expect(res.status).toBe(200);
    const order = (await res.json()) as any;
    valid('buyDomain', order);
    expect(order).toMatchObject({ domainName: 'mybakery.com', status: 'awaiting_payment', priceCents: 1500, payUrl: 'https://invoice.stripe.example/in_1', autoRenew: true });
    const invoice = stripe.invoices.get('in_1')!;
    expect(invoice.input.lines).toEqual([{ amountCents: 1500, description: 'mybakery.com, 1 year' }]);
    expect(invoice.input.chargeAutomatically).toBe(false);
    // The name is held while the invoice waits.
    expect((await buy('mybakery.com')).status).toBe(409);

    // Not paid yet: nothing registered.
    await processDomainSales(work);
    expect(registrar.registered).toEqual([]);

    stripe.pay('in_1');
    await processDomainSales(work);
    expect(registrar.registered).toEqual([{ domain: 'mybakery.com', costCents: 1000, email: 'ada@example.com' }]);
    expect(registrar.records).toEqual([
      'mybakery.com A @ 203.0.113.7',
      'mybakery.com AAAA @ 2001:db8::7',
      'mybakery.com A www 203.0.113.7',
      'mybakery.com AAAA www 2001:db8::7',
    ]);
    const list = (await (await t.call('GET', `/v1/tenants/domains/bought?externalId=${store.externalId}`)).json()) as any;
    valid('listBoughtDomains', list);
    expect(list.domains[0]).toMatchObject({ status: 'active', payUrl: null, expiresAt: '2027-11-08T00:00:00.000Z' });

    await waitFor(async () => {
      const domains = (await (await t.call('GET', `/v1/tenants/domains?externalId=${store.externalId}`)).json()) as { domainName: string; isMainDomain: boolean }[];
      return domains.some((d) => d.domainName === 'mybakery.com' && d.isMainDomain) && domains.some((d) => d.domainName === 'www.mybakery.com');
    });

    // A second pass changes nothing: no double registration.
    await processDomainSales(work);
    expect(registrar.registered).toHaveLength(1);

    const code = (await (await t.call('GET', `/v1/tenants/domains/bought/transfer-code?externalId=${store.externalId}&domainName=mybakery.com`)).json()) as any;
    valid('getBoughtDomainTransferCode', code);
    expect(code).toEqual({ domainName: 'mybakery.com', authCode: 'EPP-CODE-1' });
  });

  it('lets an unpaid order go, and fails a paid one whose name was taken meanwhile', async () => {
    const other = await newTenant('Florist');
    const order = (await (await t.call('POST', `/v1/tenants/domains/buy?externalId=${other.externalId}`, { body: { domainName: 'florist.net', contact: CONTACT } })).json()) as any;
    stripe.pay('in_2', 'void');
    await processDomainSales(work);
    const cancelled = ((await (await t.call('GET', `/v1/tenants/domains/bought?externalId=${other.externalId}`)).json()) as any).domains[0];
    expect(cancelled).toMatchObject({ id: order.id, status: 'cancelled' });

    // Cancelled orders free the name.
    const again = (await (await t.call('POST', `/v1/tenants/domains/buy?externalId=${other.externalId}`, { body: { domainName: 'florist.net', contact: CONTACT } })).json()) as any;
    registrar.takenLater.add('florist.net');
    stripe.pay('in_3');
    await processDomainSales(work);
    const failed = ((await (await t.call('GET', `/v1/tenants/domains/bought?externalId=${other.externalId}`)).json()) as any).domains[0];
    expect(failed).toMatchObject({ id: again.id, status: 'failed' });
    expect(failed.error).toMatch(/Refund/);
    expect(registrar.registered.map((r) => r.domain)).not.toContain('florist.net');
  });

  it('invoices the renewal 30 days ahead, charges the card on file and renews once paid', async () => {
    const soon = new Date('2027-10-20T00:00:00Z');
    stripe.card = true;
    await processDomainSales({ ...work, now: () => soon });
    const renewal = [...stripe.invoices.values()].find((i) => i.input.metadata.kind === 'domain-renewal')!;
    expect(renewal.input).toMatchObject({ chargeAutomatically: true, lines: [{ amountCents: 1700, description: 'mybakery.com, 1 more year' }] });
    let row = ((await (await t.call('GET', `/v1/tenants/domains/bought?externalId=${store.externalId}`)).json()) as any).domains[0];
    expect(row.renewalPayUrl).toBe(renewal.hostedInvoiceUrl);

    // Running again before payment sends no second invoice.
    await processDomainSales({ ...work, now: () => soon });
    expect([...stripe.invoices.values()].filter((i) => i.input.metadata.kind === 'domain-renewal')).toHaveLength(1);

    stripe.pay(renewal.id);
    await processDomainSales({ ...work, now: () => soon });
    expect(registrar.renewed).toEqual(['mybakery.com']);
    row = ((await (await t.call('GET', `/v1/tenants/domains/bought?externalId=${store.externalId}`)).json()) as any).domains[0];
    expect(row).toMatchObject({ status: 'active', expiresAt: '2028-11-08T00:00:00.000Z', renewalPayUrl: null });
  });

  it('lets the owner turn renewal off, and the domain expires after its year', async () => {
    const res = await t.call('PUT', `/v1/tenants/domains/bought/auto-renew?externalId=${store.externalId}`, { body: { domainName: 'mybakery.com', autoRenew: false } });
    const body = (await res.json()) as any;
    valid('setBoughtDomainAutoRenew', body);
    expect(body.autoRenew).toBe(false);
    const before = stripe.invoices.size;
    await processDomainSales({ ...work, now: () => new Date('2028-10-20T00:00:00Z') });
    expect(stripe.invoices.size).toBe(before);
    await processDomainSales({ ...work, now: () => new Date('2028-11-09T00:00:00Z') });
    const row = ((await (await t.call('GET', `/v1/tenants/domains/bought?externalId=${store.externalId}`)).json()) as any).domains[0];
    expect(row.status).toBe('expired');
    expect((await t.call('GET', `/v1/tenants/domains/bought/transfer-code?externalId=${store.externalId}&domainName=mybakery.com`)).status).toBe(400);
  });

  it('registers a domain paid for at a reseller storefront at once, renews it from the shop and bills the reseller', async () => {
    const cakes = await newTenant('Cakes');
    const buy = (reference: string, domainName = 'cakes.shop') =>
      t.call('POST', `/v1/tenants/domains/buy?externalId=${cakes.externalId}`, { body: { domainName, contact: CONTACT, reference } });
    // A storefront without a reseller, not listed as the platform's shop, gets invoices instead.
    expect((await buy('order-1')).status).toBe(403);

    const resellerId = (await t.pool.query("INSERT INTO resellers (name) VALUES ('Cake Partners') RETURNING id")).rows[0].id;
    await t.pool.query('UPDATE products SET reseller_id = $2 WHERE id = $1', [t.productId, resellerId]);
    try {
      const invoices = stripe.invoices.size;
      const res = await buy('order-1');
      expect(res.status).toBe(200);
      const order = (await res.json()) as any;
      valid('buyDomain', order);
      expect(order).toMatchObject({ domainName: 'cakes.shop', status: 'registering', paidBy: 'storefront', reference: 'order-1', payUrl: null, priceCents: 1500 });
      expect(stripe.invoices.size).toBe(invoices);
      // The shop retrying its order gets the same domain; another order for it is refused.
      expect(((await (await buy('order-1')).json()) as any).id).toBe(order.id);
      expect((await buy('order-1', 'other.shop')).status).toBe(409);

      await processDomainSales(work);
      expect(registrar.registered.map((r) => r.domain)).toContain('cakes.shop');
      const renew = (reference: string) =>
        t.call('POST', `/v1/tenants/domains/bought/renew?externalId=${cakes.externalId}`, { body: { domainName: 'cakes.shop', reference } });
      const renewed = (await (await renew('renewal-1')).json()) as any;
      valid('renewBoughtDomain', renewed);
      expect(renewed).toMatchObject({ status: 'active', expiresAt: '2028-11-08T00:00:00.000Z' });
      expect((await renew('renewal-1')).status).toBe(200);
      expect(registrar.renewed.filter((d) => d === 'cakes.shop')).toHaveLength(1);
      // It renews with the shop's subscription, never with our invoices.
      expect((await t.call('PUT', `/v1/tenants/domains/bought/auto-renew?externalId=${cakes.externalId}`, { body: { domainName: 'cakes.shop', autoRenew: false } })).status).toBe(400);
      await processDomainSales({ ...work, now: () => new Date('2028-10-20T00:00:00Z') });
      expect(stripe.invoices.size).toBe(invoices);

      const month = new Date().toISOString().slice(0, 7);
      const bill = (await (await t.call('GET', `/admin/resellers/${resellerId}/bill?month=${month}`, { auth: 'Bearer test-admin-token-not-a-secret' })).json()) as any;
      expect(bill.domainLines.map((l: any) => [l.domainName, l.kind, l.amountCents])).toEqual([
        ['cakes.shop', 'registration', 1500],
        ['cakes.shop', 'renewal', 1700],
      ]);
      expect(bill.totalCents).toBe(bill.lines.reduce((sum: number, l: any) => sum + l.amountCents, 0) + 3200);
    } finally {
      await t.pool.query('UPDATE products SET reseller_id = NULL WHERE id = $1', [t.productId]);
    }
  });

  it('answers on the admin API for the dashboard', async () => {
    const res = await t.call('GET', `/admin/tenants/${store.id}/domains/bought`, { auth: 'Bearer test-admin-token-not-a-secret' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).domains.length).toBeGreaterThan(0);
    expect((await t.call('GET', `/admin/tenants/${store.id}/domains/search?query=cakes`, { auth: 'Bearer test-admin-token-not-a-secret' })).status).toBe(200);
  });
});

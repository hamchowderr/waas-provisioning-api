// Automatic monthly Stripe invoices for resellers (src/resellerinvoices.ts, src/stripe.ts): the admin
// endpoints, the monthly run, never sending a month twice, retries after a failure, and the Stripe
// calls themselves against a recorded fetch.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoiceAllResellers, lastMonth, loadResellerInvoiceConfig, type ResellerInvoiceConfig } from '../src/resellerinvoices.ts';
import { Stripe, StripeError, type InvoiceSender, type NewInvoice, type StripeInvoice } from '../src/stripe.ts';
import { setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;

async function admin(method: string, path: string, expected = 200, body?: unknown): Promise<any> {
  const res = await t.call(method, path, { auth: ADMIN, body });
  expect(res.status, `${method} ${path}`).toBe(expected);
  return res.json();
}

/** Stripe in memory: customers, invoices, and an optional failure on the next sendInvoice. */
class FakeStripe implements InvoiceSender {
  customers = new Map<string, { email: string; name: string; card: boolean }>();
  invoices = new Map<string, StripeInvoice & { input?: NewInvoice }>();
  sent: NewInvoice[] = [];
  failNext: string | null = null;
  /** Leaves a draft behind before failing, as a stop half-way would. */
  failAfterDraft = false;
  private n = 0;

  async createCustomer({ email, name }: { email: string; name: string }) {
    const id = `cus_fake${++this.n}`;
    this.customers.set(id, { email, name, card: false });
    return id;
  }
  async hasCardOnFile(customer: string) {
    return this.customers.get(customer)?.card ?? false;
  }
  async sendInvoice(input: NewInvoice, onDraft: (id: string) => Promise<void>) {
    const id = `in_fake${++this.n}`;
    if (this.failNext && !this.failAfterDraft) {
      const message = this.failNext;
      this.failNext = null;
      throw new StripeError(402, message);
    }
    this.invoices.set(id, { id, status: 'draft', hostedInvoiceUrl: null, input });
    await onDraft(id);
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      this.failAfterDraft = false;
      throw new StripeError(500, message);
    }
    const invoice = { id, status: 'open' as const, hostedInvoiceUrl: `https://invoice.stripe.example/${id}`, input };
    this.invoices.set(id, invoice);
    this.sent.push(input);
    return invoice;
  }
  async getInvoice(id: string) {
    const invoice = this.invoices.get(id);
    if (!invoice) throw new StripeError(404, 'No such invoice');
    return invoice;
  }
  async deleteDraft(id: string) {
    this.invoices.delete(id);
  }
}

let stripe: FakeStripe;
let config: ResellerInvoiceConfig;

async function billedReseller(name: string, body: object = {}) {
  const reseller = await admin('POST', '/admin/resellers', 201, { name, billingEmail: 'accounts@example.com', listPriceCents: { small: 1200, medium: 2400, large: 4800 }, ...body });
  const productId = (await t.pool.query<{ id: string }>('INSERT INTO products (name) VALUES ($1) RETURNING id', [`${name} storefront`])).rows[0]!.id;
  await admin('PUT', `/admin/resellers/${reseller.id}/products/${productId}`);
  // Two small stores live all of September 2026: $12 less 40% = $7.20 each.
  await t.pool.query(
    `INSERT INTO tenant_periods (tenant_id, product_id, reseller_id, size, started_at, ended_at) VALUES
       (gen_random_uuid(), $1, $2, 'small', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
       (gen_random_uuid(), $1, $2, 'small', '2026-08-15T00:00:00Z', '2026-10-01T00:00:00Z')`,
    [productId, reseller.id],
  );
  return reseller as { id: string };
}

beforeAll(async () => {
  t = await setup();
  stripe = new FakeStripe();
  config = { stripe, schedule: '0 7 1 * *', daysUntilDue: 14 };
});
afterAll(async () => {
  await t.close();
});

describe('reseller invoices', () => {
  it('answers 503 to sending while invoicing is off, and lists nothing', async () => {
    const reseller = await billedReseller('Off');
    expect(await admin('GET', `/admin/resellers/${reseller.id}/invoices`)).toEqual({ enabled: false, invoices: [] });
    await admin('POST', `/admin/resellers/${reseller.id}/invoices`, 503, { month: '2026-09' });
  });

  it("sends a month's bill as a Stripe invoice once, with a customer made from the billing email", async () => {
    t.deps.config.resellerInvoices = config;
    const reseller = await billedReseller('Partner A');
    const invoice = await admin('POST', `/admin/resellers/${reseller.id}/invoices`, 200, { month: '2026-09' });
    expect(invoice).toMatchObject({ month: '2026-09', totalCents: 1440, status: 'open', chargeAutomatically: false, error: null });
    expect(invoice.hostedInvoiceUrl).toMatch(/^https:\/\/invoice\.stripe\.example\//);

    const sent = stripe.sent.at(-1)!;
    expect(sent).toMatchObject({ chargeAutomatically: false, daysUntilDue: 14, metadata: { reseller_id: reseller.id, month: '2026-09' } });
    expect(sent.lines).toEqual([{ amountCents: 1440, description: 'Partner A storefront: 2 Small stores (60 store-days) at $7.20 a month' }]);
    expect(stripe.customers.get(sent.customer)).toMatchObject({ email: 'accounts@example.com', name: 'Partner A' });
    expect((await admin('GET', `/admin/resellers/${reseller.id}`)).stripeCustomerId).toBe(sent.customer);

    // Asking again never sends a second invoice.
    const again = await admin('POST', `/admin/resellers/${reseller.id}/invoices`, 200, { month: '2026-09' });
    expect(again.id).toBe(invoice.id);
    expect(stripe.sent.filter((s) => s.metadata.reseller_id === reseller.id)).toHaveLength(1);

    // Paid on Stripe: the list shows it paid.
    stripe.invoices.get(invoice.stripeInvoiceId)!.status = 'paid';
    const listed = await admin('GET', `/admin/resellers/${reseller.id}/invoices`);
    expect(listed.enabled).toBe(true);
    expect(listed.invoices).toEqual([expect.objectContaining({ month: '2026-09', status: 'paid' })]);
  });

  it('charges the card on file when the customer has one', async () => {
    const reseller = await billedReseller('Partner B');
    const customer = await stripe.createCustomer({ email: 'b@example.com', name: 'B' });
    stripe.customers.get(customer)!.card = true;
    await admin('PUT', `/admin/resellers/${reseller.id}`, 200, { stripeCustomerId: customer });
    const invoice = await admin('POST', `/admin/resellers/${reseller.id}/invoices`, 200, { month: '2026-09' });
    expect(invoice).toMatchObject({ status: 'open', chargeAutomatically: true });
    expect(stripe.sent.at(-1)!.customer).toBe(customer);
  });

  it('records a failure and sends on the retry, dropping a half-made draft', async () => {
    const reseller = await billedReseller('Partner C');
    stripe.failNext = 'Your card was declined';
    const failed = await admin('POST', `/admin/resellers/${reseller.id}/invoices`, 200, { month: '2026-09' });
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('declined') });

    stripe.failNext = 'Stripe went away';
    stripe.failAfterDraft = true;
    const half = await admin('POST', `/admin/resellers/${reseller.id}/invoices`, 200, { month: '2026-09' });
    expect(half.status).toBe('failed');
    const draftId = half.stripeInvoiceId as string;
    expect(stripe.invoices.get(draftId)?.status).toBe('draft');

    const retried = await admin('POST', `/admin/resellers/${reseller.id}/invoices`, 200, { month: '2026-09' });
    expect(retried).toMatchObject({ status: 'open', error: null });
    expect(retried.stripeInvoiceId).not.toBe(draftId);
    expect(stripe.invoices.has(draftId)).toBe(false);
  });

  it('records nothing due, refuses a month not over, and needs a billing email', async () => {
    const empty = await admin('POST', '/admin/resellers', 201, { name: 'Empty', billingEmail: 'e@example.com' });
    expect(await admin('POST', `/admin/resellers/${empty.id}/invoices`, 200, { month: '2026-09' })).toMatchObject({ status: 'nothing_due', totalCents: 0 });
    const thisMonth = new Date().toISOString().slice(0, 7);
    await admin('POST', `/admin/resellers/${empty.id}/invoices`, 400, { month: thisMonth });
    await admin('POST', `/admin/resellers/${empty.id}/invoices`, 400, { month: '2026-13' });

    const noEmail = await billedReseller('No email', { billingEmail: null });
    expect(await admin('POST', `/admin/resellers/${noEmail.id}/invoices`, 200, { month: '2026-09' })).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('billing email'),
    });
    await admin('PUT', `/admin/resellers/${noEmail.id}`, 400, { stripeCustomerId: 'not-a-customer' });
    await admin('PUT', `/admin/resellers/${noEmail.id}`, 400, { autoInvoice: 'yes' });
  });

  it('the monthly run bills last month for resellers with autoInvoice on only', async () => {
    const on = await billedReseller('Run on');
    const off = await billedReseller('Run off', { autoInvoice: false });
    expect((await admin('GET', `/admin/resellers/${off.id}`)).autoInvoice).toBe(false);
    const results = await invoiceAllResellers(t.pool, config, new Date('2026-10-01T07:00:00Z'));
    expect(lastMonth(new Date('2026-10-01T07:00:00Z'))).toBe('2026-09');
    expect(results.find((r) => r.resellerId === on.id)?.invoice).toMatchObject({ month: '2026-09', status: 'open', totalCents: 1440 });
    expect(results.find((r) => r.resellerId === off.id)).toBeUndefined();
    // Already-sent months are left alone on a second run.
    const before = stripe.sent.length;
    await invoiceAllResellers(t.pool, config, new Date('2026-10-01T08:00:00Z'));
    expect(stripe.sent.length).toBe(before);
  });
});

describe('Stripe calls', () => {
  it('makes, fills, finalizes and emails an invoice with idempotency keys', async () => {
    const calls: { method: string; url: string; body: string; key: string | null }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ method: init.method!, url, body: String(init.body ?? ''), key: headers['Idempotency-Key'] ?? null });
      expect(headers.Authorization).toBe('Bearer sk_test_abc');
      const id = url.includes('/v1/invoices') ? 'in_1' : 'ii_1';
      return new Response(JSON.stringify({ id, status: url.endsWith('/send') ? 'open' : 'draft', hosted_invoice_url: 'https://pay.example/in_1' }), { status: 200 });
    }) as typeof fetch;
    const s = new Stripe('sk_test_abc', fetchFn);
    const invoice = await s.sendInvoice(
      {
        customer: 'cus_1',
        chargeAutomatically: false,
        daysUntilDue: 14,
        description: 'Bill',
        metadata: { month: '2026-09' },
        lines: [{ amountCents: 1440, description: 'Two stores' }],
        idempotencyKey: 'k',
      },
      async () => {},
    );
    expect(invoice).toEqual({ id: 'in_1', status: 'open', hostedInvoiceUrl: 'https://pay.example/in_1' });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname} ${c.key}`)).toEqual([
      'POST /v1/invoices k:invoice',
      'POST /v1/invoiceitems k:line:0',
      'POST /v1/invoices/in_1/finalize k:finalize',
      'POST /v1/invoices/in_1/send k:send',
    ]);
    const created = new URLSearchParams(calls[0]!.body);
    expect(created.get('collection_method')).toBe('send_invoice');
    expect(created.get('days_until_due')).toBe('14');
    expect(created.get('metadata[month]')).toBe('2026-09');
    expect(created.get('pending_invoice_items_behavior')).toBe('exclude');
    expect(new URLSearchParams(calls[1]!.body).get('amount')).toBe('1440');
  });

  it("turns Stripe's errors into StripeError and reads the setting", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: { message: 'No such customer', code: 'resource_missing' } }), { status: 404 })) as unknown as typeof fetch;
    await expect(new Stripe('sk_test_x', fetchFn).hasCardOnFile('cus_x')).rejects.toMatchObject({ status: 404, code: 'resource_missing' });
    expect(loadResellerInvoiceConfig({})).toBeUndefined();
    expect(loadResellerInvoiceConfig({ STRIPE_SECRET_KEY: 'sk_test_1', RESELLER_INVOICE: 'off' })).toBeUndefined();
    expect(loadResellerInvoiceConfig({ STRIPE_SECRET_KEY: 'rk_live_1' })).toMatchObject({ schedule: '0 7 1 * *', daysUntilDue: 14 });
    expect(() => loadResellerInvoiceConfig({ STRIPE_SECRET_KEY: 'pk_live_1' })).toThrow(/secret or restricted/);
  });
});

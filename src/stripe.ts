import StripeSdk from 'stripe';

/**
 * The few Stripe REST calls that turn a reseller's monthly bill into a Stripe invoice
 * (src/resellerinvoices.ts): make a customer, read whether it has a card on file, make a draft
 * invoice with one item per bill line, finalize and send it, and read an invoice's status.
 * STRIPE_SECRET_KEY needs write access to customers, invoices and invoice items (a restricted key works).
 */

export interface StripeInvoice {
  id: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  hostedInvoiceUrl: string | null;
}

export interface NewInvoice {
  customer: string;
  /** Charge the card on file; otherwise Stripe emails the invoice to pay within daysUntilDue. */
  chargeAutomatically: boolean;
  daysUntilDue: number;
  description: string;
  footer?: string;
  metadata: Record<string, string>;
  lines: { amountCents: number; description: string }[];
  /** Makes retries safe: the same key never makes a second invoice or line. */
  idempotencyKey: string;
}

/** What invoicing needs from Stripe; a fake in tests. */
export interface InvoiceSender {
  createCustomer(input: { email: string; name: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<string>;
  /** True when the customer has a default payment method to charge. */
  hasCardOnFile(customer: string): Promise<boolean>;
  /** Makes, fills, finalizes and (when not charged automatically) emails the invoice. */
  sendInvoice(input: NewInvoice, onDraft: (invoiceId: string) => Promise<void>): Promise<StripeInvoice>;
  getInvoice(invoiceId: string): Promise<StripeInvoice>;
  /** Deletes a draft invoice left by a stopped attempt; one already gone is fine. */
  deleteDraft(invoiceId: string): Promise<void>;
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * The Stripe API version every call asks for, so a change to the account's default version never
 * changes what these calls send or get back: the one the official `stripe` package pins.
 */
export const STRIPE_API_VERSION = StripeSdk.API_VERSION;

const toInvoice = (raw: { id: string; status: string | null; hosted_invoice_url?: string | null }): StripeInvoice => ({
  id: raw.id,
  status: raw.status as StripeInvoice['status'],
  hostedInvoiceUrl: raw.hosted_invoice_url ?? null,
});

/** The official `stripe` package, behind the small InvoiceSender interface the invoicing uses. */
export class Stripe implements InvoiceSender {
  private readonly sdk: StripeSdk;

  constructor(secretKey: string, fetchFn: typeof fetch = fetch) {
    this.sdk = new StripeSdk(secretKey, {
      apiVersion: STRIPE_API_VERSION,
      httpClient: StripeSdk.createFetchHttpClient(fetchFn),
      // Every write carries an idempotency key, so retrying a dropped connection is safe.
      maxNetworkRetries: 2,
      timeout: 30_000,
      appInfo: { name: 'waas-provisioning-api' },
    });
  }

  /** The SDK's errors as StripeError, with the HTTP status and Stripe's error code. */
  private async call<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof StripeSdk.errors.StripeError) throw new StripeError(err.statusCode ?? 0, `Stripe ${what}: ${err.message}`, err.code);
      throw err;
    }
  }

  async createCustomer({ email, name, metadata, idempotencyKey }: { email: string; name: string; metadata: Record<string, string>; idempotencyKey: string }) {
    return (await this.call('create customer', () => this.sdk.customers.create({ email, name, metadata }, { idempotencyKey }))).id;
  }

  async hasCardOnFile(customer: string) {
    const c = await this.call('read customer', () => this.sdk.customers.retrieve(customer));
    if ('deleted' in c && c.deleted) return false;
    const live = c as { invoice_settings?: { default_payment_method?: unknown }; default_source?: unknown };
    return Boolean(live.invoice_settings?.default_payment_method || live.default_source);
  }

  async sendInvoice(input: NewInvoice, onDraft: (invoiceId: string) => Promise<void>) {
    const key = input.idempotencyKey;
    const draft = await this.call('create invoice', () =>
      this.sdk.invoices.create(
        {
          customer: input.customer,
          currency: 'usd',
          collection_method: input.chargeAutomatically ? 'charge_automatically' : 'send_invoice',
          days_until_due: input.chargeAutomatically ? undefined : input.daysUntilDue,
          auto_advance: true,
          pending_invoice_items_behavior: 'exclude',
          description: input.description,
          footer: input.footer,
          metadata: input.metadata,
        },
        { idempotencyKey: `${key}:invoice` },
      ),
    );
    const id = draft.id!;
    await onDraft(id);
    for (const [i, line] of input.lines.entries()) {
      await this.call('add invoice line', () =>
        this.sdk.invoiceItems.create(
          { customer: input.customer, invoice: id, currency: 'usd', amount: line.amountCents, description: line.description },
          { idempotencyKey: `${key}:line:${i}` },
        ),
      );
    }
    const finalized = await this.call('finalize invoice', () => this.sdk.invoices.finalizeInvoice(id, { auto_advance: true }, { idempotencyKey: `${key}:finalize` }));
    if (!input.chargeAutomatically) {
      return toInvoice(await this.call('send invoice', () => this.sdk.invoices.sendInvoice(id, {}, { idempotencyKey: `${key}:send` })));
    }
    return toInvoice(finalized);
  }

  async getInvoice(invoiceId: string) {
    return toInvoice((await this.call('read invoice', () => this.sdk.invoices.retrieve(invoiceId))));
  }

  async deleteDraft(invoiceId: string) {
    try {
      await this.call('delete draft invoice', () => this.sdk.invoices.del(invoiceId));
    } catch (err) {
      if (!(err instanceof StripeError && err.status === 404)) throw err;
    }
  }
}

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

/** Stripe's form encoding: nested objects as key[sub], arrays as key[0]. */
function form(params: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && typeof value === 'object') form(value as Record<string, unknown>, name, out);
    else out.append(name, String(value));
  }
  return out;
}

interface RawInvoice {
  id: string;
  status: StripeInvoice['status'];
  hosted_invoice_url?: string | null;
}

const toInvoice = (raw: RawInvoice): StripeInvoice => ({ id: raw.id, status: raw.status, hostedInvoiceUrl: raw.hosted_invoice_url ?? null });

export class Stripe implements InvoiceSender {
  constructor(
    private readonly secretKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.stripe.com',
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let body: string | undefined;
    if (params && method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = form(params).toString();
    }
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    const answer = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
    if (!res.ok) throw new StripeError(res.status, `Stripe ${method} ${path.split('?')[0]}: ${answer.error?.message ?? res.statusText}`, answer.error?.code);
    return answer as T;
  }

  async createCustomer({ email, name, metadata, idempotencyKey }: { email: string; name: string; metadata: Record<string, string>; idempotencyKey: string }) {
    return (await this.call<{ id: string }>('POST', '/v1/customers', { email, name, metadata }, idempotencyKey)).id;
  }

  async hasCardOnFile(customer: string) {
    const c = await this.call<{ invoice_settings?: { default_payment_method?: string | null }; default_source?: string | null }>(
      'GET',
      `/v1/customers/${encodeURIComponent(customer)}`,
    );
    return Boolean(c.invoice_settings?.default_payment_method || c.default_source);
  }

  async sendInvoice(input: NewInvoice, onDraft: (invoiceId: string) => Promise<void>) {
    const draft = await this.call<RawInvoice>(
      'POST',
      '/v1/invoices',
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
      `${input.idempotencyKey}:invoice`,
    );
    await onDraft(draft.id);
    for (const [i, line] of input.lines.entries()) {
      await this.call(
        'POST',
        '/v1/invoiceitems',
        { customer: input.customer, invoice: draft.id, currency: 'usd', amount: line.amountCents, description: line.description },
        `${input.idempotencyKey}:line:${i}`,
      );
    }
    const finalized = await this.call<RawInvoice>('POST', `/v1/invoices/${draft.id}/finalize`, { auto_advance: true }, `${input.idempotencyKey}:finalize`);
    if (!input.chargeAutomatically) {
      return toInvoice(await this.call<RawInvoice>('POST', `/v1/invoices/${draft.id}/send`, {}, `${input.idempotencyKey}:send`));
    }
    return toInvoice(finalized);
  }

  async getInvoice(invoiceId: string) {
    return toInvoice(await this.call<RawInvoice>('GET', `/v1/invoices/${encodeURIComponent(invoiceId)}`));
  }

  async deleteDraft(invoiceId: string) {
    try {
      await this.call('DELETE', `/v1/invoices/${encodeURIComponent(invoiceId)}`);
    } catch (err) {
      if (!(err instanceof StripeError && err.status === 404)) throw err;
    }
  }
}

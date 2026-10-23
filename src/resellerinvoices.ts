import type { PgBoss } from 'pg-boss';
import type { Pool } from './db.ts';
import { HttpError } from './errors.ts';
import { loadResellers, monthRange, resellerBill, type Reseller, type ResellerBillLine } from './resellers.ts';
import { Stripe, type InvoiceSender, type StripeInvoice } from './stripe.ts';

/**
 * Automatic monthly invoices for resellers (docs/resellers.md). On the 1st, each reseller with
 * auto_invoice on gets last month's wholesale bill (src/resellers.ts) as a Stripe invoice on its
 * Stripe customer, made from its billing email the first time. With a card on file Stripe charges it;
 * otherwise Stripe emails the invoice to pay online. One invoice per reseller and month
 * (reseller_invoices); a month already sent is never sent again, and a failed one can be retried.
 */

export const RESELLER_INVOICES_QUEUE = 'reseller-invoices';

/** A try still marked sending after this long was stopped (the API restarted) and may be tried again. */
const STALE_SENDING_MINUTES = 60;

export interface ResellerInvoiceConfig {
  stripe: InvoiceSender;
  /** pg-boss cron (UTC). Default 07:00 on the 1st. */
  schedule: string;
  /** Days an emailed invoice is due in. */
  daysUntilDue: number;
}

/** On when STRIPE_SECRET_KEY is set, unless RESELLER_INVOICE=off. */
export function loadResellerInvoiceConfig(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): ResellerInvoiceConfig | undefined {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key || env.RESELLER_INVOICE === 'off') return undefined;
  if (!/^(sk|rk)_(live|test)_/.test(key)) throw new Error('STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_… or rk_…)');
  const daysUntilDue = Number(env.RESELLER_INVOICE_DAYS_DUE ?? 14);
  if (!Number.isInteger(daysUntilDue) || daysUntilDue < 1 || daysUntilDue > 90) throw new Error('RESELLER_INVOICE_DAYS_DUE must be a whole number of days from 1 to 90');
  return { stripe: new Stripe(key, fetchFn), schedule: env.RESELLER_INVOICE_SCHEDULE ?? '0 7 1 * *', daysUntilDue };
}

export interface ResellerInvoice {
  id: string;
  month: string;
  totalCents: number;
  status: 'sending' | 'nothing_due' | 'open' | 'paid' | 'void' | 'uncollectible' | 'failed';
  stripeInvoiceId: string | null;
  hostedInvoiceUrl: string | null;
  chargeAutomatically: boolean | null;
  error: string | null;
  dateCreated: string;
  dateUpdated: string;
}

const toInvoice = (r: Record<string, unknown>): ResellerInvoice => ({
  id: r.id as string,
  month: r.month as string,
  totalCents: r.total_cents as number,
  status: r.status as ResellerInvoice['status'],
  stripeInvoiceId: (r.stripe_invoice_id as string | null) ?? null,
  hostedInvoiceUrl: (r.hosted_invoice_url as string | null) ?? null,
  chargeAutomatically: (r.charge_automatically as boolean | null) ?? null,
  error: (r.error as string | null) ?? null,
  dateCreated: (r.created_at as Date).toISOString(),
  dateUpdated: (r.updated_at as Date).toISOString(),
});

/** Last calendar month (UTC) as YYYY-MM: the one the 1st's run bills. */
export function lastMonth(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** One invoice line, in words: "Acme shop: 2.5 Small stores (75 store-days) at $7.20 a month". */
export function lineDescription(line: ResellerBillLine): string {
  const size = line.size[0]!.toUpperCase() + line.size.slice(1);
  const stores = line.stores === 1 ? `1 ${size} store` : `${line.stores} ${size} stores`;
  return `${line.name ?? 'Removed storefront'}: ${stores} (${line.storeDays} store-days) at ${dollars(line.wholesalePriceCents)} a month`;
}

/** A reseller's invoices, newest month first. */
export async function listResellerInvoices(pool: Pool, resellerId: string): Promise<ResellerInvoice[]> {
  const { rows } = await pool.query('SELECT * FROM reseller_invoices WHERE reseller_id = $1 ORDER BY month DESC', [resellerId]);
  return rows.map(toInvoice);
}

/** Asks Stripe about invoices not settled yet (open), so paid ones show as paid. Errors leave them as they were. */
export async function refreshResellerInvoices(pool: Pool, stripe: InvoiceSender, resellerId: string): Promise<void> {
  const { rows } = await pool.query<{ id: string; stripe_invoice_id: string }>(
    "SELECT id, stripe_invoice_id FROM reseller_invoices WHERE reseller_id = $1 AND status = 'open' AND stripe_invoice_id IS NOT NULL",
    [resellerId],
  );
  for (const row of rows) {
    try {
      const invoice = await stripe.getInvoice(row.stripe_invoice_id);
      if (invoice.status !== 'draft') {
        await pool.query('UPDATE reseller_invoices SET status = $2, hosted_invoice_url = coalesce($3, hosted_invoice_url), updated_at = now() WHERE id = $1', [
          row.id,
          invoice.status,
          invoice.hostedInvoiceUrl,
        ]);
      }
    } catch {
      // Shown as it was; the next look tries again.
    }
  }
}

/**
 * Sends one reseller's bill for `month` as a Stripe invoice and records it. A month already sent,
 * sending or with nothing due is left as it is and returned; a failed one is tried again. A failure
 * is recorded (status failed, error) and returned, not thrown.
 */
export async function invoiceReseller(
  pool: Pool,
  config: ResellerInvoiceConfig,
  reseller: Reseller,
  month: string,
  now = new Date(),
): Promise<ResellerInvoice> {
  const { from, to } = monthRange(month);
  if (to > now) throw new HttpError(400, 'That month is not over yet');

  // Claim the month: a new row, or a failed (or long-stopped) try taken over with the next attempt number.
  const { rows: claimed } = await pool.query(
    `INSERT INTO reseller_invoices (reseller_id, month, total_cents, status) VALUES ($1, $2, 0, 'sending')
     ON CONFLICT (reseller_id, month) DO UPDATE SET status = 'sending', attempts = reseller_invoices.attempts + 1, error = NULL, updated_at = now()
       WHERE reseller_invoices.status = 'failed'
          OR (reseller_invoices.status = 'sending' AND reseller_invoices.updated_at < now() - make_interval(mins => $3))
     RETURNING *`,
    [reseller.id, month, STALE_SENDING_MINUTES],
  );
  if (!claimed[0]) {
    const { rows } = await pool.query('SELECT * FROM reseller_invoices WHERE reseller_id = $1 AND month = $2', [reseller.id, month]);
    return toInvoice(rows[0]!);
  }
  const row = claimed[0] as { id: string; attempts: number; stripe_invoice_id: string | null };
  const update = async (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    const { rows } = await pool.query(
      `UPDATE reseller_invoices SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [row.id, ...keys.map((k) => fields[k])],
    );
    return toInvoice(rows[0]!);
  };
  const recorded = (invoice: StripeInvoice, chargeAutomatically: boolean | null) =>
    update({
      status: invoice.status === 'draft' ? 'open' : invoice.status,
      stripe_invoice_id: invoice.id,
      hosted_invoice_url: invoice.hostedInvoiceUrl,
      charge_automatically: chargeAutomatically,
    });

  try {
    const bill = await resellerBill(pool, reseller, month, from, to, now);
    await update({ total_cents: bill.totalCents });
    if (bill.totalCents <= 0) return await update({ status: 'nothing_due' });

    // An earlier try that got as far as Stripe: keep a finished invoice, drop a half-made draft.
    if (row.stripe_invoice_id) {
      const earlier = await config.stripe.getInvoice(row.stripe_invoice_id);
      if (earlier.status !== 'draft') return await recorded(earlier, null);
      await config.stripe.deleteDraft(earlier.id);
      await update({ stripe_invoice_id: null });
    }

    const key = `reseller-invoice:${reseller.id}:${month}:${row.attempts}`;
    let customer = reseller.stripeCustomerId;
    if (!customer) {
      if (!reseller.billingEmail) throw new Error('No billing email or Stripe customer: add a billing email to send invoices');
      customer = await config.stripe.createCustomer({
        email: reseller.billingEmail,
        name: reseller.name,
        metadata: { reseller_id: reseller.id },
        idempotencyKey: `${key}:customer`,
      });
      await pool.query('UPDATE resellers SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [reseller.id, customer]);
    }
    const chargeAutomatically = await config.stripe.hasCardOnFile(customer);
    const invoice = await config.stripe.sendInvoice(
      {
        customer,
        chargeAutomatically,
        daysUntilDue: config.daysUntilDue,
        description: `Wholesale bill for ${month}: ${reseller.wholesalePercent}% off list price for each store, for the days it was live.`,
        metadata: { reseller_id: reseller.id, month },
        lines: bill.lines.filter((l) => l.amountCents > 0).map((l) => ({ amountCents: l.amountCents, description: lineDescription(l) })),
        idempotencyKey: key,
      },
      async (invoiceId) => {
        await update({ stripe_invoice_id: invoiceId });
      },
    );
    return await recorded(invoice, chargeAutomatically);
  } catch (err) {
    return await update({ status: 'failed', error: (err as Error).message.slice(0, 1000) });
  }
}

/** Sends last month's invoice to every reseller with auto_invoice on. Returns how each went. */
export async function invoiceAllResellers(pool: Pool, config: ResellerInvoiceConfig, now = new Date()) {
  const month = lastMonth(now);
  const results: { resellerId: string; invoice: ResellerInvoice }[] = [];
  for (const reseller of (await loadResellers(pool, null)).filter((r) => r.autoInvoice)) {
    results.push({ resellerId: reseller.id, invoice: await invoiceReseller(pool, config, reseller, month, now) });
  }
  return results;
}

/** Schedules the monthly run when invoicing is on; unschedules it otherwise. */
export async function startResellerInvoices(
  boss: PgBoss,
  pool: Pool,
  config: ResellerInvoiceConfig | undefined,
  { pollingIntervalSeconds = 60, log = console }: { pollingIntervalSeconds?: number; log?: Pick<Console, 'log' | 'error'> } = {},
): Promise<void> {
  if (!config) {
    if (await boss.getQueue(RESELLER_INVOICES_QUEUE)) await boss.unschedule(RESELLER_INVOICES_QUEUE);
    return;
  }
  if (!(await boss.getQueue(RESELLER_INVOICES_QUEUE))) await boss.createQueue(RESELLER_INVOICES_QUEUE, { retryLimit: 2, retryDelay: 600 });
  await boss.schedule(RESELLER_INVOICES_QUEUE, config.schedule);
  await boss.work(RESELLER_INVOICES_QUEUE, { pollingIntervalSeconds }, async () => {
    const results = await invoiceAllResellers(pool, config);
    for (const { resellerId, invoice } of results) {
      if (invoice.status === 'failed') log.error(`reseller invoice ${resellerId} ${invoice.month} failed: ${invoice.error}`);
    }
    log.log(`reseller invoices: ${results.length} checked for ${lastMonth()}`);
  });
}

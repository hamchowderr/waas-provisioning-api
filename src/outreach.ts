// The seller's own mailbox for prospect emails (Sales Kit). Store email goes through the platform's relay, whose
// rules forbid cold outreach, so every store has a guard (the waas-outreach mu-plugin, agent.php): an email to a
// FluentCRM contact tagged "Prospect" who never subscribed goes out only through the mailbox connected here, one
// prospect per email, up to the daily limit, or not at all.
//
// The dashboard saves the mailbox (PUT /admin/products/:id/prospects/mailbox); the storefront.outreach-mailbox job
// signs in to it from the storefront and keeps it there only when that works. The password is kept here, encrypted,
// only until the job has handed it over.
import type { Pool } from './db.ts';
import { badRequest } from './errors.ts';
import { EMAIL, fluentCrmUnavailable, type StorefrontLookup } from './prospectcrm.ts';
import type { Secrets } from './secrets.ts';
import { Status } from './status.ts';

/** What the store keeps (Provisioner.setOutreachMailbox). */
export interface OutreachMailbox {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  name: string;
  /** At most this many prospect emails a day. */
  daily: number;
}

export type MailboxState = 'none' | 'checking' | 'connected' | 'failed' | 'removing';

/** What the dashboard sees: never the password. */
export interface MailboxSettings {
  state: MailboxState;
  /** Why the last check failed, in the mail server's words. */
  error: string | null;
  mailbox: Omit<OutreachMailbox, 'pass'> | null;
  /** Why the storefront can't use a mailbox, or null when it can. */
  unavailable: string | null;
}

export const DAILY_DEFAULT = 30;
export const DAILY_MAX = 200;

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
/** The platform's own relays: the whole point is that prospect emails never go through them. */
const RELAYS = /(^|\.)tosend\.com$/i;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Reads and checks what the dashboard sends. */
export function mailboxInput(body: unknown): OutreachMailbox {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const host = str(b.host, 253).toLowerCase();
  if (!HOST.test(host)) throw badRequest('Enter your mail server, like smtp.gmail.com.');
  if (RELAYS.test(host)) throw badRequest("Prospect emails can't go through AnyPress's own email service. Use your own mailbox.");
  const port = b.port === undefined || b.port === null || b.port === '' ? 587 : Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('The port is a number, usually 587 or 465.');
  const user = str(b.user, 254);
  if (!user) throw badRequest('Enter the username for your mailbox, usually its email address.');
  const pass = typeof b.pass === 'string' ? b.pass.slice(0, 500) : '';
  if (!pass) throw badRequest('Enter the app password for your mailbox.');
  const from = str(b.from, 254).toLowerCase() || user.toLowerCase();
  if (!EMAIL.test(from)) throw badRequest('Enter the email address your prospect emails come from.');
  const name = str(b.name, 100).replace(/[\r\n<>"]/g, '');
  const daily = b.daily === undefined || b.daily === null || b.daily === '' ? DAILY_DEFAULT : Number(b.daily);
  if (!Number.isInteger(daily) || daily < 1 || daily > DAILY_MAX) throw badRequest(`The daily limit is a whole number from 1 to ${DAILY_MAX}.`);
  return { host, port, user, pass, from, name, daily };
}

interface Row {
  mailbox: Omit<OutreachMailbox, 'pass'> | null;
  mailbox_pass: string | null;
  mailbox_status: number | null;
  mailbox_error: string | null;
  /** As text: a Date would lose the microseconds the update compares. */
  mailbox_changed: string | null;
}

const readRow = async (pool: Pool, productId: string) =>
  (
    await pool.query<Row>('SELECT mailbox, mailbox_pass, mailbox_status, mailbox_error, mailbox_changed::text FROM prospect_crm_settings WHERE product_id = $1', [
      productId,
    ])
  ).rows[0];

function stateOf(row: Row | undefined): MailboxState {
  if (!row || row.mailbox_status === null) return 'none';
  // No mailbox: being removed, or the removal didn't reach the storefront (it may still have the old one).
  if (!row.mailbox) return row.mailbox_status === Status.Pending ? 'removing' : row.mailbox_status === Status.Failed ? 'failed' : 'none';
  return row.mailbox_status === Status.Pending ? 'checking' : row.mailbox_status === Status.Done ? 'connected' : 'failed';
}

export async function getMailbox(pool: Pool, storefront: StorefrontLookup, productId: string): Promise<MailboxSettings> {
  const row = await readRow(pool, productId);
  const state = stateOf(row);
  return {
    state,
    error: state === 'failed' ? (row?.mailbox_error ?? null) : null,
    mailbox: row?.mailbox ?? null,
    unavailable: (await fluentCrmUnavailable(storefront, productId)).reason,
  };
}

/** Saves the mailbox (or, with null, removes it) and queues the job that hands it to the storefront. */
export async function setMailbox(
  deps: { pool: Pool; secrets: Secrets; storefront: StorefrontLookup; queue: (tenantId: string, productId: string) => Promise<void> },
  productId: string,
  mailbox: OutreachMailbox | null,
): Promise<MailboxSettings> {
  const { tenantId, reason } = await fluentCrmUnavailable(deps.storefront, productId);
  if (!tenantId) throw badRequest(reason ?? 'This storefront has no FluentCRM.');
  const { pass, ...shown } = mailbox ?? ({} as OutreachMailbox);
  await deps.pool.query(
    `INSERT INTO prospect_crm_settings (product_id, mailbox, mailbox_pass, mailbox_status, mailbox_error, mailbox_changed)
     VALUES ($1, $2, $3, $4, NULL, now())
     ON CONFLICT (product_id) DO UPDATE SET mailbox = EXCLUDED.mailbox, mailbox_pass = EXCLUDED.mailbox_pass,
       mailbox_status = EXCLUDED.mailbox_status, mailbox_error = NULL, mailbox_changed = now(), date_changed = now()`,
    [productId, mailbox ? JSON.stringify(shown) : null, mailbox ? deps.secrets.encrypt(pass) : null, Status.Pending],
  );
  await deps.queue(tenantId, productId);
  return getMailbox(deps.pool, deps.storefront, productId);
}

/**
 * The storefront.outreach-mailbox job: hands the saved mailbox (or its removal) to the storefront, which signs in
 * to it first. Only the latest save is acted on: a job for an earlier one finds nothing waiting.
 */
export async function pushMailbox(
  pool: Pool,
  secrets: Secrets,
  write: (mailbox: OutreachMailbox | null) => Promise<{ ok: boolean; error?: string }>,
  productId: string,
): Promise<void> {
  const row = await readRow(pool, productId);
  if (!row || row.mailbox_status !== Status.Pending) return;
  if (row.mailbox && !row.mailbox_pass) return;
  const mailbox = row.mailbox ? { ...row.mailbox, pass: secrets.decrypt(row.mailbox_pass!) } : null;
  const res = await write(mailbox);
  const status = !mailbox ? null : res.ok ? Status.Done : Status.Failed;
  // Only when nothing newer was saved meanwhile.
  await pool.query(
    `UPDATE prospect_crm_settings SET mailbox_status = $2, mailbox_error = $3, mailbox_pass = NULL, date_changed = now()
      WHERE product_id = $1 AND mailbox_changed = $4::timestamptz`,
    [productId, status, res.ok ? null : (res.error ?? 'Could not sign in to the mailbox').slice(0, 500), row.mailbox_changed],
  );
}

/** When the job gives up: the seller sees it failed and can save it again. */
export async function failMailbox(pool: Pool, productId: string, error: unknown) {
  await pool.query(
    `UPDATE prospect_crm_settings SET mailbox_status = $3, mailbox_error = $4, mailbox_pass = NULL, date_changed = now()
      WHERE product_id = $1 AND mailbox_status = $2`,
    [productId, Status.Pending, Status.Failed, `The storefront could not be reached: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`],
  );
}

// A Sales Kit outreach plan as a draft automation in the storefront's FluentCRM. The dashboard sends a group's emails
// with the seller's details filled in; the storefront.outreach-automation job makes "Outreach: <group>" there
// (Provisioner.addOutreachAutomation), a straight line of waits and emails, as a draft for the seller to read and switch
// on. Once it's on, the store's outreach mu-plugin starts prospects tagged "Prospect: <group>" on it a few a day, through
// the seller's own mailbox (src/outreach.ts), and stops anyone tagged Replied or Customer.
import type { Pool } from './db.ts';
import { badRequest } from './errors.ts';
import { fluentCrmUnavailable, type StorefrontLookup } from './prospectcrm.ts';
import { Status } from './status.ts';

/** What the store makes: emails on days counted from when a prospect starts (1 is the first day). */
export interface OutreachAutomation {
  title: string;
  /** The tag prospects of this group get in the finder (prospectTags). */
  tag: string;
  note: string;
  emails: { day: number; subject: string; body: string }[];
}

interface AutomationState {
  group: string;
  title: string;
  state: 'adding' | 'added' | 'failed';
  error: string | null;
  /** FluentCRM's id for it, once made. */
  funnelId: number | null;
  /** Where to open it in the storefront's WordPress. */
  editUrl: string | null;
}

const MAX_EMAILS = 10;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text, as the kit writes it, into simple paragraphs. Links are made clickable. */
export function emailHtml(body: string): string {
  return body
    .trim()
    .split(/\n\s*\n/)
    .map((para) => `<p>${escapeHtml(para.trim()).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** Reads what the dashboard sends: the group's name and its emails, in order, each on its day. */
export function automationInput(body: unknown): { group: string; automation: OutreachAutomation } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const group = text(b.group, 80).replace(/[:\r\n]/g, '');
  if (!group) throw badRequest('Say which customer group this is for.');
  const list = Array.isArray(b.emails) ? b.emails : [];
  if (!list.length) throw badRequest('There are no emails to add.');
  if (list.length > MAX_EMAILS) throw badRequest(`At most ${MAX_EMAILS} emails.`);
  let last = 0;
  const emails = list.map((e, i) => {
    const r = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const day = Number(r.day);
    if (!Number.isInteger(day) || day < 1 || day > 120 || day < last) throw badRequest(`Email ${i + 1} needs a day from 1 to 120, in order.`);
    last = day;
    const subject = text(r.subject, 200);
    const plain = text(r.body, 5000);
    if (!subject || !plain) throw badRequest(`Email ${i + 1} needs a subject and a message.`);
    return { day, subject, body: emailHtml(plain) };
  });
  const note = text(b.note, 1000);
  return { group, automation: { title: `Outreach: ${group}`, tag: `Prospect: ${group}`, note: note ? emailHtml(note) : '', emails } };
}

interface Row {
  group_title: string;
  status: number;
  funnel_id: number | null;
  error: string | null;
}

export async function listAutomations(pool: Pool, storefront: (productId: string) => Promise<{ id: string; statusCode: number; domain?: string | null } | null>, productId: string) {
  const [{ reason }, store, { rows }] = await Promise.all([
    fluentCrmUnavailable(storefront, productId),
    storefront(productId),
    pool.query<Row>('SELECT group_title, status, funnel_id, error FROM prospect_automations WHERE product_id = $1 ORDER BY group_title', [productId]),
  ]);
  const automations: AutomationState[] = rows.map((r) => ({
    group: r.group_title,
    title: `Outreach: ${r.group_title}`,
    state: r.status === Status.Pending ? 'adding' : r.status === Status.Done ? 'added' : 'failed',
    error: r.status === Status.Failed ? r.error : null,
    funnelId: r.funnel_id,
    editUrl: r.funnel_id && store?.domain ? `https://${store.domain}/wp-admin/admin.php?page=fluentcrm-admin#/funnels/${r.funnel_id}/edit` : null,
  }));
  return { unavailable: reason, automations };
}

/** Saves the plan and queues the job that makes it on the storefront. Making it again leaves an existing one alone. */
export async function addAutomation(
  deps: { pool: Pool; storefront: StorefrontLookup; queue: (tenantId: string, productId: string) => Promise<void> },
  productId: string,
  input: ReturnType<typeof automationInput>,
) {
  const { tenantId, reason } = await fluentCrmUnavailable(deps.storefront, productId);
  if (!tenantId) throw badRequest(reason ?? 'This storefront has no FluentCRM.');
  await deps.pool.query(
    `INSERT INTO prospect_automations (product_id, group_title, status, automation) VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id, group_title) DO UPDATE SET status = EXCLUDED.status, automation = EXCLUDED.automation, error = NULL, date_changed = now()`,
    [productId, input.group, Status.Pending, JSON.stringify(input.automation)],
  );
  await deps.queue(tenantId, productId);
}

/** What Provisioner.addOutreachAutomation answers. */
export interface AutomationResult {
  id: number;
  /** False when the storefront had one by that title already, which is left as it is. */
  created: boolean;
}

/** The storefront.outreach-automation job: makes each waiting plan on the storefront. */
export async function pushAutomations(pool: Pool, write: (automation: OutreachAutomation) => Promise<AutomationResult>, productId: string) {
  const { rows } = await pool.query<{ group_title: string; automation: OutreachAutomation }>(
    'SELECT group_title, automation FROM prospect_automations WHERE product_id = $1 AND status = $2 AND automation IS NOT NULL ORDER BY date_changed',
    [productId, Status.Pending],
  );
  for (const r of rows) {
    const { id } = await write(r.automation);
    await pool.query(
      'UPDATE prospect_automations SET status = $3, funnel_id = $4, automation = NULL, error = NULL, date_changed = now() WHERE product_id = $1 AND group_title = $2',
      [productId, r.group_title, Status.Done, id || null],
    );
  }
}

export async function failAutomations(pool: Pool, productId: string, error: unknown) {
  await pool.query('UPDATE prospect_automations SET status = $3, error = $4, date_changed = now() WHERE product_id = $1 AND status = $2', [
    productId,
    Status.Pending,
    Status.Failed,
    (error instanceof Error ? error.message : String(error)).slice(0, 500),
  ]);
}

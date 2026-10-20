import type { PgBoss } from 'pg-boss';
import type { Config } from './config.ts';
import type { Pool } from './db.ts';
import type { Provisioner, StoreMailFrom, StoreSender } from './provisioner/provisioner.ts';
import { Status } from './status.ts';
import { ToSendError, type MailCounter } from './tosend.ts';

/**
 * The platform's count of each store's email (docs/store-email.md). A store admin can edit the count
 * the store keeps itself, so the platform counts too, on toSend. toSend's messages carry no key or
 * account, only the From address, so each store sends from its own: its mailbox at the platform's
 * sending domain (acme@anypress.io, named after its address), or no-reply@ its own verified domain.
 * Every address a store used is kept (tenant_mail_senders). Every hour the mail-count job counts this
 * month's emails from each live store's addresses and tells the store when its count changed.
 */

export const MAIL_COUNT_QUEUE = 'mail-count';

/** The platform domains a store's mailbox can be named after (Config.platformDomain and Config.storesDomain). */
export type MailboxDomains = Pick<Config, 'storesDomain' | 'platformDomain'>;

/** Names a store's mailbox never takes: the platform's own mailboxes, now or later. */
export const RESERVED_MAILBOXES = new Set([
  'no-reply', 'noreply', 'support', 'admin', 'billing', 'postmaster', 'abuse', 'hostmaster', 'webmaster', 'shop', 'app', 'mail', 'info', 'hello',
]);

/** A DNS label that also works as a mailbox name as it is: lowercase letters, digits and inner hyphens. */
const MAILBOX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** The address a store with these settings sends from, lowercased (toSend's search ignores case). */
const addressOf = (provisioner: Provisioner, from: StoreMailFrom) => provisioner.mailFrom(from)?.toLowerCase() ?? null;

/** The first label of `domain` when it is a name directly under one of `parents`. */
function labelUnder(domain: string | null | undefined, parents: string[]): string | undefined {
  if (!domain) return undefined;
  const dot = domain.indexOf('.');
  return dot > 0 && parents.includes(domain.slice(dot + 1)) ? domain.slice(0, dot) : undefined;
}

/**
 * A store's mailbox at the platform's sending domain: the first label of its main domain when that is
 * a name directly under the platform's or the stores' domain (volume-test-two.anypress.site:
 * volume-test-two), else, or when that label is reserved or no mailbox name, the first label of its base
 * domain (t-64e9c63d.stores.anypress.site: t-64e9c63d). Undefined when neither works: the store then
 * sends from the platform's address.
 */
export function mailboxLabel(mainDomain: string | null | undefined, baseDomain: string | null | undefined, domains: MailboxDomains): string | undefined {
  const parents = [domains.platformDomain, domains.storesDomain].filter((d): d is string => !!d);
  const usable = (label: string | undefined) => (label && MAILBOX.test(label) && !RESERVED_MAILBOXES.has(label) ? label : undefined);
  return usable(labelUnder(mainDomain, parents)) ?? usable(labelUnder(baseDomain, parents) ?? baseDomain?.split('.')[0]);
}

/**
 * The store's mailbox (mailboxLabel). An address another store has sent from is never given to a second
 * one (their counts could not be told apart), nor the platform's own: the store then takes its base
 * domain's, which is its own alone.
 */
export async function storeMailbox(pool: Pool, provisioner: Provisioner, domains: MailboxDomains, tenantId: string): Promise<string | undefined> {
  const { rows } = await pool.query('SELECT domain_name, is_main, is_base FROM tenant_domains WHERE tenant_id = $1 AND (is_main OR is_base)', [tenantId]);
  const main = rows.find((r) => r.is_main)?.domain_name;
  const base = rows.find((r) => r.is_base)?.domain_name;
  const mailbox = mailboxLabel(main, base, domains);
  const own = mailboxLabel(base, base, domains);
  const address = addressOf(provisioner, { mailbox });
  if (!mailbox || mailbox === own || !address) return mailbox;
  if (address === addressOf(provisioner, {})) return own;
  const { rowCount } = await pool.query('SELECT 1 FROM tenant_mail_senders WHERE address = $1 AND tenant_id <> $2', [address, tenantId]);
  return rowCount ? own : mailbox;
}

/** Records the address the store sends from now; the one it sent from before is no longer in use. */
export async function recordMailSender(pool: Pool, provisioner: Provisioner, tenantId: string, from: StoreMailFrom): Promise<void> {
  const address = addressOf(provisioner, from);
  if (!address || address === addressOf(provisioner, {})) return;
  await pool.query('UPDATE tenant_mail_senders SET last_used = now() WHERE tenant_id = $1 AND address <> $2 AND last_used IS NULL', [tenantId, address]);
  await pool.query(
    'INSERT INTO tenant_mail_senders (tenant_id, address) VALUES ($1, $2) ON CONFLICT (tenant_id, address) DO UPDATE SET last_used = NULL',
    [tenantId, address],
  );
}

/**
 * Makes sure a live store sends from its own address (Provisioner.ensureStoreMail): `sender`, its
 * verified domain, else its mailbox at the platform's domain. Used on startup and by the sending
 * domain checks.
 */
export async function ensureStoreSender(pool: Pool, provisioner: Provisioner, domains: MailboxDomains, storeId: string, sender?: StoreSender) {
  const from: StoreMailFrom = sender ? { sender } : { mailbox: await storeMailbox(pool, provisioner, domains, storeId) };
  const result = await provisioner.ensureStoreMail({ storeId, ...from });
  await recordMailSender(pool, provisioner, storeId, from);
  return result;
}

/** Statuses of emails toSend accepted but never sent, so not counted (it bills the rest: sent, bounced, complained, pending). */
const NOT_SENT = ['suppressed', 'failed', 'spam'];

/** Stops a run at toSend's rate limit; the next hour's run starts with the stores this one did not reach. */
class RateLimited extends Error {}

export interface MailCountOptions {
  now?: Date;
  /** Between two toSend requests: 250 ms keeps a run under toSend's 300 searches a minute. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: Pick<Console, 'log' | 'error'>;
}

/**
 * One count of this calendar month (UTC) for every live store, not suspended, that has sent from an
 * address of its own: the emails toSend took from its addresses since the month began, without those
 * it never sent (NOT_SENT). toSend's search matches an address inside longer ones too (acme@anypress.io
 * inside bigacme@anypress.io), so each known address that contains another, whichever store's or the
 * platform's own, has its own count taken off: count(acme) = search(acme) − count(bigacme), the longer
 * ones counted first. A store whose count changed is told it (Provisioner.setMailCount), and the count
 * is kept in tenant_mail_usage. At toSend's rate limit (429) the run stops; the next one starts with
 * the stores checked longest ago. A store that could not be told is tried again on the next run.
 */
export async function countStoreMail(pool: Pool, counter: MailCounter, provisioner: Provisioner, options: MailCountOptions = {}) {
  const now = options.now ?? new Date();
  const month = now.toISOString().slice(0, 7);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = monthStart.toISOString();
  const pauseMs = options.pauseMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? console;

  const { rows: known } = await pool.query<{ address: string }>(
    'SELECT DISTINCT address FROM tenant_mail_senders WHERE last_used IS NULL OR last_used >= $1',
    [monthStart],
  );
  const platform = addressOf(provisioner, {});
  const addresses = [...new Set([...known.map((r) => r.address), ...(platform ? [platform] : [])])];
  const { rows: stores } = await pool.query<{ id: string; addresses: string[]; sent: number | null }>(
    `SELECT t.id, array_agg(s.address ORDER BY s.address) AS addresses, u.sent
       FROM tenants t
       JOIN tenant_mail_senders s ON s.tenant_id = t.id AND (s.last_used IS NULL OR s.last_used >= $1)
       LEFT JOIN tenant_mail_usage u ON u.tenant_id = t.id AND u.month = $2
      WHERE t.status = $3 AND NOT t.is_suspended
      GROUP BY t.id, u.sent, u.checked_at
      ORDER BY u.checked_at NULLS FIRST, t.date_created, t.id`,
    [monthStart, month, Status.Done],
  );

  let requests = 0;
  const search = async (address: string, status?: string) => {
    if (requests++) await sleep(pauseMs);
    try {
      return await counter.countEmails({ search: address, from, ...(status && { status }) });
    } catch (err) {
      if (err instanceof ToSendError && err.status === 429) throw new RateLimited(err.message);
      throw err;
    }
  };
  const counts = new Map<string, number>();
  const count = async (address: string): Promise<number> => {
    const done = counts.get(address);
    if (done !== undefined) return done;
    let total = await search(address);
    if (total > 0) for (const status of NOT_SENT) total -= await search(address, status);
    const longer = addresses.filter((a) => a !== address && a.includes(address)).sort((a, b) => b.length - a.length);
    for (const other of longer) if (total > 0) total -= await count(other);
    // Counts read moments apart can disagree by an email or two.
    counts.set(address, Math.max(0, total));
    return counts.get(address)!;
  };

  let counted = 0;
  let pushed = 0;
  for (const store of stores) {
    let sent = 0;
    try {
      for (const address of store.addresses) sent += await count(address);
    } catch (err) {
      if (err instanceof RateLimited) {
        log.error(`Mail count: toSend's rate limit reached after ${counted} of ${stores.length} stores; the rest are counted next hour`);
        return { counted, pushed, stopped: true };
      }
      log.error(`Store ${store.id}: email not counted: ${(err as Error).message}`);
      continue;
    }
    counted++;
    if (sent !== (store.sent ?? 0)) {
      try {
        await provisioner.setMailCount({ storeId: store.id, month, sent });
        pushed++;
      } catch (err) {
        log.error(`Store ${store.id}: email count ${sent} not sent to the store: ${(err as Error).message}`);
        continue;
      }
    }
    await pool.query(
      `INSERT INTO tenant_mail_usage (tenant_id, month, sent, checked_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, month) DO UPDATE SET sent = EXCLUDED.sent, checked_at = EXCLUDED.checked_at`,
      [store.id, month, sent],
    );
  }
  return { counted, pushed, stopped: false };
}

/** Runs countStoreMail every hour when toSend is set up (TOSEND_ADMIN_KEY). */
export async function startMailCounts(boss: PgBoss, pool: Pool, counter: MailCounter | undefined, provisioner: Provisioner): Promise<void> {
  if (!counter) {
    if (await boss.getQueue(MAIL_COUNT_QUEUE)) await boss.unschedule(MAIL_COUNT_QUEUE);
    return;
  }
  if (!(await boss.getQueue(MAIL_COUNT_QUEUE))) await boss.createQueue(MAIL_COUNT_QUEUE, { retryLimit: 0, expireInSeconds: 3600 });
  await boss.schedule(MAIL_COUNT_QUEUE, '0 * * * *');
  await boss.work(MAIL_COUNT_QUEUE, { pollingIntervalSeconds: 60 }, async () => {
    await countStoreMail(pool, counter, provisioner);
  });
}

/** This month's platform count of the store's email, for the dashboard; null before the first count. */
export async function mailUsage(pool: Pool, tenantId: string, now = new Date()) {
  const { rows } = await pool.query('SELECT month, sent, checked_at FROM tenant_mail_usage WHERE tenant_id = $1 AND month = $2', [
    tenantId,
    now.toISOString().slice(0, 7),
  ]);
  return rows[0] ? { month: rows[0].month as string, sent: rows[0].sent as number, checkedAt: (rows[0].checked_at as Date).toISOString() } : null;
}

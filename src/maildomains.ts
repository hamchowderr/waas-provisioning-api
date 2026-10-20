import type { PgBoss } from 'pg-boss';
import type { Pool } from './db.ts';
import { badRequest } from './errors.ts';
import { ensureStoreSender, type MailboxDomains } from './mailcount.ts';
import type { Provisioner, StoreSender } from './provisioner/provisioner.ts';
import { Status } from './status.ts';
import { normalizeDomain } from './tenants.ts';
import type { DnsRecord, SendingDomains } from './tosend.ts';

/**
 * A store's own sending domain (docs/store-email.md). Adding one registers it on toSend and
 * returns the DNS records its owner adds at their DNS host. toSend checks DNS every 10 minutes;
 * checkMailDomains, on the same cadence, moves a store to its domain once toSend has verified it,
 * and back to the platform's address when the domain is removed. Until then the store keeps
 * sending from the platform's address, so its email never stops.
 */

export const MAIL_DOMAINS_QUEUE = 'mail-domains';

export interface MailDomain {
  domainName: string;
  /** pending (waiting for the DNS records), verified (the store sends from it) or removing. */
  status: string;
  dateCreated: string;
  dateVerified: string | null;
  /** The records to add, from toSend; null when toSend could not be reached. */
  records: DnsRecord[] | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function rowOf(pool: Pool, tenantId: string): Promise<Row | undefined> {
  const { rows } = await pool.query('SELECT * FROM tenant_mail_domains WHERE tenant_id = $1', [tenantId]);
  return rows[0];
}

async function present(domains: SendingDomains, row: Row): Promise<MailDomain> {
  const records = await domains.getDomain(row.tosend_domain_id).then(
    (d) => d.records,
    (err: unknown) => {
      console.error(`toSend domain ${row.domain_name} not read: ${(err as Error).message}`);
      return null;
    },
  );
  return {
    domainName: row.domain_name,
    status: row.status,
    dateCreated: new Date(row.date_created).toISOString(),
    dateVerified: row.date_verified ? new Date(row.date_verified).toISOString() : null,
    records,
  };
}

function need(domains: SendingDomains | undefined): SendingDomains {
  if (!domains) throw badRequest('Stores sending from their own domain needs TOSEND_ADMIN_KEY on the API');
  return domains;
}

/** The store's sending domain with its DNS records, or null when it sends from the platform's address. */
export async function getMailDomain(pool: Pool, domains: SendingDomains | undefined, tenantId: string): Promise<MailDomain | null> {
  const row = await rowOf(pool, tenantId);
  return row ? present(need(domains), row) : null;
}

/**
 * Gives the store its own sending domain: registered on toSend now, used once verified. A store has
 * one; setting the one it already has returns it, and a different one must be removed first.
 * `platformFrom` is the platform's sender (STORE_MAIL_FROM), whose domain stores can't take.
 */
export async function setMailDomain(pool: Pool, domains: SendingDomains | undefined, tenantId: string, domainName: string, platformFrom: string): Promise<MailDomain> {
  const sending = need(domains);
  const name = normalizeDomain(domainName);
  const platform = platformFrom.split('@')[1]!.toLowerCase();
  if (name === platform || name.endsWith(`.${platform}`)) throw badRequest(`${name} belongs to the platform; use a domain the store owns`);
  const existing = await rowOf(pool, tenantId);
  if (existing) {
    if (existing.status === 'removing') throw badRequest(`${existing.domain_name} is still being removed from this store; try again in a few minutes`);
    if (existing.domain_name === name) return present(sending, existing);
    throw badRequest(`This store already has the sending domain ${existing.domain_name}; remove it first`);
  }
  const { rowCount } = await pool.query('SELECT 1 FROM tenant_mail_domains WHERE domain_name = $1', [name]);
  if (rowCount) throw badRequest(`${name} is already another store's sending domain`);

  const domain = await sending.addDomain(name).catch((err: unknown) => {
    throw badRequest(`toSend did not add ${name}: ${(err as Error).message}`);
  });
  const { rows } = await pool.query(
    `INSERT INTO tenant_mail_domains (tenant_id, domain_name, tosend_domain_id, status, date_verified)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'verified' THEN now() END) RETURNING *`,
    [tenantId, name, domain.id, domain.status === 'verified' ? 'verified' : 'pending'],
  );
  return { ...(await present(sending, rows[0])), records: domain.records };
}

/** Moves the store back to the platform's address (on the next check) and drops its domain. */
export async function removeMailDomain(pool: Pool, tenantId: string): Promise<{ domainName: string } | null> {
  const { rows } = await pool.query("UPDATE tenant_mail_domains SET status = 'removing' WHERE tenant_id = $1 RETURNING domain_name", [tenantId]);
  return rows[0] ? { domainName: rows[0].domain_name } : null;
}

/** The verified sending domain of each live store that has one, or of `tenantId` only, by store id (for maintainStores). */
export async function storeSenders(pool: Pool, tenantId?: string): Promise<Map<string, StoreSender>> {
  const { rows } = await pool.query(
    "SELECT tenant_id, domain_name, tosend_domain_id FROM tenant_mail_domains WHERE status = 'verified' AND tenant_id IS NOT NULL AND ($1::uuid IS NULL OR tenant_id = $1)",
    [tenantId ?? null],
  );
  return new Map(rows.map((r) => [r.tenant_id, { domain: r.domain_name, domainId: r.tosend_domain_id }]));
}

/**
 * One pass over every sending domain: a pending one toSend now reports verified becomes verified;
 * a live store with a verified domain sends from it (a no-op once it does); a removed one moves its
 * store back, to its mailbox at the platform's domain (`mailboxDomains`, src/mailcount.ts), and leaves
 * toSend; a deleted store's leaves toSend. A failure is logged and retried on the next pass.
 */
export async function checkMailDomains(
  pool: Pool,
  domains: SendingDomains,
  provisioner: Provisioner,
  mailboxDomains: MailboxDomains,
  log: Pick<Console, 'log' | 'error'> = console,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT m.*, t.status AS tenant_status FROM tenant_mail_domains m LEFT JOIN tenants t ON t.id = m.tenant_id ORDER BY m.date_created`,
  );
  for (const row of rows) {
    const live = row.tenant_id && row.tenant_status === Status.Done;
    try {
      if (!row.tenant_id || row.status === 'removing') {
        if (row.tenant_id) {
          if (!live) continue; // Moved back once the store is live again.
          const result = await ensureStoreSender(pool, provisioner, mailboxDomains, row.tenant_id);
          if (result !== 'unchanged') log.log(`Store ${row.tenant_id}: back on the platform's address`);
        }
        await domains.deleteDomain(row.tosend_domain_id);
        await pool.query('DELETE FROM tenant_mail_domains WHERE id = $1', [row.id]);
        continue;
      }
      if (row.status === 'pending') {
        const domain = await domains.getDomain(row.tosend_domain_id);
        if (domain.status !== 'verified') continue;
        await pool.query("UPDATE tenant_mail_domains SET status = 'verified', date_verified = now() WHERE id = $1", [row.id]);
        log.log(`Sending domain ${row.domain_name} verified`);
      }
      if (!live) continue;
      const result = await ensureStoreSender(pool, provisioner, mailboxDomains, row.tenant_id, { domain: row.domain_name, domainId: row.tosend_domain_id });
      if (result !== 'unchanged') log.log(`Store ${row.tenant_id}: sending from ${row.domain_name}`);
    } catch (err) {
      log.error(`Sending domain ${row.domain_name}: not checked: ${(err as Error).message}`);
    }
  }
}

/** Runs checkMailDomains every 10 minutes (toSend's own DNS check cadence) when toSend is set up. */
export async function startMailDomainChecks(
  boss: PgBoss,
  pool: Pool,
  domains: SendingDomains | undefined,
  provisioner: Provisioner,
  mailboxDomains: MailboxDomains,
): Promise<void> {
  if (!domains) {
    if (await boss.getQueue(MAIL_DOMAINS_QUEUE)) await boss.unschedule(MAIL_DOMAINS_QUEUE);
    return;
  }
  if (!(await boss.getQueue(MAIL_DOMAINS_QUEUE))) await boss.createQueue(MAIL_DOMAINS_QUEUE, { retryLimit: 0, expireInSeconds: 3600 });
  await boss.schedule(MAIL_DOMAINS_QUEUE, '*/10 * * * *');
  await boss.work(MAIL_DOMAINS_QUEUE, { pollingIntervalSeconds: 60 }, () => checkMailDomains(pool, domains, provisioner, mailboxDomains));
}

/**
 * The parts of toSend's admin API (admin keys `tsend_admin_…`) the API uses, through toSend's
 * official SDK (the `tosend` package): one sending key per store, restricted to the platform's
 * sending domain or to the store's own one, the stores' own sending domains, and counts of the
 * emails sent (docs/store-email.md).
 */
import { ToSendAdmin as ToSendSdk, ToSendError as SdkError } from 'tosend';

export interface StoreMailKey {
  id: string;
  key: string;
}

/** Mints and revokes each store's own relay password. */
export interface StoreMailKeys {
  /** A key restricted to `domainId` (a toSend domain id), or to the platform's sending domain. */
  create(storeId: string, domainId?: string): Promise<StoreMailKey>;
  delete(id: string): Promise<void>;
}

/** One record the domain's owner adds at their DNS host. `name` is relative to the domain. */
export interface DnsRecord {
  type: string;
  name: string;
  /** The full hostname: `name` under the domain. */
  host: string;
  value: string;
  priority: number | null;
}

export interface SendingDomain {
  id: string;
  name: string;
  /** toSend's verification_status: `verified` once its records resolve (it checks every 10 minutes). */
  status: string;
  records: DnsRecord[];
}

/** A store's own sending domain on toSend. */
export interface SendingDomains {
  /** Adds the domain, or returns it when this account already has it. */
  addDomain(name: string): Promise<SendingDomain>;
  getDomain(id: string): Promise<SendingDomain>;
  /** Removes it from toSend; one already gone is fine. The owner's DNS records are untouched. */
  deleteDomain(id: string): Promise<void>;
}

export interface EmailCountQuery {
  /**
   * Matched anywhere in the subject, the sender's address and the recipients, ignoring case: an
   * address also matches every longer address that contains it (src/mailcount.ts corrects for that).
   */
  search: string;
  /** Only emails sent since then (ISO 8601). */
  from: string;
  /** pending, sent, bounced, complained, suppressed, failed or spam; unset: all of them. */
  status?: string;
}

/** Counts the emails sent through toSend (the platform's count of each store's email, src/mailcount.ts). */
export interface MailCounter {
  countEmails(query: EmailCountQuery): Promise<number>;
}

type RawDomain = { id: string | number; domain_name?: string; verification_status?: string; dns_records?: unknown };

/** toSend's dns_records: named groups (dkim, spf, …), each one record or a list of them. */
function toRecords(domain: string, raw: unknown): DnsRecord[] {
  if (!raw || typeof raw !== 'object') return [];
  const groups = Array.isArray(raw) ? raw : Object.values(raw);
  return groups.flat().flatMap((r: any) => {
    if (!r || typeof r !== 'object' || !r.type) return [];
    const name = String(r.name ?? r.host ?? '@');
    const host = name === '@' || name === '' ? domain : name.endsWith(`.${domain}`) || name === domain ? name : `${name}.${domain}`;
    const priority = r.priority === '' || r.priority === null || r.priority === undefined ? null : Number(r.priority);
    return [{ type: String(r.type), name, host, value: String(r.content ?? r.value ?? ''), priority: Number.isFinite(priority) ? priority : null }];
  });
}

const domainName = (d: RawDomain) => (d.domain_name ?? '').toLowerCase();

export class ToSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ToSendAdmin implements StoreMailKeys, SendingDomains, MailCounter {
  private readonly sdk: ToSendSdk;
  private domainId?: string;

  constructor(
    adminKey: string,
    /** The verified domain store keys are restricted to, e.g. anypress.io. */
    private readonly domain: string,
    baseUrl?: string,
  ) {
    this.sdk = new ToSendSdk({ apiKey: adminKey, ...(baseUrl && { baseUrl }) });
  }

  /** Runs one SDK call, turning its errors into ours (with the HTTP status the callers check). */
  private async call<T>(what: string, run: (sdk: ToSendSdk) => Promise<T>): Promise<T> {
    try {
      return await run(this.sdk);
    } catch (err) {
      if (!(err instanceof SdkError)) throw err;
      throw new ToSendError(`toSend ${what}: HTTP ${err.code} ${err.message}`, err.code);
    }
  }

  /** The account's domain with this name, if it has one. */
  private async findDomain(name: string): Promise<RawDomain | undefined> {
    for (let page = 1; ; page++) {
      const res = await this.call('list domains', (sdk) => sdk.listDomains({ page, per_page: 100 }));
      const domains: RawDomain[] = res.data ?? [];
      const found = domains.find((d) => domainName(d) === name);
      if (found || domains.length < 100) return found;
    }
  }

  /** The sending domain's id, found by name once. */
  private async sendingDomainId(): Promise<string> {
    if (this.domainId) return this.domainId;
    const found = await this.findDomain(this.domain);
    if (!found) throw new Error(`toSend has no sending domain ${this.domain}; add and verify it first`);
    return (this.domainId = String(found.id));
  }

  async create(storeId: string, domainId?: string): Promise<StoreMailKey> {
    const domain = domainId ?? (await this.sendingDomainId());
    const key = await this.call('create sending key', (sdk) => sdk.createSendingKey(`store-${storeId}`, domain));
    if (!key?.api_key) throw new Error('toSend created a sending key but returned no key');
    return { id: String(key.id), key: key.api_key };
  }

  /** Revokes a store's key; one already gone is fine. */
  async delete(id: string): Promise<void> {
    await this.gone(`delete sending key ${id}`, (sdk) => sdk.deleteSendingKey(Number(id)));
  }

  async addDomain(name: string): Promise<SendingDomain> {
    let id: string;
    try {
      const created = await this.call('add domain', (sdk) => sdk.createDomain(name));
      if (created?.id === undefined) throw new Error('toSend added the domain but returned no id');
      id = String(created.id);
    } catch (err) {
      // 409: names are unique across toSend. Ours (a retry after a timeout) is read back; another
      // account's can't be used.
      if (!(err instanceof ToSendError && err.status === 409)) throw err;
      const found = await this.findDomain(name);
      if (!found) throw new ToSendError(`${name} is already set up on another toSend account`, 409);
      id = String(found.id);
    }
    return this.getDomain(id);
  }

  async getDomain(id: string): Promise<SendingDomain> {
    const d: RawDomain | undefined = await this.call(`get domain ${id}`, (sdk) => sdk.getDomain(id));
    if (!d) throw new Error(`toSend returned no domain ${id}`);
    const name = domainName(d);
    return { id: String(d.id), name, status: d.verification_status ?? 'unknown', records: toRecords(name, d.dns_records) };
  }

  async deleteDomain(id: string): Promise<void> {
    await this.gone(`delete domain ${id}`, (sdk) => sdk.deleteDomain(id));
  }

  /** A delete where a 404 (already gone) counts as done. */
  private async gone(what: string, run: (sdk: ToSendSdk) => Promise<void>): Promise<void> {
    try {
      await this.call(what, run);
    } catch (err) {
      if (!(err instanceof ToSendError && err.status === 404)) throw err;
    }
  }

  /**
   * One page of one email is enough: toSend's `total` is the count of every match. Searches count
   * against toSend's write limit (300 a minute; 429 past it).
   */
  async countEmails({ search, from, status }: EmailCountQuery): Promise<number> {
    const res = await this.call('count emails', (sdk) => sdk.listEmails({ page: 1, per_page: 1, search, from, ...(status && { status }) }));
    const total = Number(res?.total);
    if (res?.total === undefined || !Number.isInteger(total) || total < 0) throw new Error('toSend returned no email count');
    return total;
  }
}

/**
 * The parts of toSend's admin API (https://api.tosend.com, admin keys `tsend_admin_…`) the API
 * uses: one sending key per store, restricted to the platform's sending domain or to the store's
 * own one, the stores' own sending domains, and counts of the emails sent (docs/store-email.md).
 * Paths and fields follow toSend's official SDKs.
 */
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawDomain = { id: string | number; domain_name?: string; name?: string; verification_status?: string; dns_records?: any };

/** toSend's dns_records: named groups (dkim, spf, …), each one record or a list of them. */
function toRecords(domain: string, raw: unknown): DnsRecord[] {
  if (!raw || typeof raw !== 'object') return [];
  const groups = Array.isArray(raw) ? raw : Object.values(raw);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return groups.flat().flatMap((r: any) => {
    if (!r || typeof r !== 'object' || !r.type) return [];
    const name = String(r.name ?? r.host ?? '@');
    const host = name === '@' || name === '' ? domain : name.endsWith(`.${domain}`) || name === domain ? name : `${name}.${domain}`;
    const priority = r.priority === '' || r.priority === null || r.priority === undefined ? null : Number(r.priority);
    return [{ type: String(r.type), name, host, value: String(r.content ?? r.value ?? ''), priority: Number.isFinite(priority) ? priority : null }];
  });
}

const domainName = (d: RawDomain) => (d.domain_name ?? d.name ?? '').toLowerCase();

export class ToSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ToSendAdmin implements StoreMailKeys, SendingDomains, MailCounter {
  private domainId?: string;

  constructor(
    private readonly adminKey: string,
    /** The verified domain store keys are restricted to, e.g. anypress.io. */
    private readonly domain: string,
    private readonly baseUrl = 'https://api.tosend.com',
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.adminKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const error = json.error as { message?: string } | string | undefined;
      const message = typeof error === 'string' ? error : (error?.message ?? (json.message as string | undefined) ?? res.statusText);
      throw new ToSendError(`toSend ${method} ${path}: HTTP ${res.status} ${message}`, res.status);
    }
    return json as T;
  }

  /** The account's domain with this name, if it has one. */
  private async findDomain(name: string): Promise<RawDomain | undefined> {
    for (let page = 1; ; page++) {
      const res = await this.request<{ data?: RawDomain[] }>('GET', `/v2/domains?page=${page}&per_page=100`);
      const domains = res.data ?? [];
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
    const res = await this.request<{ data?: { id: string | number; api_key?: string } }>('POST', '/v2/api-keys', { name: `store-${storeId}`, domain });
    if (!res.data?.api_key) throw new Error('toSend created a sending key but returned no key');
    return { id: String(res.data.id), key: res.data.api_key };
  }

  /** Revokes a store's key; one already gone is fine. */
  async delete(id: string): Promise<void> {
    try {
      await this.request('DELETE', `/v2/api-keys/${encodeURIComponent(id)}`);
    } catch (err) {
      if (!(err instanceof ToSendError && err.status === 404)) throw err;
    }
  }

  async addDomain(name: string): Promise<SendingDomain> {
    let id: string;
    try {
      const res = await this.request<{ data?: RawDomain }>('POST', '/v2/domains', { name });
      if (res.data?.id === undefined) throw new Error('toSend added the domain but returned no id');
      id = String(res.data.id);
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
    const res = await this.request<{ data?: RawDomain }>('GET', `/v2/domains/${encodeURIComponent(id)}`);
    const d = res.data;
    if (!d) throw new Error(`toSend returned no domain ${id}`);
    const name = domainName(d);
    return { id: String(d.id), name, status: d.verification_status ?? 'unknown', records: toRecords(name, d.dns_records) };
  }

  async deleteDomain(id: string): Promise<void> {
    try {
      await this.request('DELETE', `/v2/domains/${encodeURIComponent(id)}`);
    } catch (err) {
      if (!(err instanceof ToSendError && err.status === 404)) throw err;
    }
  }

  /**
   * One page of one email is enough: toSend's `total` is the count of every match. Searches count
   * against toSend's write limit (300 a minute; 429 past it).
   */
  async countEmails({ search, from, status }: EmailCountQuery): Promise<number> {
    const query = new URLSearchParams({ page: '1', per_page: '1', search, from, ...(status && { status }) });
    const res = await this.request<{ total?: number | string }>('GET', `/v2/emails?${query}`);
    const total = Number(res.total);
    if (res.total === undefined || !Number.isInteger(total) || total < 0) throw new Error('toSend returned no email count');
    return total;
  }
}

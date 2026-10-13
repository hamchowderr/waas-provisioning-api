/**
 * The parts of toSend's admin API (https://api.tosend.com, admin keys `tsend_admin_…`) the API
 * uses: one sending key per store, restricted to the platform's sending domain
 * (docs/store-email.md). Paths and fields follow toSend's official SDKs.
 */
export interface StoreMailKey {
  id: string;
  key: string;
}

/** Mints and revokes each store's own relay password. */
export interface StoreMailKeys {
  create(storeId: string): Promise<StoreMailKey>;
  delete(id: string): Promise<void>;
}

export class ToSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ToSendAdmin implements StoreMailKeys {
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

  /** The sending domain's id, found by name once. */
  private async sendingDomainId(): Promise<string> {
    if (this.domainId) return this.domainId;
    for (let page = 1; ; page++) {
      const res = await this.request<{ data?: { id: string | number; name: string }[] }>('GET', `/v2/domains?page=${page}&per_page=100`);
      const domains = res.data ?? [];
      const found = domains.find((d) => d.name.toLowerCase() === this.domain);
      if (found) return (this.domainId = String(found.id));
      if (domains.length < 100) throw new Error(`toSend has no sending domain ${this.domain}; add and verify it first`);
    }
  }

  async create(storeId: string): Promise<StoreMailKey> {
    const domain = await this.sendingDomainId();
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
}

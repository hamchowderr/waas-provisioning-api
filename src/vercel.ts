/**
 * The few Vercel REST calls that put a seller's own dashboard address on the dashboard's Vercel
 * project (src/dashboarddomains.ts): add, look up, verify and remove a project domain, and read
 * whether its DNS points at Vercel. VERCEL_TOKEN needs access to the project's team.
 */

/** A DNS record the domain's owner adds. name is the full hostname; most DNS hosts want only the part before their domain. */
export interface DnsRecord {
  type: 'CNAME' | 'A' | 'TXT';
  name: string;
  value: string;
}

/** Where a domain stands on the host: whether it is ours to serve, and whether its DNS reaches us. */
export interface HostDomainState {
  /** Ownership is proven (Vercel asks for a TXT record when another account used the domain before). */
  verified: boolean;
  /** DNS points at the host, so it can serve the address and issue its certificate. */
  configured: boolean;
  /** What to add at the domain's DNS host for both; empty once nothing is missing. */
  records: DnsRecord[];
}

/** Puts dashboard addresses on whatever serves the dashboard. Vercel today; Coolify later. */
export interface DashboardHost {
  readonly name: string;
  /** Adds the domain (a no-op when it is already there) and answers where it stands. */
  add(domain: string): Promise<HostDomainState>;
  /** Asks the host to check again, and answers where the domain stands. */
  check(domain: string): Promise<HostDomainState>;
  /** Removes the domain; a domain already gone is fine. */
  remove(domain: string): Promise<void>;
}

export interface VercelConfig {
  token: string;
  projectId: string;
  teamId?: string;
  apiUrl?: string;
}

export class VercelError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

interface VercelProjectDomain {
  name: string;
  verified: boolean;
  verification?: { type: string; domain: string; value: string; reason?: string }[];
}

interface VercelDomainConfig {
  misconfigured: boolean;
  recommendedCNAME?: { rank: number; value: string }[];
  recommendedIPv4?: { rank: number; value: string[] }[];
}

export class VercelDomains implements DashboardHost {
  readonly name = 'vercel';
  private readonly api: string;

  constructor(
    private readonly config: VercelConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.api = (config.apiUrl ?? 'https://api.vercel.com').replace(/\/+$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown, { allow404 = false } = {}): Promise<T | null> {
    const url = new URL(this.api + path);
    if (this.config.teamId) url.searchParams.set('teamId', this.config.teamId);
    const res = await this.fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${this.config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (allow404 && res.status === 404) return null;
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = text ? JSON.parse(text) : null;
    if (!res.ok) throw new VercelError(res.status, json?.error?.code, json?.error?.message ?? `Vercel answered ${res.status}`);
    return json as T;
  }

  private project(domain?: string) {
    const base = `/projects/${encodeURIComponent(this.config.projectId)}/domains`;
    return domain ? `${base}/${encodeURIComponent(domain)}` : base;
  }

  private async state(domain: VercelProjectDomain): Promise<HostDomainState> {
    const config = (await this.call<VercelDomainConfig>('GET', `/v6/domains/${encodeURIComponent(domain.name)}/config`))!;
    const records: DnsRecord[] = [];
    if (config.misconfigured) {
      const apex = domain.name.split('.').length <= 2;
      const ip = config.recommendedIPv4?.sort((a, b) => a.rank - b.rank)[0]?.value[0] ?? '76.76.21.21';
      const cname = config.recommendedCNAME?.sort((a, b) => a.rank - b.rank)[0]?.value ?? 'cname.vercel-dns.com';
      records.push(apex ? { type: 'A', name: domain.name, value: ip } : { type: 'CNAME', name: domain.name, value: cname.replace(/\.$/, '') });
    }
    if (!domain.verified) {
      for (const v of domain.verification ?? []) {
        if (v.type === 'TXT') records.push({ type: 'TXT', name: v.domain, value: v.value });
      }
    }
    return { verified: domain.verified, configured: !config.misconfigured, records };
  }

  async add(domain: string): Promise<HostDomainState> {
    let found = await this.call<VercelProjectDomain>('GET', `/v9${this.project(domain)}`, undefined, { allow404: true });
    found ??= (await this.call<VercelProjectDomain>('POST', `/v10${this.project()}`, { name: domain }))!;
    return this.state(found);
  }

  async check(domain: string): Promise<HostDomainState> {
    let found = await this.call<VercelProjectDomain>('GET', `/v9${this.project(domain)}`, undefined, { allow404: true });
    if (!found) return this.add(domain);
    if (!found.verified) {
      // Vercel answers 400 while the TXT record is missing; the state below says what to add.
      try {
        found = (await this.call<VercelProjectDomain>('POST', `/v9${this.project(domain)}/verify`)) ?? found;
      } catch (err) {
        if (!(err instanceof VercelError) || err.status !== 400) throw err;
      }
    }
    return this.state(found);
  }

  async remove(domain: string): Promise<void> {
    await this.call('DELETE', `/v9${this.project(domain)}`, undefined, { allow404: true });
  }
}

/**
 * DASHBOARD_DOMAINS=vercel puts dashboard addresses on the Vercel project VERCEL_PROJECT_ID (team
 * VERCEL_TEAM_ID) with VERCEL_TOKEN. off (the default) turns the feature off.
 */
export function loadDashboardHost(env: NodeJS.ProcessEnv): DashboardHost | undefined {
  const mode = env.DASHBOARD_DOMAINS?.trim() || 'off';
  if (mode === 'off') return undefined;
  if (mode !== 'vercel') throw new Error('DASHBOARD_DOMAINS must be vercel or off');
  const token = env.VERCEL_TOKEN?.trim();
  const projectId = env.VERCEL_PROJECT_ID?.trim();
  if (!token || !projectId) throw new Error('DASHBOARD_DOMAINS=vercel needs VERCEL_TOKEN and VERCEL_PROJECT_ID');
  return new VercelDomains({ token, projectId, teamId: env.VERCEL_TEAM_ID?.trim() || undefined, apiUrl: env.VERCEL_API_URL?.trim() || undefined });
}

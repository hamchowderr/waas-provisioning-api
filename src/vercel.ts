import { Vercel } from '@vercel/sdk';
import { HTTPClient } from '@vercel/sdk/lib/http.js';
import { VercelError as VercelSdkError } from '@vercel/sdk/models/vercelerror.js';
import { CoolifyDashboardDomains } from './coolifydashboard.ts';

/**
 * The few Vercel calls (its official SDK) that put a seller's own dashboard address on the dashboard's Vercel
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
  verification?: { type: string; domain: string; value: string; reason?: string }[] | undefined;
}

/** The SDK's error for a failed call: its HTTP status and Vercel's own error code and message. */
function vercelError(err: unknown): VercelError | unknown {
  if (!(err instanceof VercelSdkError) || (err.statusCode >= 200 && err.statusCode < 300)) return err;
  let code: string | undefined;
  let message = err.message;
  try {
    const body = JSON.parse(err.body) as { error?: { code?: string; message?: string } };
    code = body.error?.code;
    message = body.error?.message ?? `Vercel answered ${err.statusCode}`;
  } catch {
    // Not JSON: keep the SDK's message.
  }
  return new VercelError(err.statusCode, code, message);
}

/** Vercel's project domains through its official SDK (@vercel/sdk). */
export class VercelDomains implements DashboardHost {
  readonly name = 'vercel';
  private readonly vercel: Vercel;

  constructor(
    private readonly config: VercelConfig,
    fetchFn: typeof fetch = fetch,
  ) {
    this.vercel = new Vercel({
      bearerToken: config.token,
      serverURL: config.apiUrl?.replace(/\/+$/, ''),
      timeoutMs: 20_000,
      httpClient: new HTTPClient({ fetcher: (input, init) => fetchFn(input, init) }),
    });
  }

  private get scope() {
    return { idOrName: this.config.projectId, ...(this.config.teamId ? { teamId: this.config.teamId } : {}) };
  }

  private async call<T>(run: () => Promise<T>, { allow404 = false } = {}): Promise<T | null> {
    try {
      return await run();
    } catch (err) {
      const e = vercelError(err);
      if (allow404 && e instanceof VercelError && e.status === 404) return null;
      throw e;
    }
  }

  private async state(domain: VercelProjectDomain): Promise<HostDomainState> {
    const config = (await this.call(() =>
      this.vercel.domains.getDomainConfig({ domain: domain.name, ...(this.config.teamId ? { teamId: this.config.teamId } : {}) }),
    ))!;
    const records: DnsRecord[] = [];
    if (config.misconfigured) {
      const apex = domain.name.split('.').length <= 2;
      const ip = [...(config.recommendedIPv4 ?? [])].sort((a, b) => a.rank - b.rank)[0]?.value[0] ?? '76.76.21.21';
      const cname = [...(config.recommendedCNAME ?? [])].sort((a, b) => a.rank - b.rank)[0]?.value ?? 'cname.vercel-dns.com';
      records.push(apex ? { type: 'A', name: domain.name, value: ip } : { type: 'CNAME', name: domain.name, value: cname.replace(/\.$/, '') });
    }
    if (!domain.verified) {
      for (const v of domain.verification ?? []) {
        if (v.type === 'TXT') records.push({ type: 'TXT', name: v.domain, value: v.value });
      }
    }
    return { verified: domain.verified, configured: !config.misconfigured, records };
  }

  private find(domain: string): Promise<VercelProjectDomain | null> {
    return this.call(() => this.vercel.projects.getProjectDomain({ ...this.scope, domain }), { allow404: true });
  }

  async add(domain: string): Promise<HostDomainState> {
    let found = await this.find(domain);
    found ??= (await this.call(() => this.vercel.projects.addProjectDomain({ ...this.scope, requestBody: { name: domain } })))!;
    return this.state(found);
  }

  async check(domain: string): Promise<HostDomainState> {
    let found = await this.find(domain);
    if (!found) return this.add(domain);
    if (!found.verified) {
      // Vercel answers 400 while the TXT record is missing; the state below says what to add.
      try {
        found = (await this.call(() => this.vercel.projects.verifyProjectDomain({ ...this.scope, domain }))) ?? found;
      } catch (err) {
        if (!(err instanceof VercelError) || err.status !== 400) throw err;
      }
    }
    return this.state(found);
  }

  async remove(domain: string): Promise<void> {
    await this.call(() => this.vercel.projects.removeProjectDomain({ ...this.scope, domain }), { allow404: true });
  }
}

/**
 * DASHBOARD_DOMAINS=vercel puts dashboard addresses on the Vercel project VERCEL_PROJECT_ID (team
 * VERCEL_TEAM_ID) with VERCEL_TOKEN. coolify puts them on the Coolify application
 * DASHBOARD_COOLIFY_APP (COOLIFY_URL, COOLIFY_TOKEN), and sellers point them at DASHBOARD_TARGET.
 * off (the default) turns the feature off.
 */
export function loadDashboardHost(env: NodeJS.ProcessEnv): DashboardHost | undefined {
  const mode = env.DASHBOARD_DOMAINS?.trim() || 'off';
  if (mode === 'off') return undefined;
  if (mode === 'coolify') {
    const url = env.COOLIFY_URL?.trim();
    const token = env.COOLIFY_TOKEN?.trim();
    const appUuid = env.DASHBOARD_COOLIFY_APP?.trim();
    const target = env.DASHBOARD_TARGET?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/.]+$/, '');
    if (!url || !token || !appUuid || !target) throw new Error('DASHBOARD_DOMAINS=coolify needs COOLIFY_URL, COOLIFY_TOKEN, DASHBOARD_COOLIFY_APP and DASHBOARD_TARGET');
    return new CoolifyDashboardDomains({ url, token, appUuid, target });
  }
  if (mode !== 'vercel') throw new Error('DASHBOARD_DOMAINS must be vercel, coolify or off');
  const token = env.VERCEL_TOKEN?.trim();
  const projectId = env.VERCEL_PROJECT_ID?.trim();
  if (!token || !projectId) throw new Error('DASHBOARD_DOMAINS=vercel needs VERCEL_TOKEN and VERCEL_PROJECT_ID');
  return new VercelDomains({ token, projectId, teamId: env.VERCEL_TEAM_ID?.trim() || undefined, apiUrl: env.VERCEL_API_URL?.trim() || undefined });
}

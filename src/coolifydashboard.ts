import { resolve4, resolveCname } from 'node:dns/promises';
import type { DashboardHost, DnsRecord, HostDomainState } from './vercel.ts';

/**
 * Sellers' own dashboard addresses for a dashboard that runs as a Coolify application (a self-hosted
 * install, docs/self-hosting.md): each address is added to the application's domains once its DNS
 * points at the dashboard, and the application is deployed again so its proxy serves the address and
 * gets the certificate from Let's Encrypt. Adding it before the DNS is right would only make
 * Let's Encrypt fail and count against its limits.
 */

export interface CoolifyDashboardConfig {
  url: string;
  token: string;
  /** The dashboard's Coolify application. */
  appUuid: string;
  /** Where sellers point their address: the dashboard's own hostname (CNAME target). */
  target: string;
}

/** DNS lookups; tests replace them. */
export interface DashboardDns {
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
}

const systemDns: DashboardDns = { resolveCname, resolve4 };

export class CoolifyDashboardDomains implements DashboardHost {
  readonly name = 'coolify';
  private readonly api: string;

  constructor(
    private readonly config: CoolifyDashboardConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly dns: DashboardDns = systemDns,
  ) {
    this.api = `${config.url.replace(/\/+$/, '')}/api/v1`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(this.api + path, {
      method,
      headers: { Authorization: `Bearer ${this.config.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Coolify answered ${res.status} to ${method} ${path.replace(/\?.*/, '')}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** The application's domains, as hostnames. */
  private async domains(): Promise<string[]> {
    const app = await this.call<{ fqdn?: string | null }>('GET', `/applications/${this.config.appUuid}`);
    return (app.fqdn ?? '').split(',').map((u) => u.trim()).filter(Boolean).map((u) => new URL(u.includes('://') ? u : `https://${u}`).host);
  }

  /** Sets the application's domains and deploys it, so its proxy picks them up. */
  private async setDomains(hosts: string[]) {
    await this.call('PATCH', `/applications/${this.config.appUuid}`, { domains: hosts.map((h) => `https://${h}`).join(',') });
    await this.call('POST', `/deploy?uuid=${encodeURIComponent(this.config.appUuid)}&force=false`);
  }

  /** Whether `domain` reaches the dashboard: a CNAME to the target, or the target's addresses. */
  private async points(domain: string): Promise<boolean> {
    const target = this.config.target.toLowerCase();
    const cname = await this.dns.resolveCname(domain).catch(() => [] as string[]);
    if (cname.some((c) => c.toLowerCase().replace(/\.$/, '') === target)) return true;
    const [mine, theirs] = await Promise.all([this.dns.resolve4(domain).catch(() => [] as string[]), this.dns.resolve4(target).catch(() => [] as string[])]);
    return mine.length > 0 && mine.every((ip) => theirs.includes(ip));
  }

  private state(domain: string, configured: boolean): HostDomainState {
    const records: DnsRecord[] = configured ? [] : [{ type: 'CNAME', name: domain, value: this.config.target }];
    return { verified: true, configured, records };
  }

  async add(domain: string): Promise<HostDomainState> {
    return this.check(domain);
  }

  async check(domain: string): Promise<HostDomainState> {
    if (!(await this.points(domain))) return this.state(domain, false);
    const hosts = await this.domains();
    if (!hosts.includes(domain)) await this.setDomains([...hosts, domain]);
    return this.state(domain, true);
  }

  async remove(domain: string): Promise<void> {
    const hosts = await this.domains();
    if (hosts.includes(domain)) await this.setDomains(hosts.filter((h) => h !== domain));
  }
}

import { createSign } from 'node:crypto';
import { resolve4, resolveTxt } from 'node:dns/promises';
import type { Pool } from './db.ts';
import { badRequest } from './errors.ts';
import { getMailDomain } from './maildomains.ts';
import { normalizeDomain } from './tenants.ts';
import type { SendingDomains } from './tosend.ts';

/**
 * Domain Connect (docs/domain-connect.md): a link that sends a store owner to their DNS host, which
 * adds a store's records for them after they approve. Works only at DNS hosts that support Domain
 * Connect and have accepted the platform's templates (domain-connect/*.json); for any other domain
 * the caller shows the records to copy by hand, as before.
 */

/** The two templates: the store's website (A record) and its sending domain (toSend's records). */
export type DomainConnectService = 'website' | 'email';
export const DOMAIN_CONNECT_SERVICES: DomainConnectService[] = ['website', 'email'];

export interface DomainConnectConfig {
  /** The templates' providerId: the platform's domain (anypress.io). */
  providerId: string;
  /** PEM RSA private key whose public half is published at `<keyHost>.<providerId>` (TXT); signs apply links. */
  privateKey?: string;
  keyHost: string;
}

export interface DomainConnectLink {
  /** The domain's DNS host, when it supports Domain Connect at all. */
  dnsProvider: string | null;
  /** True when that DNS host has the platform's template, so `url` works. */
  supported: boolean;
  /** Opens the DNS host's page that adds the records once the owner approves. */
  url: string | null;
}

interface Settings {
  providerName: string;
  providerDisplayName?: string;
  urlSyncUX?: string;
  urlAPI: string;
}

export interface DomainConnectNet {
  resolveTxt(name: string): Promise<string[][]>;
  resolve4(name: string): Promise<string[]>;
  fetch: typeof fetch;
}

const defaultNet: DomainConnectNet = { resolveTxt, resolve4, fetch: (...args) => fetch(...args) };

/** The zone a name sits in at a Domain Connect DNS host, and its settings there; null when none. */
async function discover(name: string, net: DomainConnectNet): Promise<{ zone: string; host: string; settings: Settings } | null> {
  const labels = name.split('.');
  // shop.example.com: try the full name, then example.com. A bare TLD is never a zone we can use.
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = labels.slice(i).join('.');
    const txt = await net.resolveTxt(`_domainconnect.${zone}`).catch(() => null);
    const target = txt?.map((r) => r.join('')).find((v) => /^[a-z0-9.-]+(\/[\w./-]*)?$/i.test(v));
    if (!target) continue;
    const res = await net.fetch(`https://${target}/v2/${zone}/settings`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res?.ok) return null;
    const settings = (await res.json().catch(() => null)) as Settings | null;
    if (!settings?.urlAPI || !settings.providerName) return null;
    return { zone, host: labels.slice(0, i).join('.'), settings };
  }
  return null;
}

/** RS256 signature of the query string, as the spec's "Digitally Sign Requests" section describes. */
function sign(query: string, privateKey: string): string {
  return createSign('RSA-SHA256').update(query).sign(privateKey, 'base64');
}

/**
 * Builds the apply link for `service` on `domainName`. Names and values come from the platform, never
 * from the caller, so a link can only ever point a domain at this platform.
 */
export async function domainConnectLink(
  config: DomainConnectConfig,
  domainName: string,
  service: DomainConnectService,
  variables: Record<string, string>,
  net: DomainConnectNet = defaultNet,
): Promise<DomainConnectLink> {
  const found = await discover(domainName, net);
  if (!found) return { dnsProvider: null, supported: false, url: null };
  const { zone, host, settings } = found;
  const dnsProvider = settings.providerDisplayName || settings.providerName;

  const template = `/v2/domainTemplates/providers/${encodeURIComponent(config.providerId)}/services/${service}`;
  const check = await net.fetch(`${settings.urlAPI.replace(/\/$/, '')}${template}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!check?.ok || !settings.urlSyncUX) return { dnsProvider, supported: false, url: null };

  const params = new URLSearchParams({ domain: zone, ...(host ? { host } : {}), ...variables });
  let query = params.toString();
  if (config.privateKey) query += `&sig=${encodeURIComponent(sign(query, config.privateKey))}&key=${encodeURIComponent(config.keyHost)}`;
  return { dnsProvider, supported: true, url: `${settings.urlSyncUX.replace(/\/$/, '')}${template}/apply?${query}` };
}

/**
 * The template variables for one of a store's domains: the website's server address, or the DKIM
 * key of its sending domain. Refuses a domain the store doesn't have.
 */
export async function storeVariables(
  pool: Pool,
  sendingDomains: SendingDomains | undefined,
  storesDomain: string,
  tenantId: string,
  domainName: string,
  service: DomainConnectService,
  net: DomainConnectNet = defaultNet,
): Promise<{ domain: string; variables: Record<string, string> }> {
  const domain = normalizeDomain(domainName);
  if (service === 'website') {
    const { rowCount } = await pool.query('SELECT 1 FROM tenant_domains WHERE tenant_id = $1 AND domain_name = $2', [tenantId, domain]);
    if (!rowCount) throw badRequest(`${domain} is not one of this store's domains`);
    // Custom domains point where the stores' own names do; the wildcard tells us the address.
    const [ip] = await net.resolve4(`www.${storesDomain}`).catch(() => [] as string[]);
    if (!ip) throw badRequest(`The address of ${storesDomain} could not be looked up`);
    return { domain, variables: { ip } };
  }
  const mail = await getMailDomain(pool, sendingDomains, tenantId);
  if (!mail || mail.domainName !== domain) throw badRequest(`${domain} is not this store's sending domain`);
  const dkim = mail.records?.find((r) => r.type === 'TXT' && r.name.endsWith('_domainkey'));
  if (!dkim) throw badRequest(`The DNS records for ${domain} could not be loaded from toSend; try again`);
  return { domain, variables: { dkim: dkim.value } };
}

/** Reads `service` from a query string: website or email. */
export function parseService(value: string | undefined): DomainConnectService {
  if (value === 'website' || value === 'email') return value;
  throw badRequest('service must be website or email');
}

/**
 * DOMAIN_CONNECT_PROVIDER_ID (default: PLATFORM_DOMAIN) turns Domain Connect on;
 * DOMAIN_CONNECT_PRIVATE_KEY (PEM, or base64 of it) signs the links.
 */
export function loadDomainConnectConfig(env: NodeJS.ProcessEnv, platformDomain: string | undefined): DomainConnectConfig | undefined {
  if (env.DOMAIN_CONNECT === 'off') return undefined;
  const providerId = env.DOMAIN_CONNECT_PROVIDER_ID?.trim().toLowerCase() || platformDomain;
  if (!providerId) return undefined;
  let privateKey = env.DOMAIN_CONNECT_PRIVATE_KEY?.trim() || undefined;
  if (privateKey && !privateKey.includes('-----BEGIN')) privateKey = Buffer.from(privateKey, 'base64').toString('utf8');
  if (privateKey && !privateKey.includes('PRIVATE KEY')) throw new Error('DOMAIN_CONNECT_PRIVATE_KEY must be a PEM private key (or base64 of one)');
  return { providerId, privateKey, keyHost: env.DOMAIN_CONNECT_KEY_HOST?.trim() || '_dck1' };
}

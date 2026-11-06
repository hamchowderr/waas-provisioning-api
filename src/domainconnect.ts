import { createSign } from 'node:crypto';
import { resolve4, resolve6, resolveNs, resolveTxt } from 'node:dns/promises';
import type { Pool } from './db.ts';
import { badRequest } from './errors.ts';
import { getMailDomain } from './maildomains.ts';
import { publicFetch } from './publicfetch.ts';
import { domainInUse, normalizeDomain } from './tenants.ts';
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
  /** The store server's IPv6 address (DOMAIN_CONNECT_IPV6), when the stores' wildcard name has no AAAA record. */
  ipv6?: string;
}

export interface DomainConnectLink {
  /** The domain's DNS host, when it supports Domain Connect at all. */
  dnsProvider: string | null;
  /** True when that DNS host has the platform's template, so `url` works. */
  supported: boolean;
  /** Opens the DNS host's page that adds the records once the owner approves. */
  url: string | null;
  /**
   * Why there is no link even though the DNS host could make one: a record already on the domain
   * that the template would sit beside instead of replacing. The owner edits it by hand instead.
   */
  conflict?: string;
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
  resolve6(name: string): Promise<string[]>;
  /** Nameservers; optional so older fakes keep working (no DNS host is named without it). */
  resolveNs?(name: string): Promise<string[]>;
  fetch: typeof fetch;
}

// The settings host and urlAPI come from the domain's own DNS, so their fetches refuse private addresses.
const defaultNet: DomainConnectNet = { resolveTxt, resolve4, resolve6, resolveNs, fetch: publicFetch };

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
 * The website template's variables: the stores' server addresses. Custom domains point where the
 * stores' own names do, so the wildcard (www.<storesDomain>) tells us the address.
 */
async function websiteVariables(
  storesDomain: string,
  domain: string,
  net: DomainConnectNet,
  fallbackIpv6?: string,
): Promise<{ variables: Record<string, string>; conflict?: string }> {
  const [ip] = await net.resolve4(`www.${storesDomain}`).catch(() => [] as string[]);
  if (!ip) throw badRequest(`The address of ${storesDomain} could not be looked up`);
  // The template sets AAAA too, so an old IPv6 address on the domain is replaced, not left behind.
  const [ipv6 = fallbackIpv6] = await net.resolve6(`www.${storesDomain}`).catch(() => [] as string[]);
  if (!ipv6) {
    // The template needs %ipv6%, so a link without it couldn't be applied. The customer sees the
    // conflict, so it says what to do; what to fix on the platform goes to the log.
    console.warn(`Domain Connect: no IPv6 address for stores (www.${storesDomain} has no AAAA record and DOMAIN_CONNECT_IPV6 is not set), so ${domain} gets no link`);
    const conflict = 'One-click setup is not available for this domain right now. Add the records below by hand.';
    return { variables: { ip }, conflict };
  }
  return { variables: { ip, ipv6 } };
}

/** One record to add at a domain's DNS host so it reaches the store. */
export interface DomainRecord {
  type: 'A' | 'AAAA';
  /** Relative to the domain the DNS host holds, as most DNS hosts want it: @ for the domain itself. */
  name: string;
  /** The full hostname. */
  host: string;
  value: string;
}

/** What a custom domain needs before a store can use it, for the dashboard's domain panel. */
export interface DomainSetup {
  domainName: string;
  /** The records to add (A, and AAAA when the server has an IPv6 address). Any other A or AAAA records on the name go. */
  records: DomainRecord[];
  /** The A and AAAA addresses the domain has now. */
  currentAddresses: string[];
  /** True when the domain already points only at the store server. */
  pointsHere: boolean;
  /** One-click setup at the DNS host; null when Domain Connect is off on the API. */
  connect: DomainConnectLink | null;
  /** Who runs the domain's DNS, from its nameservers; null when they could not be looked up. */
  dnsHost: { name: string; nameservers: string[] } | null;
}

/** Nameserver domains of the common DNS hosts, and the name owners know them by. */
const DNS_HOSTS: [RegExp, string][] = [
  [/(^|\.)ns\.cloudflare\.com$/, 'Cloudflare'],
  [/(^|\.)domaincontrol\.com$/, 'GoDaddy'],
  [/(^|\.)registrar-servers\.com$/, 'Namecheap'],
  [/(^|\.)squarespacedns\.com$/, 'Squarespace'],
  [/(^|\.)googledomains\.com$/, 'Google Cloud DNS'],
  [/(^|\.)awsdns-\d+\.(com|net|org|co\.uk)$/, 'Amazon Route 53'],
  [/(^|\.)azure-dns\.(com|net|org|info)$/, 'Azure DNS'],
  [/(^|\.)(dns-parking\.com|hostinger\.\w+)$/, 'Hostinger'],
  [/(^|\.)vercel-dns\.com$/, 'Vercel'],
  [/(^|\.)nsone\.net$/, 'NS1'],
  [/(^|\.)digitalocean\.com$/, 'DigitalOcean'],
  [/(^|\.)porkbun\.com$/, 'Porkbun'],
  [/(^|\.)name\.com$/, 'Name.com'],
  [/(^|\.)(ui-dns\.\w+|ionos\.\w+)$/, 'IONOS'],
  [/(^|\.)hover\.com$/, 'Hover'],
  [/(^|\.)wixdns\.net$/, 'Wix'],
  [/(^|\.)dnsimple(-edge)?\.\w+$/, 'DNSimple'],
  [/(^|\.)linode\.com$/, 'Akamai (Linode)'],
  [/(^|\.)bluehost\.com$/, 'Bluehost'],
  [/(^|\.)hostgator\.com$/, 'HostGator'],
  [/(^|\.)dreamhost\.com$/, 'DreamHost'],
  [/(^|\.)siteground\.net$/, 'SiteGround'],
  [/(^|\.)netlify\.com$/, 'Netlify'],
  [/(^|\.)gandi\.net$/, 'Gandi'],
  [/(^|\.)ovh\.net$/, 'OVHcloud'],
  [/(^|\.)dynadot\.com$/, 'Dynadot'],
  [/(^|\.)hetzner\.(com|de)$|(^|\.)your-server\.de$/, 'Hetzner'],
  [/(^|\.)worldnic\.com$/, 'Network Solutions'],
  [/(^|\.)wordpress\.com$/, 'WordPress.com'],
  [/(^|\.)shopify\.com$/, 'Shopify'],
];

/**
 * The zone a name sits in (where its nameservers are set) and who runs it. An unknown host is named
 * by its nameservers' domain, ns1.example-dns.net giving example-dns.net.
 */
async function findDnsHost(name: string, net: DomainConnectNet): Promise<{ zone: string; host: DomainSetup['dnsHost'] } | null> {
  if (!net.resolveNs) return null;
  const labels = name.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = labels.slice(i).join('.');
    const ns = await net.resolveNs(zone).catch(() => [] as string[]);
    if (!ns.length) continue;
    const nameservers = ns.map((n) => n.toLowerCase().replace(/\.$/, '')).sort();
    const known = DNS_HOSTS.find(([pattern]) => nameservers.some((n) => pattern.test(n)));
    return { zone, host: { name: known?.[1] ?? nameservers[0]!.split('.').slice(-2).join('.'), nameservers } };
  }
  return null;
}

/**
 * The records a custom domain needs to reach the stores, whether it has them yet, and the Domain
 * Connect link that adds them. Works before the domain is added to the store, so the owner can point
 * it first; the link only ever points the domain at this platform, and the owner approves it at
 * their DNS host. Refuses a domain another store or the platform uses.
 */
export async function websiteSetup(
  pool: Pool,
  config: { storesDomain: string; platformDomain?: string; brandDomain?: string; domainConnect?: DomainConnectConfig },
  tenantId: string,
  domainName: string,
  net: DomainConnectNet = defaultNet,
): Promise<DomainSetup> {
  const domain = normalizeDomain(domainName);
  const { rows } = await pool.query('SELECT tenant_id, is_base FROM tenant_domains WHERE domain_name = $1', [domain]);
  const own = rows.find((r) => r.tenant_id === tenantId);
  if (own?.is_base) throw badRequest(`${domain} is the store's own address on the platform and needs no DNS records`);
  if (!own && (await domainInUse(pool, domain, config.platformDomain, config.brandDomain))) throw badRequest(`Domain ${domain} is already in use`);

  const { variables, conflict } = await websiteVariables(config.storesDomain, domain, net, config.domainConnect?.ipv6);
  const [a, aaaa] = await Promise.all([
    net.resolve4(domain).catch(() => [] as string[]),
    net.resolve6(domain).catch(() => [] as string[]),
  ]);
  const want4 = variables.ip!;
  const want6 = variables.ipv6;
  // An old AAAA record left beside the right A record sends IPv6 visitors elsewhere, so it counts too.
  const pointsHere = a.length > 0 && a.every((ip) => ip === want4) && aaaa.every((ip) => ip === want6);

  const found = await findDnsHost(domain, net);
  let connect: DomainConnectLink | null = null;
  let zone: string | null = found?.zone ?? null;
  if (config.domainConnect) {
    const link = await domainConnectLink(config.domainConnect, domain, 'website', variables, net);
    connect = conflict && link.supported ? { ...link, supported: false, url: null, conflict } : link;
    if (link.url) zone = new URL(link.url).searchParams.get('domain') ?? zone;
  }
  // Without the nameservers or the DNS host's word for the zone, assume the last two labels (example.com).
  zone ??= domain.split('.').slice(-2).join('.');
  const name = domain === zone ? '@' : domain.endsWith(`.${zone}`) ? domain.slice(0, -zone.length - 1) : domain;
  const records: DomainRecord[] = [{ type: 'A', name, host: domain, value: want4 }];
  if (want6) records.push({ type: 'AAAA', name, host: domain, value: want6 });
  return { domainName: domain, records, currentAddresses: [...a, ...aaaa], pointsHere, connect, dnsHost: found?.host ?? null };
}

/**
 * The template variables for one of a store's domains: the website's server addresses, or the DKIM
 * key of its sending domain. Refuses a domain the store doesn't have. `conflict` is set when the
 * domain already has a record the DNS host would keep next to the template's (see DomainConnectLink).
 */
export async function storeVariables(
  pool: Pool,
  sendingDomains: SendingDomains | undefined,
  storesDomain: string,
  tenantId: string,
  domainName: string,
  service: DomainConnectService,
  net: DomainConnectNet = defaultNet,
  fallbackIpv6?: string,
): Promise<{ domain: string; variables: Record<string, string>; conflict?: string }> {
  const domain = normalizeDomain(domainName);
  if (service === 'website') {
    const { rowCount } = await pool.query('SELECT 1 FROM tenant_domains WHERE tenant_id = $1 AND domain_name = $2', [tenantId, domain]);
    if (!rowCount) throw badRequest(`${domain} is not one of this store's domains`);
    return { domain, ...(await websiteVariables(storesDomain, domain, net, fallbackIpv6)) };
  }
  const mail = await getMailDomain(pool, sendingDomains, tenantId);
  if (!mail || mail.domainName !== domain) throw badRequest(`${domain} is not this store's sending domain`);
  const dkim = mail.records?.find((r) => r.type === 'TXT' && r.name.endsWith('_domainkey'));
  if (!dkim) throw badRequest(`The DNS records for ${domain} could not be loaded from toSend; try again`);
  // Some DNS hosts (Cloudflare) add the DKIM key beside an older one with the same name instead of
  // replacing it, and two keys there make receivers fail the signature. Then the owner edits it by hand.
  const existing = await net.resolveTxt(`${dkim.name}.${domain}`).catch(() => [] as string[][]);
  const values = existing.map((r) => r.join(''));
  const conflict = values.length && !values.includes(dkim.value)
    ? `${dkim.name}.${domain} already has a different email signing (DKIM) key. Replace it with the one below by hand: one-click setup would add a second key next to it, and email would fail its checks.`
    : undefined;
  return { domain, variables: { dkim: dkim.value }, ...(conflict ? { conflict } : {}) };
}

/** Reads `service` from a query string: website or email. */
export function parseService(value: string | undefined): DomainConnectService {
  if (value === 'website' || value === 'email') return value;
  throw badRequest('service must be website or email');
}

/**
 * DOMAIN_CONNECT_PROVIDER_ID (default: BRAND_DOMAIN, else PLATFORM_DOMAIN) turns Domain Connect on;
 * DOMAIN_CONNECT_PRIVATE_KEY (PEM, or base64 of it) signs the links; DOMAIN_CONNECT_IPV6 is the
 * store server's IPv6 address when the stores' wildcard name has no AAAA record.
 */
export function loadDomainConnectConfig(env: NodeJS.ProcessEnv, platformDomain: string | undefined): DomainConnectConfig | undefined {
  if (env.DOMAIN_CONNECT === 'off') return undefined;
  const providerId = env.DOMAIN_CONNECT_PROVIDER_ID?.trim().toLowerCase() || platformDomain;
  if (!providerId) return undefined;
  let privateKey = env.DOMAIN_CONNECT_PRIVATE_KEY?.trim() || undefined;
  if (privateKey && !privateKey.includes('-----BEGIN')) privateKey = Buffer.from(privateKey, 'base64').toString('utf8');
  if (privateKey && !privateKey.includes('PRIVATE KEY')) throw new Error('DOMAIN_CONNECT_PRIVATE_KEY must be a PEM private key (or base64 of one)');
  const ipv6 = env.DOMAIN_CONNECT_IPV6?.trim() || undefined;
  return { providerId, privateKey, keyHost: env.DOMAIN_CONNECT_KEY_HOST?.trim() || '_dck1', ...(ipv6 ? { ipv6 } : {}) };
}

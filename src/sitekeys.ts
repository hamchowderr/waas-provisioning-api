import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Site editing (docs/site-editing.md): the API calls a store's WaaS Client site routes
 * (/wp-json/waas-client/v1/site/...) on behalf of an AI agent, signing each request with the
 * store's site key. The key is derived from SECRETS_KEY and the store's id, so nothing is stored:
 * the provisioner hands it to the store as WAAS_SITE_KEY, and the API derives it again to sign.
 */

/** The master key site keys are derived from: its own HKDF label, so it is never SECRETS_KEY itself. */
export function siteKeyMaster(secretsKeyBase64: string): Buffer {
  const secretsKey = Buffer.from(secretsKeyBase64, 'base64');
  if (secretsKey.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded');
  return Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), 'waas-site-key-v1', 32));
}

/** One store's site key: 43 characters, base64url. */
export function siteKey(master: Buffer, storeId: string): string {
  return createHmac('sha256', master).update(storeId).digest('base64url');
}

/** Site keys by store id, deriving the master key on first use (so a missing SECRETS_KEY fails there). */
export function siteKeys(secretsKeyBase64: string): (storeId: string) => string {
  let master: Buffer | undefined;
  return (storeId) => siteKey((master ??= siteKeyMaster(secretsKeyBase64)), storeId);
}

/**
 * "Sign in with your website" (src/oauth.ts): the API sends the store owner to their wp-admin with a
 * link it signs with the store's key, so WaaS Client knows the app's name and where to answer are
 * ours; the store answers with a signature of its own, so the API knows the store's admin pressed it.
 */
export interface ConnectLink {
  request: string;
  /** The app's name, shown on the Allow page. */
  app: string;
  /** Where the app sends the owner back to after (a host, or an app's scheme). */
  to: string;
  /** Whether the app asks to make changes, not only look ('1' or '0'). */
  write: '1' | '0';
  /** The API's answer URL (oauth/site/answer). */
  back: string;
  /** Unix time the link stops working. */
  t: string;
}

export type ConnectAnswer = 'allow' | 'allow-read' | 'deny';

const CONNECT_FIELDS = ['request', 'app', 'to', 'write', 'back', 't'] as const;

export function connectLinkSignature(key: string, link: ConnectLink): string {
  return createHmac('sha256', key).update(['waas-connect', ...CONNECT_FIELDS.map((f) => link[f])].join('\n')).digest('hex');
}

/** What WaaS Client signs when the owner presses Allow or Cancel. */
export function connectAnswerSignature(key: string, request: string, answer: ConnectAnswer): string {
  return createHmac('sha256', key).update(['waas-connect-answer', request, answer].join('\n')).digest('hex');
}

/** PHP's rawurlencode: encodeURIComponent plus the five characters it leaves alone. */
const rawurlencode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The route as WaaS Client signs it: the REST route, then "?" and the query sorted by name, when there is one. */
export function signedRoute(route: string, query: Record<string, string> = {}): string {
  const pairs = Object.keys(query)
    .sort()
    .map((name) => `${rawurlencode(name)}=${rawurlencode(query[name]!)}`);
  return pairs.length ? `${route}?${pairs.join('&')}` : route;
}

/** The X-Waas-Signature header for one request (WaaS Client's Core\SignedRequest checks it). */
export function signSiteRequest(key: string, method: string, route: string, body: string, now = Date.now()): string {
  const t = String(Math.floor(now / 1000));
  const n = randomBytes(16).toString('hex');
  const payload = [t, n, method.toUpperCase(), route, createHash('sha256').update(body).digest('hex')].join('\n');
  return `t=${t},n=${n},s=${createHmac('sha256', key).update(payload).digest('hex')}`;
}

/**
 * Whether `header` is a current signature of this request by `key`, in signSiteRequest's form: the
 * other way round, for requests a store signs to the API (the page editor's assistant, src/oauth.ts).
 */
export function verifySiteRequest(key: string, header: string | undefined, method: string, route: string, body: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((pair) => pair.trim().split('=', 2) as [string, string]));
  const { t, n, s } = parts as Record<string, string | undefined>;
  if (!t || !/^\d{1,12}$/.test(t) || !n || !/^[0-9a-f]{32}$/.test(n) || !s || !/^[0-9a-f]{64}$/.test(s)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(t)) > 300) return false;
  const payload = [t, n, method.toUpperCase(), route, createHash('sha256').update(body).digest('hex')].join('\n');
  const expected = Buffer.from(createHmac('sha256', key).update(payload).digest('hex'));
  const given = Buffer.from(s);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type SiteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface SiteRequest {
  method: SiteMethod;
  /** Under /site: '' for the site itself, '/pages', '/pages/12/sections/0'... */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface SiteResponse {
  status: number;
  body: unknown;
}

/** Paths the site routes answer; anything else is refused before it reaches the store. */
const SITE_PATH = /^(\/[a-z0-9_-]+(\/[a-z0-9_-]+)*)?$/;

/**
 * Sends one signed request to the store at `domain`. The answer's status and JSON body come back
 * as they are (a 4xx from the store is the store's own explanation, for the agent to read).
 */
export async function callSite(
  key: string,
  domain: string,
  request: SiteRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<SiteResponse> {
  if (!SITE_PATH.test(request.path)) throw new Error(`Not a site path: ${request.path}`);
  const route = signedRoute(`/waas-client/v1/site${request.path}`, request.query);
  const body = request.body === undefined || request.method === 'GET' ? '' : JSON.stringify(request.body);
  const response = await fetchImpl(`https://${domain}/wp-json${route}`, {
    method: request.method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-waas-signature': signSiteRequest(key, request.method, route, body),
    },
    ...(body ? { body } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON (a proxy error page, say): pass the text on, cut short.
    parsed = text.slice(0, 500);
  }
  return { status: response.status, body: parsed };
}

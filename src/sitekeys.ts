import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

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

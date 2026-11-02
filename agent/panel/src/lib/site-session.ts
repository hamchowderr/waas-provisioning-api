// "Sign in with your website" for the panel: the API's OAuth (PKCE, clients it registers itself) for the
// site tools (/mcp/site). The owner's tokens live only in httpOnly cookies on the address the panel was
// opened at; the browser never sees them. The chat routes send the access token on to the assistant
// (lib/mastra-proxy.ts), which asks the API which website it is for.
//
// The panel answers on two kinds of address. On a website's own domain (https://mybakery.com/.assistant,
// which the server's proxy sends here) it is part of that website: its cookies are first-party and its
// sign-in returns to https://mybakery.com/.assistant/callback. On its own address (PANEL_URL) it keeps
// the sign-in return of before (PANEL_URL/callback, which now redirects under BASE_PATH), so handoffs
// made by older WaaS Client and WaaS Host versions still trade.
import { createHash, randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { BASE_PATH } from './base-path';

export const API_URL = (process.env.ANYPRESS_API_URL ?? 'https://api.anypress.io').replace(/\/$/, '');
const PANEL_URL = () => (process.env.PANEL_URL ?? 'http://localhost:3200').replace(/\/$/, '');

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const HOST = /^[a-z0-9.-]+(:\d+)?$|^\[::1\](:\d+)?$/;

type Address = {
  /** Where the panel's pages are, as the owner's browser reaches them (…/.assistant). */
  base: string;
  /** The OAuth return address on this address. */
  redirectUri: string;
  /** Opened at PANEL_URL rather than at a website's own domain. */
  own: boolean;
};

/**
 * The address this request reached the panel at. Behind the proxy the request's own URL is the
 * container's (http://localhost:3200), so it comes from the Host header, which the proxy only sends
 * here for the panel's own address and for the websites' domains.
 */
export async function address(): Promise<Address> {
  const panel = new URL(PANEL_URL());
  const all = await headers();
  const host = (all.get('x-forwarded-host') ?? all.get('host') ?? '').split(',')[0]!.trim().toLowerCase();
  if (!host || host === panel.host || !HOST.test(host)) {
    return { base: `${panel.origin}${BASE_PATH}`, redirectUri: `${panel.origin}/callback`, own: true };
  }
  const forwarded = all.get('x-forwarded-proto')?.split(',')[0]?.trim();
  // Plain http only on this machine (the tests); a website's domain is always https.
  const scheme = LOOPBACK.test(host) ? (forwarded ?? 'http') : 'https';
  const base = `${scheme}://${host}${BASE_PATH}`;
  return { base, redirectUri: `${base}/callback`, own: false };
}

/** A path on this panel as the owner's browser reaches it (under BASE_PATH). Only same-site paths. */
export async function panelLink(path: string): Promise<string> {
  const safe = path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : '/';
  return `${(await address()).base}${safe === '/' ? '' : safe}`;
}
export const SITE_RESOURCE = `${API_URL}/mcp/site`;

const ACCESS = 'ap_access';
const REFRESH = 'ap_refresh';
const EXPIRES = 'ap_expires';
const CLIENT_COOKIE = 'ap_client';
const PENDING = 'ap_signin';

/**
 * On the panel's own address it is shown inside other sites' pages (the editor, the shop), so its
 * cookies are third-party there and must say so. On a website's own domain they are first-party, kept
 * to BASE_PATH so the website's WordPress never receives them.
 */
async function cookieOptions() {
  return (await address()).own
    ? { httpOnly: true, secure: true, sameSite: 'none' as const, partitioned: true, path: '/' }
    : { httpOnly: true, secure: true, sameSite: 'lax' as const, path: BASE_PATH };
}

const b64url = (buffer: Buffer) => buffer.toString('base64url');

type Holder = { [key: symbol]: Map<string, Promise<string>> | undefined };
const CLIENTS = Symbol.for('website-assistant-panel.oauth-clients');

/**
 * The OAuth client id for one return address: PANEL_OAUTH_CLIENT_ID on the panel's own address, or
 * one registered with the API on first use. Each website's domain has a return address of its own.
 */
export function clientId(redirectUri: string): Promise<string> {
  if (process.env.PANEL_OAUTH_CLIENT_ID && redirectUri === `${PANEL_URL()}/callback`) return Promise.resolve(process.env.PANEL_OAUTH_CLIENT_ID);
  const holder = globalThis as Holder;
  const clients = (holder[CLIENTS] ??= new Map());
  let client = clients.get(redirectUri);
  if (!client) {
    client = (async () => {
      const response = await fetch(`${API_URL}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Website assistant', redirect_uris: [redirectUri] }),
      });
      if (!response.ok) throw new Error(`The API refused the panel's registration (${response.status}).`);
      return ((await response.json()) as { client_id: string }).client_id;
    })().catch((error) => {
      clients.delete(redirectUri);
      throw error;
    });
    clients.set(redirectUri, client);
  }
  return client;
}

/**
 * The fields for the API's sign-in form: posted with action=site and the website's address, the
 * API sends the owner straight to that website's wp-admin to say yes.
 */
export async function startSignIn(site: string, back: string) {
  const pending = await pendingSignIn(back);
  return {
    action: `${API_URL}/oauth/authorize`,
    fields: {
      response_type: 'code',
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
      state: pending.state,
      code_challenge: pending.codeChallenge,
      code_challenge_method: 'S256',
      resource: SITE_RESOURCE,
      scope: 'site:read site:write',
      action: 'site',
      site,
    },
  };
}

/** A new sign-in's PKCE verifier and state, kept in a cookie until /callback. */
async function pendingSignIn(back: string) {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const { redirectUri } = await address();
  const client = await clientId(redirectUri);
  (await cookies()).set(PENDING, JSON.stringify({ verifier, state, back, redirectUri, client }), { ...(await cookieOptions()), maxAge: 15 * 60 });
  return { clientId: client, redirectUri, state, codeChallenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/**
 * A sign-in the owner's shop vouches for (its "Ask the website assistant" button): the shop got a
 * one-time handoff for the owner's website from the API, and this trades it, with this sign-in's PKCE
 * challenge, for a code. No list of shops: only a storefront holding its API key can make a handoff.
 * Returns where to send the owner (/callback), or an error.
 */
export async function startShopSignIn(handoff: string, back = '/'): Promise<{ next: string } | { error: string }> {
  if (!handoff) return { error: 'This link is missing its sign-in. Open the assistant again from your account.' };
  const pending = await pendingSignIn(back);
  const response = await fetch(`${API_URL}/oauth/site/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handoff, client_id: pending.clientId, redirect_uri: pending.redirectUri, code_challenge: pending.codeChallenge, state: pending.state }),
  });
  if (!response.ok) return { error: 'This link has expired. Open the assistant again from your account.' };
  return { next: ((await response.json()) as { redirectUrl: string }).redirectUrl };
}

type Tokens = { access_token: string; refresh_token?: string; expires_in?: number };

/** Keeps the tokens, and the client they were issued to: a refresh must come from that same client. */
async function keep(tokens: Tokens, client: string) {
  const jar = await cookies();
  const options = { ...(await cookieOptions()), maxAge: 30 * 24 * 3600 };
  jar.set(ACCESS, tokens.access_token, options);
  if (tokens.refresh_token) jar.set(REFRESH, tokens.refresh_token, options);
  jar.set(EXPIRES, String(Date.now() + (tokens.expires_in ?? 3600) * 1000), options);
  jar.set(CLIENT_COOKIE, client, options);
}

async function token(body: Record<string, string>, client: string): Promise<Tokens | null> {
  const response = await fetch(`${API_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, client_id: client }),
  });
  return response.ok ? ((await response.json()) as Tokens) : null;
}

/** Finishes the sign-in the API sent back to /callback. Returns where to go next, or an error. */
export async function finishSignIn(params: URLSearchParams): Promise<{ back: string } | { error: string }> {
  const jar = await cookies();
  const pending = jar.get(PENDING)?.value;
  jar.set(PENDING, '', { ...(await cookieOptions()), maxAge: 0 });
  if (!pending) return { error: 'This sign-in has expired. Start again.' };
  const { verifier, state, back, redirectUri, client } = JSON.parse(pending) as { verifier: string; state: string; back: string; redirectUri?: string; client?: string };
  if (!redirectUri || !client) return { error: 'This sign-in has expired. Start again.' };
  if (params.get('state') !== state) return { error: 'This sign-in did not match. Start again.' };
  const code = params.get('code');
  if (!code) return { error: params.get('error') === 'access_denied' ? 'The website said no.' : 'The sign-in did not finish.' };
  const tokens = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, client);
  if (!tokens) return { error: 'The sign-in did not finish. Start again.' };
  await keep(tokens, client);
  return { back };
}

/** The owner's Authorization header for the assistant, refreshed when it is about to expire. */
export async function authorization(): Promise<string | null> {
  const jar = await cookies();
  const access = jar.get(ACCESS)?.value;
  if (!access) return null;
  const expires = Number(jar.get(EXPIRES)?.value ?? 0);
  if (expires - Date.now() > 60_000) return `Bearer ${access}`;
  const refresh = jar.get(REFRESH)?.value;
  // Signed in before the client was kept with the tokens: the one for this address, as then.
  const client = jar.get(CLIENT_COOKIE)?.value ?? (await clientId((await address()).redirectUri).catch(() => ''));
  const tokens = refresh && client ? await token({ grant_type: 'refresh_token', refresh_token: refresh }, client) : null;
  if (!tokens) {
    await signOut();
    return null;
  }
  await keep(tokens, client);
  return `Bearer ${tokens.access_token}`;
}

export async function signedIn(): Promise<boolean> {
  return Boolean((await cookies()).get(ACCESS)?.value);
}

export async function signOut() {
  const jar = await cookies();
  const options = { ...(await cookieOptions()), maxAge: 0 };
  for (const name of [ACCESS, REFRESH, EXPIRES, CLIENT_COOKIE]) jar.set(name, '', options);
}

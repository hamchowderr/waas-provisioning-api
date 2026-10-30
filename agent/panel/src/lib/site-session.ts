// "Sign in with your website" for the panel: the AnyPress API's OAuth (PKCE, a client it registers
// itself) for the site tools (/mcp/site). The owner's tokens live only in httpOnly cookies on the
// panel's own address; the browser never sees them. The chat routes send the access token on to the
// assistant (lib/mastra-proxy.ts), which asks the API which website it is for.
import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';

export const API_URL = (process.env.ANYPRESS_API_URL ?? 'https://api.anypress.io').replace(/\/$/, '');
const PANEL_URL = () => (process.env.PANEL_URL ?? 'http://localhost:3200').replace(/\/$/, '');
export const SITE_RESOURCE = `${API_URL}/mcp/site`;

const ACCESS = 'ap_access';
const REFRESH = 'ap_refresh';
const EXPIRES = 'ap_expires';
const PENDING = 'ap_signin';

// The panel is shown inside other pages (the shop, wp-admin), so its cookies must be sent there too.
const COOKIE = { httpOnly: true, secure: true, sameSite: 'none' as const, partitioned: true, path: '/' };

const b64url = (buffer: Buffer) => buffer.toString('base64url');

type Holder = { [key: symbol]: Promise<string> | undefined };
const CLIENT = Symbol.for('anypress-panel.oauth-client');

/** The panel's OAuth client id: PANEL_OAUTH_CLIENT_ID, or one registered with the API on first use. */
export function clientId(): Promise<string> {
  if (process.env.PANEL_OAUTH_CLIENT_ID) return Promise.resolve(process.env.PANEL_OAUTH_CLIENT_ID);
  const holder = globalThis as Holder;
  holder[CLIENT] ??= (async () => {
    const response = await fetch(`${API_URL}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'AnyPress website assistant', redirect_uris: [`${PANEL_URL()}/callback`] }),
    });
    if (!response.ok) throw new Error(`The API refused the panel's registration (${response.status}).`);
    return ((await response.json()) as { client_id: string }).client_id;
  })().catch((error) => {
    holder[CLIENT] = undefined;
    throw error;
  });
  return holder[CLIENT]!;
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
  (await cookies()).set(PENDING, JSON.stringify({ verifier, state, back }), { ...COOKIE, maxAge: 15 * 60 });
  return {
    clientId: await clientId(),
    redirectUri: `${PANEL_URL()}/callback`,
    state,
    codeChallenge: b64url(createHash('sha256').update(verifier).digest()),
  };
}

/** The shops allowed to sign their owners in (PANEL_SHOPS: comma-separated origins, e.g. https://shop.anypress.io). */
function allowedShop(address: string): URL | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const shops = (process.env.PANEL_SHOPS ?? '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean);
  const secure = url.protocol === 'https:' || url.hostname === 'localhost';
  return secure && shops.includes(url.origin) ? url : null;
}

/**
 * A sign-in the owner's shop vouches for (its "Website assistant" button): the shop's address gets
 * this sign-in's client, redirect and PKCE challenge, asks the API for a code for the owner's website,
 * and sends the owner back to /callback with it. Returns where to send the owner, or null for a shop
 * that isn't allowed.
 */
export async function startShopSignIn(shop: string): Promise<string | null> {
  const target = allowedShop(shop);
  if (!target) return null;
  const pending = await pendingSignIn('/');
  target.searchParams.set('client_id', pending.clientId);
  target.searchParams.set('redirect_uri', pending.redirectUri);
  target.searchParams.set('code_challenge', pending.codeChallenge);
  target.searchParams.set('state', pending.state);
  return target.toString();
}

type Tokens = { access_token: string; refresh_token?: string; expires_in?: number };

async function keep(tokens: Tokens) {
  const jar = await cookies();
  jar.set(ACCESS, tokens.access_token, { ...COOKIE, maxAge: 30 * 24 * 3600 });
  if (tokens.refresh_token) jar.set(REFRESH, tokens.refresh_token, { ...COOKIE, maxAge: 30 * 24 * 3600 });
  jar.set(EXPIRES, String(Date.now() + (tokens.expires_in ?? 3600) * 1000), { ...COOKIE, maxAge: 30 * 24 * 3600 });
}

async function token(body: Record<string, string>): Promise<Tokens | null> {
  const response = await fetch(`${API_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, client_id: await clientId() }),
  });
  return response.ok ? ((await response.json()) as Tokens) : null;
}

/** Finishes the sign-in the API sent back to /callback. Returns where to go next, or an error. */
export async function finishSignIn(params: URLSearchParams): Promise<{ back: string } | { error: string }> {
  const jar = await cookies();
  const pending = jar.get(PENDING)?.value;
  jar.set(PENDING, '', { ...COOKIE, maxAge: 0 });
  if (!pending) return { error: 'This sign-in has expired. Start again.' };
  const { verifier, state, back } = JSON.parse(pending) as { verifier: string; state: string; back: string };
  if (params.get('state') !== state) return { error: 'This sign-in did not match. Start again.' };
  const code = params.get('code');
  if (!code) return { error: params.get('error') === 'access_denied' ? 'The website said no.' : 'The sign-in did not finish.' };
  const tokens = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: `${PANEL_URL()}/callback` });
  if (!tokens) return { error: 'The sign-in did not finish. Start again.' };
  await keep(tokens);
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
  const tokens = refresh ? await token({ grant_type: 'refresh_token', refresh_token: refresh }) : null;
  if (!tokens) {
    await signOut();
    return null;
  }
  await keep(tokens);
  return `Bearer ${tokens.access_token}`;
}

export async function signedIn(): Promise<boolean> {
  return Boolean((await cookies()).get(ACCESS)?.value);
}

export async function signOut() {
  const jar = await cookies();
  for (const name of [ACCESS, REFRESH, EXPIRES]) jar.set(name, '', { ...COOKIE, maxAge: 0 });
}

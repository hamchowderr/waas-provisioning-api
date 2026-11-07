// OAuth 2.1 for the MCP server at /mcp (src/mcp.ts) and the HighLevel app (/apps), as the MCP
// authorization spec asks of a remote server. The authorization server is Better Auth's MCP plugin
// (src/oauthserver.ts): Claude, ChatGPT and other MCP clients find it through the Protected Resource
// Metadata documents here (RFC 9728), register themselves (RFC 7591) or use a Client ID Metadata
// Document, and get tokens with PKCE. This file is the API's side of it:
//
// - the discovery documents, and the API's own addresses from before the plugin (/oauth/authorize,
//   /oauth/register, /oauth/token, /oauth/revoke), which HighLevel's app settings and connected apps
//   still use: each hands over to the plugin's endpoint;
// - the dashboard's Connect page (/account/oauth/connect): the person picks a storefront and ticks
//   what the app may see and change, area by area (mcp/src/scopes.ts), and the plugin finishes;
// - "Sign in with your website" (/mcp/site): the store's own wp-admin (AnyPress Client) approves,
//   signed with the store's site key, and the store's grant only edits that site;
// - checking an access token on every call: the person must still be on the storefront's team, and a
//   member only looks; a store's grant ends with the store. A platform admin may approve for any
//   storefront.
//
// Tokens issued before the plugin (oauth_tokens) keep working, and refreshing, until they expire or
// are revoked; tokens approved with an API key and secret keep working until the key is revoked.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuthError, type AuthInfo } from '@modelcontextprotocol/server';
import { oauthProviderAuthServerMetadata, verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import {
  createDpopReplayStore,
  enforceDpopBinding,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
  type AccessTokenAuthorization,
  type DpopReplayStore,
} from 'better-auth/oauth2';
import { serializeSignedCookie } from 'better-call';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Deps } from './app.ts';
import type { Pool } from './db.ts';
import { createOwnStorefront, type SessionCaller } from './accounts.ts';
import { DEFAULT_SELLER_STORES } from './applications.ts';
import { markHighLevelAgency } from './highlevel.ts';
import { versionService } from './routes/versions.ts';
import { badRequest, HttpError } from './errors.ts';
import { isUuid, readJson } from './http.ts';
import { tokenMatches } from './routes/admin.ts';
import { connectAnswerSignature, connectLinkSignature, siteKeys, verifySiteRequest, type ConnectAnswer, type ConnectLink } from './sitekeys.ts';
import { Status } from './status.ts';
import {
  APPS_PATH,
  CLAIMS,
  CONNECT_PAGE,
  MCP_PATHS,
  memberRole,
  OFFLINE,
  referenceId,
  RESOURCE_PATHS,
  type GrantReference,
} from './oauthserver.ts';
import {
  ALL_SCOPES,
  AREA_LABELS,
  AREAS,
  expandLegacyScopes,
  isScope,
  parseScopes,
  READ_SCOPES,
  readsOnly,
  scopeOf,
  withReads,
} from '../mcp/src/scopes.ts';

export { ALL_SCOPES, APPS_PATH, MCP_PATHS, READ_SCOPES };

/** The scopes a stored grant means: as written, or, for a grant from before scopes per area, what the old two meant. */
export function grantedScopes(scope: string, legacy: boolean): string[] {
  return legacy ? expandLegacyScopes(scope) : parseScopes(scope);
}

/** The scopes an endpoint offers: /mcp/read-only only the read ones, /mcp/site only the site ones. */
export const scopesFor = (path: string) =>
  path.endsWith('/read-only') ? READ_SCOPES : isSiteResource(path) ? [scopeOf('site', 'read'), scopeOf('site', 'write')] : isAppsResource(path) ? APP_SCOPES : ALL_SCOPES;

/** The HighLevel app (src/highlevel.ts) only makes and manages sites, and hears about them. */
const APP_AREAS = ['stores', 'webhooks'] as const;
const APP_SCOPES = APP_AREAS.flatMap((area) => [scopeOf(area, 'read'), scopeOf(area, 'write')]);

export const isAppsResource = (resource: string) => resource.endsWith(APPS_PATH);

/** The areas a connection can be given. */
const areasFor = (resource: string): readonly (typeof AREAS)[number][] => (isAppsResource(resource) ? APP_AREAS : AREAS);

/** Whether a resource (or path) is the endpoint for one website's owner ("Sign in with your website"). */
export const isSiteResource = (resource: string) => resource.endsWith('/mcp/site');

/** How long "Sign in with your website" waits for the store's answer, and a storefront's handoff to the assistant lasts. */
const SITE_REQUEST_TTL_S = 10 * 60;
const HANDOFF_TTL_S = 2 * 60;
/** Tokens from before the plugin: how long a refreshed one lasts. */
const LEGACY_ACCESS_TTL_S = 60 * 60;
const LEGACY_REFRESH_TTL_S = 30 * 24 * 60 * 60;

/** The API's public origin: PUBLIC_URL, or the request's own (behind a proxy, its X-Forwarded-Proto). */
export function publicBase(c: Context<AppEnv>, publicUrl: string | undefined): string {
  if (publicUrl) return publicUrl;
  const url = new URL(c.req.url);
  const proto = c.req.header('X-Forwarded-Proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
  const host = c.req.header('X-Forwarded-Host')?.split(',')[0]?.trim() || c.req.header('Host') || url.host;
  return `${proto}://${host}`;
}

export function protectedResourceMetadataUrl(base: string, path: string): string {
  return `${base}/.well-known/oauth-protected-resource${path}`;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

/** Who a token acts as: an API key, a person on a product's team (userId), or one store's owner (tenantId). */
export type TokenOwner =
  | { productId: string; apiKeyId: string; userId?: undefined; tenantId?: undefined }
  | { productId: string; userId: string; apiKeyId?: undefined; tenantId?: undefined }
  | { productId: string; tenantId: string; apiKeyId?: undefined; userId?: undefined };

/** Owners and admins may make changes; a member only looks. */
const mayChange = (role: string | null) => !!role && role.split(',').some((r) => ['owner', 'admin'].includes(r.trim()));

// ---------------------------------------------------------------------------------------------
// Talking to the plugin. Its endpoints live under Better Auth's /api/auth on the dashboard's address
// (AUTH_URL, which proxies them here), because that is where people's sessions are.

/** Calls one of Better Auth's endpoints in-process, as if on the dashboard's address. */
async function authCall(
  deps: Deps,
  path: string,
  init: { method?: string; query?: string; json?: unknown; form?: string; cookie?: string; authorization?: string; contentType?: string } = {},
): Promise<Response> {
  const auth = requireAuth(deps);
  const url = new URL(`${deps.config.auth!.url}/api/auth${path}`);
  if (init.query) url.search = init.query;
  const headers = new Headers({ Accept: 'application/json' });
  if (init.cookie) {
    headers.set('Cookie', init.cookie);
    // A request with a session is checked against Better Auth's trusted origins.
    headers.set('Origin', deps.config.auth!.url);
  }
  if (init.authorization) headers.set('Authorization', init.authorization);
  let body: string | undefined;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  } else if (init.form !== undefined) {
    headers.set('Content-Type', init.contentType ?? 'application/x-www-form-urlencoded');
    body = init.form;
  }
  return auth.handler(new Request(url, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, body }));
}

function requireAuth(deps: Deps) {
  if (!deps.auth || !deps.config.auth?.apiUrl) throw new HttpError(404, 'Signing in apps is off on this server: it needs AUTH_URL, AUTH_SECRET and PUBLIC_URL');
  return deps.auth;
}

/** The plugin's answer to a step in the browser flow: where to send the browser next. */
async function nextUrl(response: Response): Promise<string> {
  const json = (await response.json().catch(() => ({}))) as { url?: string; error_description?: string; message?: string };
  if (!response.ok || !json.url) throw badRequest(json.error_description ?? json.message ?? 'This sign-in could not go on. Go back to the app and connect again.');
  return json.url;
}

/** The signed request a plugin redirect to the Connect page carries, or null when it went elsewhere. */
function connectQuery(url: string): string | null {
  const parsed = new URL(url, 'https://connect.invalid');
  return parsed.pathname === CONNECT_PAGE && parsed.searchParams.has('sig') ? parsed.search.slice(1) : null;
}

/** A signed request the plugin made (its sig and expiry checked), as its parameters. */
async function signedRequest(deps: Deps, oauthQuery: unknown): Promise<URLSearchParams> {
  requireAuth(deps);
  if (typeof oauthQuery !== 'string' || !oauthQuery || oauthQuery.length > 8192) throw badRequest('oauth_query is required');
  if (!(await verifyOAuthQueryParams(oauthQuery, deps.config.auth!.secret))) {
    throw new HttpError(404, 'This connection request has expired. Go back to the app and connect again.');
  }
  return new URLSearchParams(oauthQuery);
}

/** An app the plugin knows (registered, migrated from before it, or from a metadata document), by client id. */
async function findClient(deps: Deps, clientId: string): Promise<{ name: string; redirectUris: string[] } | null> {
  const { rows } = await deps.pool.query<{ name: string | null; redirectUris: string[] }>(
    'SELECT "name", "redirectUris" FROM auth."oauthClient" WHERE "clientId" = $1 AND "disabled" IS NOT TRUE',
    [clientId],
  );
  const row = rows[0];
  if (!row) return null;
  return { name: row.name || hostOf(clientId) || 'An AI app', redirectUris: row.redirectUris };
}

const hostOf = (value: string) => {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
};

/** Records which storefront (or store) a session's sign-in is for, for the plugin's consent. */
async function setPick(pool: Pool, sessionId: string, ref: GrantReference) {
  await pool.query("DELETE FROM oauth_connect_picks WHERE created_at < now() - interval '1 hour'");
  await pool.query(
    'INSERT INTO oauth_connect_picks (session_id, reference) VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET reference = EXCLUDED.reference, created_at = now()',
    [sessionId, referenceId(ref)],
  );
}

/**
 * Finishes a sign-in in the plugin once the person (or store) is known and picked: the plugin's
 * post-login step, then its consent with the scopes chosen. Answers the app's redirect, with its code.
 */
async function approve(deps: Deps, cookie: string, sessionId: string, userId: string, ref: GrantReference, start: { oauthQuery: string } | { authorize: URLSearchParams }, scopes: string[]) {
  const ctx = await requireAuth(deps).$context;
  await setPick(deps.pool, sessionId, ref);
  try {
    const params = 'oauthQuery' in start ? new URLSearchParams(start.oauthQuery) : start.authorize;
    // A new approval replaces an earlier one for the same app and storefront, so what was ticked now counts.
    const clientId = params.get('client_id') ?? '';
    await ctx.adapter.deleteMany({
      model: 'oauthConsent',
      where: [
        { field: 'clientId', value: clientId },
        { field: 'userId', value: userId },
        { field: 'referenceId', value: referenceId(ref) },
      ],
    });
    const next =
      'oauthQuery' in start
        ? await nextUrl(await authCall(deps, '/oauth2/continue', { json: { postLogin: true, oauth_query: start.oauthQuery }, cookie }))
        : await nextUrl(await authCall(deps, '/oauth2/authorize', { query: start.authorize.toString(), cookie }));
    const consent = connectQuery(next);
    if (!consent) return next;
    // Only scopes the app asked for (and the refresh token it is always given).
    const asked = new Set((new URLSearchParams(consent).get('scope') ?? '').split(' ').filter(Boolean));
    const scope = [...scopes, OFFLINE].filter((s) => asked.has(s));
    if (!scope.some((s) => s !== OFFLINE)) throw badRequest('The app did not ask for any of what you ticked. Go back to the app and connect again.');
    return await nextUrl(await authCall(deps, '/oauth2/consent', { json: { accept: true, scope: scope.join(' '), oauth_query: consent }, cookie }));
  } finally {
    await deps.pool.query('DELETE FROM oauth_connect_picks WHERE session_id = $1', [sessionId]);
  }
}

/**
 * The app's redirect when the person (or website) declines. With a session, the plugin's own consent
 * answers it. The plugin's consent needs a session, and "Sign in with your website" has none, so there
 * the answer is the same one it gives (RFC 6749 access_denied, with the state and the issuer, RFC 9207),
 * to the redirect URI in the request the plugin signed after checking it against the app's.
 */
async function decline(deps: Deps, oauthQuery: string, cookie?: string) {
  if (cookie) return nextUrl(await authCall(deps, '/oauth2/consent', { json: { accept: false, oauth_query: oauthQuery }, cookie }));
  const params = await signedRequest(deps, oauthQuery);
  const back = new URL(params.get('redirect_uri') ?? '');
  back.searchParams.set('error', 'access_denied');
  back.searchParams.set('error_description', 'User denied access');
  const state = params.get('state');
  if (state) back.searchParams.set('state', state);
  back.searchParams.set('iss', deps.config.auth!.apiUrl!);
  return back.toString();
}

/** The session cookie for a session made here (a store's own sign-in), as Better Auth signs it. */
async function sessionCookie(deps: Deps, token: string): Promise<string> {
  const ctx = await requireAuth(deps).$context;
  const set = await serializeSignedCookie(ctx.authCookies.sessionToken.name, token, ctx.secret);
  return set.split(';')[0]!;
}

/**
 * "Sign in with your website", once the store has said yes (or a storefront or the store vouched for
 * its owner): the store's own Better Auth user, a session for this one sign-in, and the plugin's
 * code for this store only. `scopes` are site:read, and site:write when allowed.
 */
export async function storeSignIn(deps: Deps, tenant: { id: string; product_id: string }, start: { oauthQuery: string } | { authorize: URLSearchParams }, scopes: string[]) {
  const ctx = await requireAuth(deps).$context;
  const { rows } = await deps.pool.query<{ id: string }>('SELECT id FROM auth."user" WHERE "storeTenantId" = $1', [tenant.id]);
  let userId = rows[0]?.id;
  if (!userId) {
    // An address no mail goes to: this user can only ever sign in this way.
    const user = await ctx.internalAdapter.createUser({ email: `${tenant.id}@stores.invalid`, name: 'Website owner', emailVerified: true, storeTenantId: tenant.id }, { method: 'store-site-sign-in' });
    userId = user.id;
  }
  const session = await ctx.internalAdapter.createSession(userId);
  return approve(deps, await sessionCookie(deps, session.token), session.id, userId, { kind: 'tenant', tenantId: tenant.id }, start, scopes);
}

// ---------------------------------------------------------------------------------------------
// Checking access tokens.

/**
 * How the token came: the Authorization scheme (Bearer or DPoP), the DPoP proof, and the request's
 * method and public URL, which the proof signs (RFC 9449).
 */
export type TokenRequest = { authorization: AccessTokenAuthorization; proofJwt: string | null | undefined; method: string; url: string };

/**
 * The token in an `Authorization: Bearer` or `Authorization: DPoP` header, and how it came, for
 * {@link verifyAccessToken}. `url` is the address the app called (the API's public one).
 */
export function tokenRequest(request: Request, url: string): TokenRequest | null {
  const authorization = parseAccessTokenAuthorization(request.headers.get('authorization'));
  if (!authorization?.token || authorization.scheme === 'Unknown') return null;
  return { authorization, proofJwt: request.headers.get('dpop'), method: request.method, url };
}

/**
 * Checks an access token for /mcp, /mcp/site, /mcp/read-only or /apps: one the plugin signed, or one
 * from before it. Throws OAuthError invalid_token, as the MCP SDK's bearer helpers expect.
 *
 * An app may bind its tokens to a key of its own (DPoP, which the plugin offers): such a token works
 * only with `Authorization: DPoP` and a fresh proof signed by that key, checked by Better Auth's own
 * `enforceDpopBinding`. Without `how`, the token came as a Bearer token with no proof.
 */
export async function verifyAccessToken(deps: Deps, token: string, how?: TokenRequest): Promise<AuthInfo> {
  if (token.split('.').length === 3 && deps.auth && deps.config.auth?.apiUrl) return verifyPluginToken(deps, token, how);
  // Tokens from before the plugin were never bound to a key.
  if (how && how.authorization.scheme !== 'Bearer') throw new OAuthError('invalid_token', 'DPoP authorization requires a DPoP-bound access token');
  return verifyLegacyToken(deps.pool, token);
}

const jwksCache = new WeakMap<object, object>();
const replayStores = new WeakMap<object, Promise<DpopReplayStore>>();

/** Better Auth's DPoP proof store, in the database, so a proof is used once across restarts (the one the MCP plugin uses). */
function replayStore(auth: NonNullable<Deps['auth']>): Promise<DpopReplayStore> {
  let store = replayStores.get(auth);
  if (!store) replayStores.set(auth, (store = auth.$context.then((ctx) => createDpopReplayStore(ctx.internalAdapter))));
  return store;
}

async function verifyPluginToken(deps: Deps, token: string, how?: TokenRequest): Promise<AuthInfo> {
  const api = deps.config.auth!.apiUrl!;
  const auth = deps.auth!;
  // Better Auth's own JWT check, with the key set read in-process (it caches it, and fetches again for a new key).
  let cacheKey = jwksCache.get(auth);
  if (!cacheKey) jwksCache.set(auth, (cacheKey = {}));
  let payload;
  try {
    payload = await verifyJwsAccessToken(token, {
      jwksFetch: async () => (await authCall(deps, '/jwks')).json(),
      jwksCacheKey: cacheKey,
      verifyOptions: { issuer: api, audience: RESOURCE_PATHS.map((path) => `${api}${path}`), requiredClaims: ['azp'] },
    });
  } catch {
    throw new OAuthError('invalid_token', 'Unknown, expired or revoked access token');
  }
  try {
    await enforceDpopBinding({
      payload,
      authorization: how?.authorization ?? { scheme: 'Bearer', token },
      proofJwt: how?.proofJwt,
      method: how?.method ?? 'GET',
      url: how?.url ?? api,
      replayStore: await replayStore(auth),
    });
  } catch (error) {
    if (isDpopBindingError(error)) throw new OAuthError('invalid_token', error.message);
    throw error;
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const resource = audiences.find((aud): aud is string => typeof aud === 'string' && RESOURCE_PATHS.some((path) => aud === `${api}${path}`));
  const productId = payload[CLAIMS.product];
  if (!resource || typeof productId !== 'string') throw new OAuthError('invalid_token', 'This access token is not for this API');
  const granted = parseScopes(typeof payload.scope === 'string' ? payload.scope : '');
  const tenantId = payload[CLAIMS.tenant];
  let owner: TokenOwner;
  let scopes = granted;
  if (typeof tenantId === 'string') {
    const { rowCount } = await deps.pool.query('SELECT 1 FROM tenants WHERE id = $1 AND product_id = $2', [tenantId, productId]);
    if (!rowCount) throw new OAuthError('invalid_token', 'This website no longer exists');
    owner = { productId, tenantId };
  } else {
    const userId = String(payload.sub ?? '');
    if (payload[CLAIMS.admin] === true) {
      const { rowCount } = await deps.pool.query('SELECT 1 FROM products WHERE id = $1', [productId]);
      if (!rowCount) throw new OAuthError('invalid_token', 'This storefront no longer exists');
    } else {
      const role = await memberRole(deps.pool, userId, productId);
      if (!role) throw new OAuthError('invalid_token', 'You are no longer on this storefront’s team');
      // A person who may now only look keeps the read scopes.
      if (!mayChange(role)) scopes = readsOnly(granted);
    }
    owner = { productId, userId };
  }
  return {
    token,
    clientId: String(payload.azp),
    scopes,
    expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
    resource: new URL(resource),
    extra: { ...owner },
  };
}

/** The organization `o` gives access to the row's product: the storefront's own team, or its reseller's team (docs/resellers.md). */
const ORG_HAS = (alias: string) =>
  `(o."productId" = ${alias}.product_id OR o."resellerId" = (SELECT p.reseller_id FROM products p WHERE p.id = ${alias}.product_id))`;
/**
 * Whether a token from before the plugin may still be used: the API key still works, the store still
 * exists, or the person is still on the product's team. `role` is the person's role there.
 */
const OWNER_CHECK = (alias: string) => `
  CASE WHEN ${alias}.api_key_id IS NOT NULL
       THEN EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ${alias}.api_key_id AND (k.revoked_at IS NULL OR k.revoked_at > now()))
       WHEN ${alias}.tenant_id IS NOT NULL
       THEN EXISTS (SELECT 1 FROM tenants x WHERE x.id = ${alias}.tenant_id AND x.product_id = ${alias}.product_id)
       WHEN ${alias}.platform_admin
       THEN EXISTS (SELECT 1 FROM products p WHERE p.id = ${alias}.product_id)
       ELSE EXISTS (SELECT 1 FROM auth.member m JOIN auth.organization o ON o.id = m."organizationId"
                     WHERE m."userId" = ${alias}.user_id AND ${ORG_HAS(alias)}) END`;
const OWNER_ROLE = (alias: string) => `(SELECT m.role FROM auth.member m JOIN auth.organization o ON o.id = m."organizationId"
                     WHERE m."userId" = ${alias}.user_id AND ${ORG_HAS(alias)}
                     ORDER BY (o."productId" IS NULL) LIMIT 1)`;

/** The owner of a token row from before the plugin. */
function rowOwner(row: { api_key_id: string | null; user_id: string | null; tenant_id: string | null; product_id: string }): TokenOwner {
  if (row.user_id) return { productId: row.product_id, userId: row.user_id };
  if (row.tenant_id) return { productId: row.product_id, tenantId: row.tenant_id };
  return { productId: row.product_id, apiKeyId: row.api_key_id! };
}

/** A token from before the plugin (oauth_tokens): random, stored hashed. */
async function verifyLegacyToken(pool: Pool, token: string): Promise<AuthInfo> {
  const { rows } = await pool.query<{
    client_id: string;
    scope: string;
    resource: string;
    expires_at: Date;
    api_key_id: string | null;
    user_id: string | null;
    tenant_id: string | null;
    product_id: string;
    role: string | null;
    legacy_scope: boolean;
    platform_admin: boolean;
  }>(
    `SELECT t.client_id, t.scope, t.resource, t.expires_at, t.api_key_id, t.user_id, t.tenant_id, t.legacy_scope, t.platform_admin,
            COALESCE((SELECT k.product_id FROM api_keys k WHERE k.id = t.api_key_id), t.product_id) AS product_id,
            ${OWNER_ROLE('t')} AS role
       FROM oauth_tokens t
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND ${OWNER_CHECK('t')}`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) throw new OAuthError('invalid_token', 'Unknown or revoked access token');
  const scopes = grantedScopes(row.scope, row.legacy_scope);
  return {
    token,
    clientId: row.client_id,
    // A person's token keeps its write scopes only while their role allows changes (a platform admin's always).
    scopes: !row.user_id || row.platform_admin || mayChange(row.role) ? scopes : readsOnly(scopes),
    expiresAt: Math.floor(row.expires_at.getTime() / 1000),
    resource: new URL(row.resource),
    extra: { ...rowOwner(row) },
  };
}

/** Refreshes a token from before the plugin (they rotate), or null when the refresh token isn't one. */
async function legacyRefresh(pool: Pool, form: Record<string, string | undefined>) {
  const { rows } = await pool.query<{
    client_id: string;
    api_key_id: string | null;
    user_id: string | null;
    tenant_id: string | null;
    product_id: string | null;
    scope: string;
    resource: string;
    legacy_scope: boolean;
    platform_admin: boolean;
    expires_at: Date;
    owner_ok: boolean;
  }>(
    `UPDATE oauth_tokens t SET revoked_at = now()
      WHERE t.token_hash = $1 AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.expires_at > now()
      RETURNING t.client_id, t.api_key_id, t.user_id, t.tenant_id, t.product_id, t.scope, t.resource, t.legacy_scope, t.platform_admin, t.expires_at,
                ${OWNER_CHECK('t')} AS owner_ok`,
    [sha256(form.refresh_token ?? '')],
  );
  const row = rows[0];
  if (!row) return null;
  const fail = { error: 'invalid_grant', error_description: 'The refresh token is unknown, used, expired or revoked' };
  if (!row.owner_ok || row.client_id !== form.client_id) return { status: 400 as const, body: fail };
  let scope = row.scope;
  if (form.scope) {
    const narrower = [...new Set(form.scope.split(' ').filter((s) => s && s !== OFFLINE))];
    if (narrower.some((s) => !row.scope.split(' ').includes(s))) return { status: 400 as const, body: { error: 'invalid_scope', error_description: 'A refresh can only keep or narrow the scope' } };
    if (narrower.length) scope = narrower.join(' ');
  }
  const access = randomToken();
  const refresh = randomToken();
  // A platform admin's approval isn't checked against a team, so it doesn't outlive its first 30 days.
  const refreshUntil = row.platform_admin ? row.expires_at : null;
  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, api_key_id, user_id, tenant_id, product_id, scope, resource, legacy_scope, platform_admin, expires_at) VALUES
       ($1, 'access', $3, $4, $5, $6, $7, $8, $9, $12, $13, LEAST(now() + make_interval(secs => $10), COALESCE($14, 'infinity'::timestamptz))),
       ($2, 'refresh', $3, $4, $5, $6, $7, $8, $9, $12, $13, COALESCE($14, now() + make_interval(secs => $11)))`,
    [sha256(access), sha256(refresh), row.client_id, row.api_key_id, row.user_id, row.tenant_id, row.api_key_id ? null : row.product_id, scope, row.resource, LEGACY_ACCESS_TTL_S, LEGACY_REFRESH_TTL_S, row.legacy_scope, row.platform_admin, refreshUntil],
  );
  await pool.query("DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day'");
  return { status: 200 as const, body: { access_token: access, token_type: 'Bearer', expires_in: LEGACY_ACCESS_TTL_S, refresh_token: refresh, scope } };
}

const randomToken = () => randomBytes(32).toString('base64url');

// ---------------------------------------------------------------------------------------------
// Routes.

export function oauthRoutes(app: Hono<AppEnv>, deps: Deps) {
  const { pool } = deps;
  const keyFor = siteKeys(deps.config.secretsKey);
  const api = () => requireAuth(deps) && deps.config.auth!.apiUrl!;

  // Browser-based MCP clients (the MCP Inspector, for one) call these cross-origin.
  const open = cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version'], exposeHeaders: ['WWW-Authenticate'] });
  app.use('/.well-known/oauth-*', open);
  app.use('/oauth/register', open);
  app.use('/oauth/token', open);
  app.use('/oauth/revoke', open);

  // Protected Resource Metadata (RFC 9728), with the plugin's resource helper: this API is its authorization server.
  const resourceNames: Record<string, string> = {
    '/mcp': 'Store management',
    '/mcp/read-only': 'Store management (read-only)',
    '/mcp/site': 'Your website',
    [APPS_PATH]: 'The AnyPress app for HighLevel',
  };
  for (const path of RESOURCE_PATHS) {
    app.get(`/.well-known/oauth-protected-resource${path}`, async (c) => {
      const resources = oauthProviderResourceClient(requireAuth(deps)).getActions();
      return c.json(
        await resources.getProtectedResourceMetadata({
          resource: `${api()}${path}`,
          scopes_supported: [...scopesFor(path)],
          bearer_methods_supported: ['header'],
          resource_name: resourceNames[path],
        }),
      );
    });
  }

  // Authorization Server Metadata (RFC 8414), as the plugin writes it: its endpoints on the dashboard's address.
  // The plugin's endpoints are added at run time (src/oauthserver.ts), so Auth's type doesn't list them.
  const serverMetadata = () => oauthProviderAuthServerMetadata(requireAuth(deps) as unknown as Parameters<typeof oauthProviderAuthServerMetadata>[0])(new Request(`${deps.config.auth!.url}/api/auth/.well-known/oauth-authorization-server`));
  app.get('/.well-known/oauth-authorization-server', () => serverMetadata());
  app.get('/.well-known/openid-configuration', () => serverMetadata());

  // The API's authorization address from before the plugin (HighLevel's app settings use it): the plugin's, on the dashboard.
  app.get('/oauth/authorize', (c) => {
    requireAuth(deps);
    const url = new URL(c.req.url);
    return c.redirect(`${deps.config.auth!.url}/api/auth/oauth2/authorize${url.search}`, 302);
  });

  // The website assistant's sign-in form (agent/panel): the authorization request plus action=site and the website's address.
  app.post('/oauth/authorize', async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string | undefined>;
    const { action, site, ...rest } = form;
    const query = new URLSearchParams(Object.entries(rest).filter((e): e is [string, string] => typeof e[1] === 'string'));
    if (action !== 'site') return c.redirect(`${deps.config.auth!.url}/api/auth/oauth2/authorize?${query}`, 302);
    const next = await nextUrl(await authCall(deps, '/oauth2/authorize', { query: query.toString() }));
    const oauthQuery = connectQuery(next);
    // The plugin refused the request (an unknown app, say), or answered the app straight away.
    if (!oauthQuery) return c.redirect(next, 302);
    const started = await startSiteSignIn(oauthQuery, site ?? '');
    if ('message' in started) return page(c, errorPage(started.message), 400);
    return c.redirect(started.redirectUrl, 302);
  });

  // Registration (RFC 7591), at the address apps used before: the plugin's. Apps that registered here
  // never got a secret, so one that names no way to sign in at the token endpoint stays a public app.
  app.post('/oauth/register', async (c) => {
    const raw = await c.req.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(raw || '{}') as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (body && typeof body === 'object' && !Array.isArray(body) && body.token_endpoint_auth_method === undefined) body.token_endpoint_auth_method = 'none';
    return authCall(deps, '/oauth2/register', { form: body ? JSON.stringify(body) : raw, contentType: 'application/json' });
  });

  app.post('/oauth/token', async (c) => {
    const raw = await c.req.text();
    const type = c.req.header('Content-Type') ?? 'application/x-www-form-urlencoded';
    const form = type.includes('application/json')
      ? ((JSON.parse(raw || '{}') ?? {}) as Record<string, string | undefined>)
      : Object.fromEntries(new URLSearchParams(raw));
    // A refresh token from before the plugin is refreshed as before; everything else is the plugin's.
    if (form.grant_type === 'refresh_token' && form.refresh_token) {
      const legacy = await legacyRefresh(pool, form);
      if (legacy) return c.json(legacy.body, legacy.status, { 'Cache-Control': 'no-store' });
    }
    return authCall(deps, '/oauth2/token', { form: raw, contentType: type, authorization: c.req.header('Authorization') });
  });

  // Revocation (RFC 7009): a token from before the plugin, or the plugin's. Always 200.
  app.post('/oauth/revoke', async (c) => {
    const raw = await c.req.text();
    const type = c.req.header('Content-Type') ?? 'application/x-www-form-urlencoded';
    const form = type.includes('application/json') ? ((JSON.parse(raw || '{}') ?? {}) as Record<string, string>) : Object.fromEntries(new URLSearchParams(raw));
    if (form.token) {
      const { rowCount } = await pool.query('UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(form.token)]);
      if (rowCount) return c.body(null, 200);
    }
    if (deps.auth && deps.config.auth?.apiUrl) await authCall(deps, '/oauth2/revoke', { form: raw, contentType: type, authorization: c.req.header('Authorization') });
    return c.body(null, 200);
  });

  /**
   * Sign in with your website: the store a typed address names, and the link to its wp-admin's connect
   * page (AnyPress Client), signed with its site key. The store answers at /oauth/site/answer.
   */
  async function startSiteSignIn(oauthQuery: string, typed: string): Promise<{ redirectUrl: string } | { message: string }> {
    const params = await signedRequest(deps, oauthQuery);
    const resource = params.get('resource') ?? '';
    if (!isSiteResource(resource)) throw badRequest('This sign-in is not for a website');
    const store = await findStoreByAddress(pool, typed);
    if (!store?.main_domain) return { message: 'We could not find an AnyPress website at that address. Type the address people visit it at, such as mybakery.com.' };
    if (store.status !== Status.Done || store.is_suspended) return { message: 'That website cannot be connected right now: it is being set up, changed or is paused. Try again later.' };
    const clientId = params.get('client_id') ?? '';
    const client = await findClient(deps, clientId);
    const redirectUri = params.get('redirect_uri') ?? client?.redirectUris[0] ?? '';
    const requested = parseScopes(params.get('scope') ?? '');
    const write = siteWantsWrite(requested);
    await pool.query('DELETE FROM oauth_site_requests WHERE expires_at < now()');
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO oauth_site_requests (oauth_query, tenant_id, client_name, write, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) RETURNING id`,
      [oauthQuery, store.id, client?.name ?? 'An AI app', write, SITE_REQUEST_TTL_S],
    );
    const link: ConnectLink = {
      request: rows[0]!.id,
      app: client?.name ?? 'An AI app',
      to: returnHost(redirectUri),
      write: write ? '1' : '0',
      back: `${api()}/oauth/site/answer`,
      t: String(Math.floor(Date.now() / 1000) + SITE_REQUEST_TTL_S),
    };
    const target = new URL(`https://${store.main_domain}/wp-admin/admin.php`);
    target.searchParams.set('page', 'waas-connect');
    for (const [name, value] of Object.entries(link)) target.searchParams.set(name, value);
    target.searchParams.set('s', connectLinkSignature(keyFor(store.id), link));
    return { redirectUrl: target.toString() };
  }

  // The dashboard's Connect page, for a website's owner: { oauth_query, site } (or { oauth_query, action: 'deny' }).
  // No sign-in needed: the store's wp-admin approves. Answers where to send the browser.
  app.post('/oauth/site/start', async (c) => {
    const body = ((await readJson(c)) ?? {}) as { oauth_query?: unknown; site?: unknown; action?: unknown };
    const params = await signedRequest(deps, body.oauth_query);
    if (body.action === 'deny') return c.json({ redirectUrl: await decline(deps, params.toString()) });
    const started = await startSiteSignIn(String(body.oauth_query), typeof body.site === 'string' ? body.site : '');
    if ('message' in started) throw badRequest(started.message);
    return c.json(started);
  });

  // The store's answer to "Sign in with your website", signed with its site key (AnyPress Client's connect page).
  app.get('/oauth/site/answer', async (c) => {
    const { request: id, answer, s } = c.req.query();
    if (!id || !isUuid(id) || !['allow', 'allow-read', 'deny'].includes(answer ?? '') || !s) {
      return page(c, errorPage('The answer from your website was not complete.'), 400);
    }
    const { rows } = await pool.query<{ oauth_query: string; tenant_id: string; product_id: string; write: boolean }>(
      `SELECT r.oauth_query, r.tenant_id, r.write, t.product_id FROM oauth_site_requests r JOIN tenants t ON t.id = r.tenant_id WHERE r.id = $1 AND r.expires_at > now()`,
      [id],
    );
    const row = rows[0];
    if (!row) return page(c, errorPage('This connection request has expired or was already used.'), 400);
    const expected = Buffer.from(connectAnswerSignature(keyFor(row.tenant_id), id, answer as ConnectAnswer));
    const given = Buffer.from(s);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return page(c, errorPage('The answer could not be checked: it did not come from that website.'), 400);
    }
    // Single use, whichever way it goes.
    const { rowCount } = await pool.query('DELETE FROM oauth_site_requests WHERE id = $1', [id]);
    if (!rowCount) return page(c, errorPage('This connection request was already used.'), 400);
    try {
      if (answer === 'deny') return c.redirect(await decline(deps, row.oauth_query), 302);
      // A store's connection only ever edits its site: site:read, and site:write when allowed.
      const scopes = answer === 'allow' && row.write ? [scopeOf('site', 'read'), scopeOf('site', 'write')] : [scopeOf('site', 'read')];
      return c.redirect(await storeSignIn(deps, { id: row.tenant_id, product_id: row.product_id }, { oauthQuery: row.oauth_query }, scopes), 302);
    } catch (error) {
      if (error instanceof HttpError) return page(c, errorPage(error.message), 400);
      throw error;
    }
  });

  // The website assistant trades a storefront's handoff (createSiteHandoff), with its own PKCE challenge,
  // for a code for that one website. One use; the redirect must be the one the storefront named.
  app.post('/oauth/site/handoff', async (c) => {
    const body = (await readJson(c)) as Record<string, unknown>;
    const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');
    const [handoff, clientId, redirectUri, codeChallenge, state] = ['handoff', 'client_id', 'redirect_uri', 'code_challenge', 'state'].map(text);
    if (!handoff || !clientId || !redirectUri || !codeChallenge) throw badRequest('handoff, client_id, redirect_uri and code_challenge are required');
    const { rows } = await pool.query<{ tenant_id: string; product_id: string; redirect_uri: string }>(
      'DELETE FROM site_handoffs WHERE handoff_hash = $1 AND expires_at > now() RETURNING tenant_id, product_id, redirect_uri',
      [sha256(handoff)],
    );
    const given = rows[0];
    if (!given) throw badRequest('This link has expired. Open the assistant again from your account.');
    if (!sameRedirectUri(given.redirect_uri, redirectUri)) throw badRequest('redirect_uri is not the assistant this storefront named');
    const client = await findClient(deps, clientId);
    if (!client?.redirectUris.some((uri) => sameRedirectUri(uri, redirectUri))) throw badRequest('client_id is not an app registered for that redirect_uri');
    const { rows: tenants } = await pool.query<{ status: number; is_suspended: boolean }>('SELECT status, is_suspended FROM tenants WHERE id = $1', [given.tenant_id]);
    if (tenants[0]?.status !== Status.Done || tenants[0].is_suspended) throw badRequest('This website is not ready');
    const redirectUrl = await storeSignIn(
      deps,
      { id: given.tenant_id, product_id: given.product_id },
      { authorize: siteAuthorizeRequest(api(), { clientId, redirectUri, codeChallenge, state }) },
      [scopeOf('site', 'read'), scopeOf('site', 'write')],
    );
    return c.json({ redirectUrl }, 200, { 'Cache-Control': 'no-store' });
  });

  // The page editor's assistant (AnyPress Client): the store itself, signing with its site key, hands the
  // admin who opened it to the assistant at assistantUrl, for this website only. Same handoff as the
  // storefront's button, so the assistant trades it at /oauth/site/handoff as usual.
  app.post('/oauth/site/store-handoff', async (c) => {
    const raw = await c.req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw badRequest('The body must be JSON');
    }
    const site = typeof body.site === 'string' ? body.site.toLowerCase() : '';
    const assistantUrl = typeof body.assistantUrl === 'string' ? body.assistantUrl : '';
    if (!site || !assistantUrl) throw badRequest('site and assistantUrl are required');
    let assistant: URL;
    try {
      assistant = new URL(assistantUrl);
    } catch {
      throw badRequest('assistantUrl must be an address');
    }
    if (assistant.protocol !== 'https:' && assistant.hostname !== 'localhost') throw badRequest('assistantUrl must be https');
    const { rows } = await pool.query<{ id: string; product_id: string; status: number; is_suspended: boolean }>(
      `SELECT t.id, t.product_id, t.status, t.is_suspended FROM tenants t JOIN tenant_domains d ON d.tenant_id = t.id
        WHERE d.domain_name = $1 LIMIT 1`,
      [site],
    );
    const tenant = rows[0];
    const signed = tenant && verifySiteRequest(keyFor(tenant.id), c.req.header('X-AnyPress-Signature'), 'POST', '/oauth/site/store-handoff', raw);
    if (!tenant || !signed) throw new HttpError(403, 'This request is not signed by that website');
    if (tenant.status !== Status.Done || tenant.is_suspended) throw badRequest('This website is not ready');
    const root = assistant.origin + assistant.pathname.replace(/\/$/, '');
    const handoff = await createSiteHandoff(pool, tenant, root);
    const url = new URL(`${root}/from-shop`);
    url.searchParams.set('handoff', handoff);
    return c.json({ url: url.toString() }, 200, { 'Cache-Control': 'no-store' });
  });
}

/** The authorization request a store's vouched-for sign-in makes for the app: /mcp/site, the site scopes. */
export function siteAuthorizeRequest(api: string, request: { clientId: string; redirectUri: string; codeChallenge: string; state?: string }) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
    resource: `${api}/mcp/site`,
    scope: [scopeOf('site', 'read'), scopeOf('site', 'write'), OFFLINE].join(' '),
  });
  if (request.state) query.set('state', request.state);
  return query;
}

/** Whether "Sign in with your website" should offer changes: unless the app asked to look only. */
function siteWantsWrite(requested: string[]): boolean {
  return requested.length === 0 || requested.some((s) => s.endsWith(':write'));
}

/**
 * A storefront hands its signed-in owner to the website assistant at `assistantUrl`: a one-time
 * handoff for this website only, which only that assistant's /callback can trade for a sign-in code.
 */
export async function createSiteHandoff(pool: Pool, tenant: { id: string; product_id: string }, assistantUrl: string): Promise<string> {
  const handoff = randomToken();
  await pool.query('DELETE FROM site_handoffs WHERE expires_at < now()');
  await pool.query(
    'INSERT INTO site_handoffs (handoff_hash, tenant_id, product_id, redirect_uri, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))',
    [sha256(handoff), tenant.id, tenant.product_id, `${assistantUrl.replace(/\/$/, '')}/callback`, HANDOFF_TTL_S],
  );
  return handoff;
}

/** Whether an app registered this redirect URI with the plugin. */
export async function clientHasRedirect(deps: Deps, clientId: string, redirectUri: string): Promise<boolean> {
  const client = await findClient(deps, clientId);
  return !!client?.redirectUris.some((uri) => sameRedirectUri(uri, redirectUri));
}

/**
 * The dashboard's half of signing in as a person (its Connect page, AUTH_URL/connect, where the plugin
 * sends the browser): read a waiting sign-in, then approve it for one of the person's storefronts, with
 * the scopes they ticked, or decline. Mounted in /account, so the caller is the signed-in person whose
 * session the dashboard's server passes on. When the dashboard's server also sends the admin token, it
 * vouches that this person is a platform admin: they see every storefront and may grant what an owner may.
 */
export function connectRoutes(deps: Deps, caller: (c: Context<AppEnv>) => Promise<SessionCaller | null>) {
  const { pool } = deps;
  const app = new Hono<AppEnv>();
  type Storefront = { productId: string; name: string; role: string; canChange: boolean };

  /** Whether the dashboard's server sent the admin token: the person is one of its platform admins. */
  const platformAdmin = (c: Context<AppEnv>) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
    return !!deps.config.adminToken && !!match && tokenMatches(match[1]!, deps.config.adminToken);
  };

  async function load(c: Context<AppEnv>, oauthQuery: unknown) {
    const me = await caller(c);
    if (!me) throw new HttpError(403, 'Sign in first');
    const params = await signedRequest(deps, oauthQuery);
    const resource = params.get('resource') ?? '';
    if (isSiteResource(resource)) throw badRequest('This connection is for a website: type its address instead');
    const client = await findClient(deps, params.get('client_id') ?? '');
    if (!client) throw new HttpError(404, 'This app is not registered. Go back to the app and connect again.');
    const asAdmin = platformAdmin(c);
    // The person's own storefronts, then, for a platform admin, every other one.
    const storefronts: Storefront[] = me.memberships.map((m) => ({ productId: m.productId, name: m.productName, role: m.role, canChange: asAdmin || mayChange(m.role) }));
    if (asAdmin) {
      const others = await pool.query<{ id: string; name: string }>('SELECT id, name FROM products WHERE NOT (id = ANY($1::uuid[])) ORDER BY name, id', [
        storefronts.map((s) => s.productId),
      ]);
      storefronts.push(...others.rows.map((p) => ({ productId: p.id, name: p.name, role: 'platform admin', canChange: true })));
    }
    const requested = parseScopes(params.get('scope') ?? '');
    const readOnly = resource.endsWith('/read-only');
    // Someone connecting the HighLevel app before they have a storefront may make one here.
    const canCreateStorefront = isAppsResource(resource) && storefronts.length === 0;
    return { me, params, client, resource, storefronts, asAdmin, requested, readOnly, canCreateStorefront };
  }

  app.get('/oauth/connect', async (c) => {
    const { params, client, resource, storefronts, asAdmin, requested, readOnly, canCreateStorefront } = await load(c, c.req.query('oauth_query'));
    // An app that asked for nothing specific has every box ready for the person to choose from.
    const asked = requested.length ? requested : [...ALL_SCOPES];
    return c.json({
      clientName: client.name,
      returnTo: returnHost(params.get('redirect_uri') ?? client.redirectUris[0] ?? ''),
      requestedScopes: requested,
      wantsWrite: asked.some((s) => s.endsWith(':write')),
      readOnly,
      // One row per area: a box to see and a box to change, ticked to start with as described.
      areas: areasFor(resource)
        .filter((area) => asked.includes(scopeOf(area, 'read')) || asked.includes(scopeOf(area, 'write')))
        .map((area) => ({
          area,
          name: AREA_LABELS[area].name,
          read: { scope: scopeOf(area, 'read'), label: AREA_LABELS[area].read, ticked: true },
          write: readOnly || !asked.includes(scopeOf(area, 'write')) ? null : { scope: scopeOf(area, 'write'), label: AREA_LABELS[area].write, ticked: requested.includes(scopeOf(area, 'write')) },
        })),
      asAdmin,
      storefronts,
      forApps: isAppsResource(resource),
      canCreateStorefront,
    });
  });

  // { oauth_query, action: 'approve', productId, scopes: ['stores:read', …] } or { oauth_query, action: 'deny' }.
  // For the HighLevel app, someone with no storefront sends newStorefront: '<name>' instead of productId to make one.
  // Answers where to send the browser.
  app.post('/oauth/connect', async (c) => {
    const body = ((await readJson(c)) ?? {}) as { oauth_query?: unknown; action?: unknown; productId?: unknown; scopes?: unknown; newStorefront?: unknown };
    const { me, resource, storefronts, readOnly, canCreateStorefront, asAdmin } = await load(c, body.oauth_query);
    const oauthQuery = String(body.oauth_query);
    const cookie = c.req.header('Cookie') ?? '';
    const session = await requireAuth(deps).api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new HttpError(403, 'Sign in first');
    if (body.action === 'deny') return c.json({ redirectUrl: await decline(deps, oauthQuery, cookie) });
    if (body.action !== 'approve') throw badRequest("action must be 'approve' or 'deny'");
    const newName = typeof body.newStorefront === 'string' ? body.newStorefront.trim().slice(0, 100) : '';
    if (body.newStorefront !== undefined) {
      if (!canCreateStorefront) throw badRequest('Choose one of your storefronts');
      if (!newName) throw badRequest('Name your storefront');
    }
    let storefront = storefronts.find((s) => s.productId === body.productId);
    if (newName && canCreateStorefront) storefront = { productId: '', name: newName, role: 'owner', canChange: true };
    if (!storefront) throw badRequest('Choose one of your storefronts');
    if (!Array.isArray(body.scopes) || body.scopes.some((s) => typeof s !== 'string' || !isScope(s))) throw badRequest(`scopes must list some of ${ALL_SCOPES.join(' ')}`);
    let scopes = withReads(parseScopes(body.scopes as string[]));
    // Changes need a role that may make them, and an endpoint that isn't read-only.
    if (readOnly || !storefront.canChange) scopes = readsOnly(scopes);
    scopes = scopes.filter((s) => areasFor(resource).some((area) => s.startsWith(`${area}:`)));
    if (!scopes.length) throw badRequest('Tick at least one thing the app may see');
    if (!storefront.productId) {
      const made = await createOwnStorefront(pool, me.user.id, storefront.name, DEFAULT_SELLER_STORES);
      storefront.productId = made.id;
      // The store template the shop sells, followed from then on, so its first site can be built.
      if (deps.config.storeTemplateProductId) {
        try {
          const versions = versionService(deps);
          await versions.copyProduction(made.id, await versions.productionSource(deps.config.storeTemplateProductId));
        } catch (err) {
          console.error(`oauth: storefront ${made.id} made without a store template: ${(err as Error).message}`);
        }
      }
    }
    // Connecting the HighLevel app makes the storefront a HighLevel agency's: its sites get the HighLevel site type.
    if (isAppsResource(resource)) await markHighLevelAgency(pool, deps.boss, storefront.productId);
    // A platform admin's grant stands on its own, not on a team role (unless they are on the team).
    const onTeam = me.memberships.some((m) => m.productId === storefront!.productId);
    const ref: GrantReference = asAdmin && !onTeam ? { kind: 'admin', productId: storefront.productId } : { kind: 'product', productId: storefront.productId };
    const redirectUrl = await approve(deps, cookie, session.session.id, me.user.id, ref, { oauthQuery }, scopes);
    return c.json({ redirectUrl });
  });

  return app;
}

/** Where an app sends the browser back to, for people to read: its host, or its own scheme. */
function returnHost(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : `${url.protocol}//`;
  } catch {
    return '';
  }
}

/** The store a typed website address names (by any of its domains, with or without www.), or null. */
async function findStoreByAddress(pool: Pool, typed: string) {
  const value = typed.trim();
  if (!value || value.length > 300) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  const names = host.startsWith('www.') ? [host, host.slice(4)] : [host, `www.${host}`];
  const { rows } = await pool.query<{ id: string; status: number; is_suspended: boolean; main_domain: string | null }>(
    `SELECT t.id, t.status, t.is_suspended, (SELECT m.domain_name FROM tenant_domains m WHERE m.tenant_id = t.id AND m.is_main) AS main_domain
       FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
      WHERE d.domain_name = ANY($1) ORDER BY d.domain_name = $2 DESC LIMIT 1`,
    [names, host],
  );
  return rows[0] ?? null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Exact match, except a loopback redirect may use any port (RFC 8252 7.3). */
export function sameRedirectUri(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    if (a.protocol !== 'http:' || !LOOPBACK.has(a.hostname)) return false;
    a.port = '';
    b.port = '';
    return a.toString() === b.toString();
  } catch {
    return false;
  }
}

function page(c: Context<AppEnv>, html: string, status: 200 | 400 | 401 = 200) {
  return c.html(html, status, {
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
}

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const STYLE = `
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --bg: #fff; --card: #f6f8fa; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --bg: #0d1117; --card: #151b23; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 440px; margin: 48px auto; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); font-size: 13px; }
`;

/** The page a browser lands on when a website sign-in can't go on (the store's answer comes back here). */
function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Cannot connect</title><style>${STYLE}</style></head><body><main><div class="card"><h1>Cannot connect this app</h1><p>${esc(message)}</p><p class="muted">Go back to the app and try connecting again.</p></div></main></body></html>`;
}

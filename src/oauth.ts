// OAuth 2.1 for the MCP server at /mcp (src/mcp.ts), as the MCP authorization spec asks of a remote
// server: Claude, ChatGPT and other MCP clients find this authorization server through the
// Protected Resource Metadata document (RFC 9728), register themselves (RFC 7591) or identify
// themselves with a Client ID Metadata Document, and get tokens with PKCE. Approving a client means
// signing in as a person on the dashboard (AUTH_URL/connect), picking a storefront and ticking what
// the app may see and change, area by area (mcp/src/scopes.ts), or, for a store owner, "Sign in with
// your website": pressing Allow in the store's own wp-admin (WaaS Client), which answers signed with
// the store's site key. A code or token belongs to that person and product, or to that one store:
// once the person leaves the team or the store is deleted, the client is cut off, and a person who
// may only look gets read-only access whatever they approved. A platform admin may approve for any
// storefront. A store's token only edits that store's site (src/mcp.ts). Tokens approved with an API
// key and secret, before that was dropped, keep working until the key is revoked.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuthError, type AuthInfo } from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Deps } from './app.ts';
import type { Pool } from './db.ts';
import type { SessionCaller } from './accounts.ts';
import { badRequest, HttpError } from './errors.ts';
import { isUuid, readJson } from './http.ts';
import { publicFetch } from './publicfetch.ts';
import { tokenMatches } from './routes/admin.ts';
import { connectAnswerSignature, connectLinkSignature, siteKeys, type ConnectAnswer, type ConnectLink } from './sitekeys.ts';
import { Status } from './status.ts';
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
  WRITE_SCOPES,
} from '../mcp/src/scopes.ts';

export { ALL_SCOPES, READ_SCOPES };

/** The scopes a stored grant means: as written, or, for a grant from before scopes per area, what the old two meant. */
export function grantedScopes(scope: string, legacy: boolean): string[] {
  return legacy ? expandLegacyScopes(scope) : parseScopes(scope);
}

/** The scopes an endpoint offers: /mcp/read-only only the read ones, /mcp/site only the site ones. */
export const scopesFor = (path: string) =>
  path.endsWith('/read-only') ? READ_SCOPES : isSiteResource(path) ? [scopeOf('site', 'read'), scopeOf('site', 'write')] : ALL_SCOPES;

/** The MCP endpoints a token can be for (RFC 8707 resource), by path. /mcp/site is for one website's owner. */
export const MCP_PATHS = ['/mcp', '/mcp/read-only', '/mcp/site'] as const;

/** Whether a resource (or path) is the endpoint for one website's owner ("Sign in with your website"). */
export const isSiteResource = (resource: string) => resource.endsWith('/mcp/site');

const CODE_TTL_S = 10 * 60;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;

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
const randomToken = () => randomBytes(32).toString('base64url');

/** Who a token acts as: an API key, a person on a product's team (userId), or one store's owner (tenantId). */
export type TokenOwner =
  | { productId: string; apiKeyId: string; userId?: undefined; tenantId?: undefined }
  | { productId: string; userId: string; apiKeyId?: undefined; tenantId?: undefined }
  | { productId: string; tenantId: string; apiKeyId?: undefined; userId?: undefined };

/** The owner of a code or token row. */
function rowOwner(row: { api_key_id: string | null; user_id: string | null; tenant_id: string | null; product_id: string }): TokenOwner {
  if (row.user_id) return { productId: row.product_id, userId: row.user_id };
  if (row.tenant_id) return { productId: row.product_id, tenantId: row.tenant_id };
  return { productId: row.product_id, apiKeyId: row.api_key_id! };
}

/** The organization `o` gives access to the row's product: the storefront's own team, or its reseller's team (docs/resellers.md). */
const ORG_HAS = (alias: string) =>
  `(o."productId" = ${alias}.product_id OR o."resellerId" = (SELECT p.reseller_id FROM products p WHERE p.id = ${alias}.product_id))`;
/**
 * Whether a code or token's owner may still use it: the API key still works, the store still exists,
 * or the person is still on the product's team. `role` is the person's role there (null when not), for trimming write access.
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

/** Owners and admins may make changes; a member only looks. */
const mayChange = (role: string | null) => !!role && role.split(',').some((r) => ['owner', 'admin'].includes(r.trim()));

/** A person's token keeps its write scopes only while their role allows changes (a platform admin's always). */
function allowedScopes(scopes: string[], row: { user_id: string | null; role: string | null; platform_admin: boolean }): string[] {
  if (!row.user_id || row.platform_admin || mayChange(row.role)) return scopes;
  return readsOnly(scopes);
}

/** Checks an access token for /mcp. Throws OAuthError invalid_token, as the SDK's bearer helpers expect. */
export async function verifyAccessToken(pool: Pool, token: string): Promise<AuthInfo> {
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
  const owner = rowOwner(row);
  return {
    token,
    clientId: row.client_id,
    scopes: allowedScopes(grantedScopes(row.scope, row.legacy_scope), row),
    expiresAt: Math.floor(row.expires_at.getTime() / 1000),
    resource: new URL(row.resource),
    extra: { ...owner },
  };
}

interface AuthorizeRequest {
  client: Client;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  /** What the app asked for (may be empty: then the person decides). */
  scope: string[];
  resource: string;
}

interface Client {
  clientId: string;
  name: string;
  redirectUris: string[];
}

export function oauthRoutes(app: Hono<AppEnv>, deps: Deps) {
  const { pool } = deps;
  const base = (c: Context<AppEnv>) => publicBase(c, deps.config.publicUrl);
  const fetchMetadata: typeof fetch = (input, init) => (deps.clientMetadataFetch ?? publicFetch)(input, init);
  const documents = new Map<string, { client: Client | null; until: number }>();
  const keyFor = siteKeys(deps.config.secretsKey);
  /** The brand on the "Sign in to …" button, when people can sign in (AUTH_URL set); else none. */
  const signInBrand = () => (deps.config.auth ? (deps.config.auth.mail?.brand ?? 'AnyPress') : undefined);

  // Browser-based MCP clients (the MCP Inspector, for one) call these cross-origin.
  const open = cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version'], exposeHeaders: ['WWW-Authenticate'] });
  app.use('/.well-known/oauth-*', open);
  app.use('/oauth/register', open);
  app.use('/oauth/token', open);
  app.use('/oauth/revoke', open);

  for (const path of MCP_PATHS) {
    app.get(`/.well-known/oauth-protected-resource${path}`, (c) =>
      c.json({
        resource: `${base(c)}${path}`,
        authorization_servers: [base(c)],
        scopes_supported: scopesFor(path),
        bearer_methods_supported: ['header'],
        resource_name: path === '/mcp' ? 'Store management' : isSiteResource(path) ? 'Your website' : 'Store management (read-only)',
      }),
    );
  }

  const authorizationServerMetadata = (c: Context<AppEnv>) => {
    const issuer = base(c);
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      scopes_supported: ALL_SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  };
  app.get('/.well-known/oauth-authorization-server', authorizationServerMetadata);
  app.get('/.well-known/openid-configuration', authorizationServerMetadata);

  // Dynamic client registration (RFC 7591). Public clients only: they prove themselves with PKCE.
  app.post('/oauth/register', async (c) => {
    const body = await c.req.json().catch(() => null);
    const fail = (description: string) => c.json({ error: 'invalid_client_metadata', error_description: description }, 400);
    if (!body || typeof body !== 'object') return fail('Send the client metadata as JSON');
    const uris: unknown = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) return fail('redirect_uris must list 1 to 10 URLs');
    for (const uri of uris) {
      if (typeof uri !== 'string' || !allowedRedirectUri(uri)) {
        return c.json({ error: 'invalid_redirect_uri', error_description: `Not an allowed redirect URI: ${String(uri).slice(0, 200)}` }, 400);
      }
    }
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : null;
    const { rows } = await pool.query<{ id: string; created_at: Date }>(
      'INSERT INTO oauth_clients (client_name, redirect_uris) VALUES ($1, $2) RETURNING id, created_at',
      [name, uris],
    );
    return c.json(
      {
        client_id: rows[0]!.id,
        client_id_issued_at: Math.floor(rows[0]!.created_at.getTime() / 1000),
        client_name: name ?? undefined,
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  });

  /** A registered client, or one identified by its metadata document URL; null when neither. */
  async function resolveClient(clientId: string): Promise<Client | null> {
    if (isUuid(clientId)) {
      const { rows } = await pool.query<{ client_name: string | null; redirect_uris: string[] }>(
        'SELECT client_name, redirect_uris FROM oauth_clients WHERE id = $1',
        [clientId],
      );
      const row = rows[0];
      return row ? { clientId, name: row.client_name ?? 'An MCP client', redirectUris: row.redirect_uris } : null;
    }
    if (!isMetadataDocumentUrl(clientId)) return null;
    const cached = documents.get(clientId);
    if (cached && cached.until > Date.now()) return cached.client;
    const client = await fetchClientDocument(clientId).catch(() => null);
    documents.set(clientId, { client, until: Date.now() + (client ? 5 * 60_000 : 30_000) });
    return client;
  }

  async function fetchClientDocument(url: string): Promise<Client | null> {
    const response = await fetchMetadata(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 64 * 1024) return null;
    const doc = JSON.parse(text) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
    if (doc.client_id !== url || !Array.isArray(doc.redirect_uris)) return null;
    const redirectUris = doc.redirect_uris.filter((u): u is string => typeof u === 'string' && allowedRedirectUri(u));
    if (!redirectUris.length) return null;
    return { clientId: url, name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : new URL(url).host, redirectUris };
  }

  /**
   * Checks an authorization request. Problems with the client or redirect URI are shown on our page
   * (redirecting to an unchecked URI would make this an open redirector); the rest go back to the client.
   */
  async function parseAuthorize(c: Context<AppEnv>, params: Record<string, string | undefined>) {
    const clientId = params.client_id ?? '';
    const client = clientId ? await resolveClient(clientId) : null;
    if (!client) return { page: 'This app is not registered, or its client id could not be checked.' } as const;
    const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.some((uri) => sameRedirectUri(uri, redirectUri))) {
      return { page: 'The address this app asked to return to is not one it registered.' } as const;
    }
    const back = (error: string, description: string) => ({ redirect: errorRedirect(redirectUri, error, description, params.state, base(c)) }) as const;
    if (params.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported');
    if (!params.code_challenge || params.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with S256 is required');
    const resource = (params.resource ?? `${base(c)}/mcp`).replace(/\/$/, '');
    if (!MCP_PATHS.some((path) => resource === `${base(c)}${path}`)) return back('invalid_target', 'Unknown resource');
    const requested = (params.scope ?? '').split(' ').filter(Boolean);
    if (requested.some((s) => !isScope(s))) return back('invalid_scope', `Scopes are ${ALL_SCOPES.join(' ')}`);
    // What the app asked for only sets which boxes start ticked; the person decides. The read-only endpoint never writes.
    let scope = parseScopes(requested);
    if (resource.endsWith('/read-only')) scope = readsOnly(scope);
    const request: AuthorizeRequest = { client, redirectUri, state: params.state, codeChallenge: params.code_challenge, scope, resource };
    return { request } as const;
  }

  app.get('/oauth/authorize', async (c) => {
    const parsed = await parseAuthorize(c, c.req.query());
    if ('page' in parsed) return page(c, errorPage(parsed.page!), 400);
    if ('redirect' in parsed) return c.redirect(parsed.redirect!);
    return page(c, approvePage(parsed.request, c.req.query(), signInBrand()));
  });

  app.post('/oauth/authorize', async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string | undefined>;
    const parsed = await parseAuthorize(c, form);
    if ('page' in parsed) return page(c, errorPage(parsed.page!), 400);
    if ('redirect' in parsed) return c.redirect(parsed.redirect!, 302);
    const { request } = parsed;
    // Sign in as a person instead: the dashboard (where the session cookie lives) finishes the approval.
    const auth = deps.config.auth;
    if (form.action === 'signin' && auth && !isSiteResource(request.resource)) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO oauth_requests (client_id, client_name, redirect_uri, state, code_challenge, scope, resource, issuer, expires_at, legacy_scope)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9), false) RETURNING id`,
        [request.client.clientId, request.client.name, request.redirectUri, request.state ?? null, request.codeChallenge, request.scope.join(' '), request.resource, base(c), CODE_TTL_S],
      );
      await pool.query("DELETE FROM oauth_requests WHERE expires_at < now() - interval '1 day'");
      return c.redirect(`${auth.url}/connect/${rows[0]!.id}`, 302);
    }
    // Sign in with your website: the store's own wp-admin (WaaS Client) asks its admin, then answers at /oauth/site/answer.
    if (form.action === 'site' && isSiteResource(request.resource)) {
      const store = await findStoreByAddress(pool, form.site ?? '');
      const retry = (message: string) => page(c, approvePage(request, form, signInBrand(), message), 400);
      if (!store?.main_domain) return retry('We could not find an AnyPress website at that address. Type the address people visit it at, such as mybakery.com.');
      if (store.status !== Status.Done || store.is_suspended) return retry('That website cannot be connected right now: it is being set up, changed or is paused. Try again later.');
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO oauth_requests (client_id, client_name, redirect_uri, state, code_challenge, scope, resource, issuer, tenant_id, expires_at, legacy_scope)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10), false) RETURNING id`,
        [request.client.clientId, request.client.name, request.redirectUri, request.state ?? null, request.codeChallenge, request.scope.join(' '), request.resource, base(c), store.id, CODE_TTL_S],
      );
      await pool.query("DELETE FROM oauth_requests WHERE expires_at < now() - interval '1 day'");
      const link: ConnectLink = {
        request: rows[0]!.id,
        app: request.client.name,
        to: returnHost(request.redirectUri),
        write: siteWantsWrite(request.scope, request.resource) ? '1' : '0',
        back: `${base(c)}/oauth/site/answer`,
        t: String(Math.floor(Date.now() / 1000) + CODE_TTL_S),
      };
      const target = new URL(`https://${store.main_domain}/wp-admin/admin.php`);
      target.searchParams.set('page', 'waas-connect');
      for (const [name, value] of Object.entries(link)) target.searchParams.set(name, value);
      target.searchParams.set('s', connectLinkSignature(keyFor(store.id), link));
      return c.redirect(target.toString(), 302);
    }
    if (form.action === 'deny') {
      return c.redirect(errorRedirect(request.redirectUri, 'access_denied', 'The user declined', request.state, base(c)), 302);
    }
    // Approving with an API key and secret is gone: people sign in instead.
    return page(c, approvePage(request, form, signInBrand(), undefined, 'Approving with an API key and secret is no longer offered. Sign in instead.'), 400);
  });

  // The store's answer to "Sign in with your website", signed with its site key (WaaS Client's connect page).
  app.get('/oauth/site/answer', async (c) => {
    const { request: id, answer, s } = c.req.query();
    if (!id || !isUuid(id) || !['allow', 'allow-read', 'deny'].includes(answer ?? '') || !s) {
      return page(c, errorPage('The answer from your website was not complete.'), 400);
    }
    const { rows } = await pool.query<{ redirect_uri: string; state: string | null; code_challenge: string; client_id: string; scope: string; resource: string; issuer: string; tenant_id: string; product_id: string; legacy_scope: boolean }>(
      `SELECT r.*, t.product_id FROM oauth_requests r JOIN tenants t ON t.id = r.tenant_id WHERE r.id = $1 AND r.expires_at > now()`,
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
    const { rowCount } = await pool.query('DELETE FROM oauth_requests WHERE id = $1', [id]);
    if (!rowCount) return page(c, errorPage('This connection request was already used.'), 400);
    if (answer === 'deny') return c.redirect(errorRedirect(row.redirect_uri, 'access_denied', 'The user declined', row.state ?? undefined, row.issuer), 302);
    // A store's connection only ever edits its site: site:read, and site:write when allowed.
    const requested = row.legacy_scope ? expandLegacyScopes(row.scope) : parseScopes(row.scope);
    const write = answer === 'allow' && siteWantsWrite(requested, row.resource);
    const scope = write ? [scopeOf('site', 'read'), scopeOf('site', 'write')] : [scopeOf('site', 'read')];
    const code = await issueCode(
      pool,
      { clientId: row.client_id, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge, resource: row.resource },
      { productId: row.product_id, tenantId: row.tenant_id },
      scope.join(' '),
    );
    return c.redirect(codeRedirect(row.redirect_uri, code, row.state, row.issuer), 302);
  });

  app.post('/oauth/token', async (c) => {
    const form = (await readForm(c)) as Record<string, string | undefined>;
    const fail = (error: string, description: string, status: 400 | 401 = 400) =>
      c.json({ error, error_description: description }, status, { 'Cache-Control': 'no-store' });

    if (form.grant_type === 'authorization_code') {
      if (!form.code || !form.code_verifier || !form.client_id) return fail('invalid_request', 'code, code_verifier and client_id are required');
      const { rows } = await pool.query<{
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        api_key_id: string | null;
        user_id: string | null;
        tenant_id: string | null;
        product_id: string | null;
        scope: string;
        resource: string;
        legacy_scope: boolean;
        platform_admin: boolean;
      }>(
        `UPDATE oauth_codes c SET used_at = now()
          WHERE c.code_hash = $1 AND c.used_at IS NULL AND c.expires_at > now() AND ${OWNER_CHECK('c')}
          RETURNING c.client_id, c.redirect_uri, c.code_challenge, c.api_key_id, c.user_id, c.tenant_id, c.product_id, c.scope, c.resource, c.legacy_scope, c.platform_admin`,
        [sha256(form.code)],
      );
      const row = rows[0];
      if (!row || row.client_id !== form.client_id) return fail('invalid_grant', 'The code is unknown, used or expired');
      if (form.redirect_uri !== undefined && form.redirect_uri !== row.redirect_uri) return fail('invalid_grant', 'redirect_uri does not match');
      if (sha256(form.code_verifier) !== row.code_challenge) return fail('invalid_grant', 'code_verifier does not match');
      return c.json(await issueTokens(row.client_id, row, row.scope, row.resource), 200, { 'Cache-Control': 'no-store' });
    }

    if (form.grant_type === 'refresh_token') {
      if (!form.refresh_token || !form.client_id) return fail('invalid_request', 'refresh_token and client_id are required');
      // Refresh tokens rotate: this one is spent, whatever happens next.
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
        [sha256(form.refresh_token)],
      );
      const row = rows[0];
      if (!row || !row.owner_ok || row.client_id !== form.client_id) return fail('invalid_grant', 'The refresh token is unknown, used, expired or revoked');
      // Narrowing compares names as stored: a grant from before scopes per area keeps the old names
      // (and its mark), so a client that sends its old scope back keeps everything it had.
      let scope = row.scope;
      if (form.scope) {
        const narrower = [...new Set(form.scope.split(' ').filter(Boolean))];
        if (narrower.some((s) => !row.scope.split(' ').includes(s))) return fail('invalid_scope', 'A refresh can only keep or narrow the scope');
        scope = narrower.join(' ');
      }
      // A platform admin's approval isn't checked against a team, so it doesn't outlive its first 30 days: then connect again.
      return c.json(await issueTokens(row.client_id, row, scope, row.resource, row.platform_admin ? row.expires_at : undefined), 200, { 'Cache-Control': 'no-store' });
    }

    return fail('unsupported_grant_type', 'Use authorization_code or refresh_token');
  });

  // Token revocation (RFC 7009): always 200, whether or not the token existed.
  app.post('/oauth/revoke', async (c) => {
    const form = (await readForm(c)) as Record<string, string | undefined>;
    if (form.token) await pool.query('UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(form.token)]);
    return c.body(null, 200);
  });

  async function issueTokens(
    clientId: string,
    owner: { api_key_id: string | null; user_id: string | null; tenant_id: string | null; product_id: string | null; legacy_scope: boolean; platform_admin: boolean },
    scope: string,
    resource: string,
    refreshUntil?: Date,
  ) {
    const access = randomToken();
    const refresh = randomToken();
    await pool.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, api_key_id, user_id, tenant_id, product_id, scope, resource, legacy_scope, platform_admin, expires_at) VALUES
         ($1, 'access', $3, $4, $5, $6, $7, $8, $9, $12, $13, LEAST(now() + make_interval(secs => $10), COALESCE($14, 'infinity'::timestamptz))),
         ($2, 'refresh', $3, $4, $5, $6, $7, $8, $9, $12, $13, COALESCE($14, now() + make_interval(secs => $11)))`,
      [sha256(access), sha256(refresh), clientId, owner.api_key_id, owner.user_id, owner.tenant_id, owner.api_key_id ? null : owner.product_id, scope, resource, ACCESS_TTL_S, REFRESH_TTL_S, owner.legacy_scope, owner.platform_admin, refreshUntil ?? null],
    );
    // Housekeeping: codes and tokens a day past expiry are of no use to anyone.
    await pool.query("DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'");
    await pool.query("DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day'");
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
  }
}

interface CodeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
}

/** A new code, for scopes per area (never a legacy grant). `platformAdmin`: approved by a platform admin, not a team member. */
async function issueCode(pool: Pool, request: CodeRequest, owner: TokenOwner, scope: string, platformAdmin = false): Promise<string> {
  const code = randomToken();
  await pool.query(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, api_key_id, user_id, tenant_id, product_id, scope, resource, expires_at, legacy_scope, platform_admin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11), false, $12)`,
    [sha256(code), request.clientId, request.redirectUri, request.codeChallenge, owner.apiKeyId ?? null, owner.userId ?? null, owner.tenantId ?? null, owner.apiKeyId ? null : owner.productId, scope, request.resource, CODE_TTL_S, platformAdmin],
  );
  return code;
}

/** Whether "Sign in with your website" should offer changes: unless the app asked to look only, or used the read-only endpoint. */
function siteWantsWrite(requested: string[], resource: string): boolean {
  if (resource.endsWith('/read-only')) return false;
  return requested.length === 0 || requested.some((s) => s.endsWith(':write'));
}

function codeRedirect(redirectUri: string, code: string, state: string | null | undefined, issuer: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state !== undefined && state !== null) target.searchParams.set('state', state);
  target.searchParams.set('iss', issuer);
  return target.toString();
}

/**
 * The dashboard's half of signing in as a person (AUTH_URL/connect/<id>): read a waiting approval,
 * then approve it for one of the person's storefronts, with the scopes they ticked, or decline.
 * Mounted in /account, so the caller is the signed-in person whose session the dashboard's server
 * passes on. When the dashboard's server also sends the admin token, it vouches that this person is
 * a platform admin: they see every storefront and may grant what an owner may.
 */
export function connectRoutes(deps: Deps, caller: (c: Context<AppEnv>) => Promise<SessionCaller | null>) {
  const { pool } = deps;
  const app = new Hono<AppEnv>();
  type Row = {
    id: string;
    client_id: string;
    client_name: string;
    redirect_uri: string;
    state: string | null;
    code_challenge: string;
    scope: string;
    resource: string;
    issuer: string;
    legacy_scope: boolean;
  };
  type Storefront = { productId: string; name: string; role: string; canChange: boolean };

  /** Whether the dashboard's server sent the admin token: the person is one of its platform admins. */
  const platformAdmin = (c: Context<AppEnv>) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
    return !!deps.config.adminToken && !!match && tokenMatches(match[1]!, deps.config.adminToken);
  };

  async function load(c: Context<AppEnv>) {
    const me = await caller(c);
    if (!me) throw new HttpError(403, 'Sign in first');
    const id = c.req.param('id')!;
    const { rows } = isUuid(id) ? await pool.query<Row>('SELECT * FROM oauth_requests WHERE id = $1 AND tenant_id IS NULL AND expires_at > now()', [id]) : { rows: [] };
    if (!rows[0]) throw new HttpError(404, 'This connection request has expired. Go back to the app and connect again.');
    const asAdmin = platformAdmin(c);
    // The person's own storefronts, then, for a platform admin, every other one.
    const storefronts: Storefront[] = me.memberships.map((m) => ({ productId: m.productId, name: m.productName, role: m.role, canChange: asAdmin || mayChange(m.role) }));
    if (asAdmin) {
      const others = await pool.query<{ id: string; name: string }>('SELECT id, name FROM products WHERE NOT (id = ANY($1::uuid[])) ORDER BY name, id', [
        storefronts.map((s) => s.productId),
      ]);
      storefronts.push(...others.rows.map((p) => ({ productId: p.id, name: p.name, role: 'platform admin', canChange: true })));
    }
    const requested = rows[0].legacy_scope ? expandLegacyScopes(rows[0].scope) : parseScopes(rows[0].scope);
    return { me, row: rows[0], storefronts, asAdmin, requested, readOnly: rows[0].resource.endsWith('/read-only') };
  }

  app.get('/oauth/requests/:id', async (c) => {
    const { row, storefronts, asAdmin, requested, readOnly } = await load(c);
    return c.json({
      id: row.id,
      clientName: row.client_name,
      returnTo: returnHost(row.redirect_uri),
      requestedScopes: requested,
      wantsWrite: requested.some((s) => s.endsWith(':write')),
      readOnly,
      // One row per area: a box to see and a box to change, ticked to start with as described.
      areas: AREAS.map((area) => ({
        area,
        name: AREA_LABELS[area].name,
        read: { scope: scopeOf(area, 'read'), label: AREA_LABELS[area].read, ticked: true },
        write: readOnly ? null : { scope: scopeOf(area, 'write'), label: AREA_LABELS[area].write, ticked: requested.includes(scopeOf(area, 'write')) },
      })),
      asAdmin,
      storefronts,
    });
  });

  // { action: 'approve', productId, scopes: ['stores:read', …] } or { action: 'deny' }. Answers where to send the browser.
  // (An older dashboard sends allowWrite instead of scopes: every read scope, and the write scopes asked for when ticked.)
  app.post('/oauth/requests/:id', async (c) => {
    const { me, row, storefronts, asAdmin, requested, readOnly } = await load(c);
    const body = ((await readJson(c)) ?? {}) as { action?: unknown; productId?: unknown; scopes?: unknown; allowWrite?: unknown };
    if (body.action !== 'approve' && body.action !== 'deny') throw badRequest("action must be 'approve' or 'deny'");
    const storefront = storefronts.find((s) => s.productId === body.productId);
    let scopes: string[] = [];
    if (body.action === 'approve') {
      if (!storefront) throw badRequest('Choose one of your storefronts');
      if (body.scopes !== undefined) {
        if (!Array.isArray(body.scopes) || body.scopes.some((s) => typeof s !== 'string' || !isScope(s))) throw badRequest(`scopes must list some of ${ALL_SCOPES.join(' ')}`);
        scopes = withReads(parseScopes(body.scopes as string[]));
      } else {
        const writes = requested.filter((s) => s.endsWith(':write'));
        scopes = [...READ_SCOPES, ...(body.allowWrite === true ? (writes.length ? writes : WRITE_SCOPES) : [])];
      }
      // Changes need a role that may make them, and an endpoint that isn't read-only.
      if (readOnly || !storefront.canChange) scopes = readsOnly(scopes);
      scopes = parseScopes(scopes);
      if (!scopes.length) throw badRequest('Tick at least one thing the app may see');
    }
    // Single use, whichever way it goes.
    const { rowCount } = await pool.query('DELETE FROM oauth_requests WHERE id = $1', [row.id]);
    if (!rowCount) throw new HttpError(404, 'This connection request was already used. Go back to the app and connect again.');
    if (body.action === 'deny' || !storefront) {
      return c.json({ redirectUrl: errorRedirect(row.redirect_uri, 'access_denied', 'The user declined', row.state ?? undefined, row.issuer) });
    }
    const code = await issueCode(
      pool,
      { clientId: row.client_id, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge, resource: row.resource },
      { productId: storefront.productId, userId: me.user.id },
      scopes.join(' '),
      // A platform admin's grant stands on its own, not on a team role.
      asAdmin,
    );
    return c.json({ redirectUrl: codeRedirect(row.redirect_uri, code, row.state, row.issuer) });
  });

  return app;
}

/** Where an app sends the browser back to, for people to read: its host, or its own scheme. */
function returnHost(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : `${url.protocol}//`;
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

async function readForm(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  if ((c.req.header('Content-Type') ?? '').includes('application/json')) return ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  return (await c.req.parseBody()) as Record<string, unknown>;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https anywhere, http only on this machine (RFC 8252), and app schemes such as cursor://, never script or file URLs. */
function allowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  return !['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'about:'].includes(url.protocol);
}

/** Exact match, except a loopback redirect may use any port (RFC 8252 7.3). */
function sameRedirectUri(registered: string, requested: string): boolean {
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

/** A Client ID Metadata Document URL: https with a path, and not an address on this network. */
function isMetadataDocumentUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.pathname === '/' || url.hash || url.username || url.password) return false;
  const host = url.hostname;
  if (LOOPBACK.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  // IP literals (v4, or bracketed v6) are refused outright: a client id names a site.
  return !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.startsWith('[') && host.includes('.');
}

function errorRedirect(redirectUri: string, error: string, description: string, state: string | undefined, issuer: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state !== undefined) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

function page(c: Context<AppEnv>, html: string, status: 200 | 400 | 401 = 200) {
  return c.html(html, status, {
    // No form-action: browsers apply it to the redirect after the form, and apps return to their own schemes.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
}

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const STYLE = `
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --bg: #fff; --card: #f6f8fa; --accent: #1f6feb; --bad: #cf222e; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --bg: #0d1117; --card: #151b23; --accent: #4493f8; --bad: #f85149; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 440px; margin: 48px auto; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  h2 { font-size: 16px; margin: 0 0 4px; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); font-size: 13px; }
  ul { margin: 0 0 16px; padding-left: 20px; }
  label { display: block; font-weight: 600; font-size: 13px; margin: 12px 0 4px; }
  input[type=text] { width: 100%; font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: inherit; }
  .buttons { display: flex; flex-direction: row-reverse; gap: 8px; margin-top: 20px; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; flex: 1; }
  .error { color: var(--bad); font-weight: 600; }
  code { font-size: 13px; }
  .or { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line); }
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><div class="card">${body}</div></main></body></html>`;
}

function errorPage(message: string): string {
  return shell('Cannot connect', `<h1>Cannot connect this app</h1><p>${esc(message)}</p><p class="muted">Go back to the app and try connecting again.</p>`);
}

/** What an app asks for, in plain words: an area it may see, or see and change. */
function askedFor(request: AuthorizeRequest): string[] {
  if (!request.scope.length) return ['You choose what it may see and change after you sign in'];
  return AREAS.filter((area) => request.scope.includes(scopeOf(area, 'read')) || request.scope.includes(scopeOf(area, 'write'))).map(
    (area) => `${AREA_LABELS[area].name}: ${request.scope.includes(scopeOf(area, 'write')) ? 'see and change' : 'see'}`,
  );
}

function approvePage(request: AuthorizeRequest, params: Record<string, string | undefined>, signIn?: string, siteError?: string, error?: string): string {
  const keep = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];
  const hidden = keep
    .filter((name) => params[name] !== undefined)
    .map((name) => `<input type="hidden" name="${name}" value="${esc(params[name]!)}">`)
    .join('');
  const where = returnHost(request.redirectUri);
  const cancel = `<button type="submit" name="action" value="deny">Cancel</button>`;
  // One website's owner (the /mcp/site address): they type their site and approve in its WordPress dashboard.
  if (isSiteResource(request.resource)) {
    return shell(
      'Connect your website',
      `<h1>Connect ${esc(request.client.name)}</h1>
<p><strong>${esc(request.client.name)}</strong> wants to edit your website's pages and design, and nothing else.</p>
<p class="muted">Type your website's address, then approve in its WordPress dashboard. After you approve, you go back to <code>${esc(where)}</code>.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden}
<label for="site">Your website</label><input type="text" id="site" name="site" required spellcheck="false" placeholder="mybakery.com" value="${esc(params.site ?? '')}">
${siteError ? `<p class="error" role="alert">${esc(siteError)}</p>` : ''}
<div class="buttons"><button type="submit" name="action" value="site" class="primary">Continue to your website</button></div>
</form>
<form method="post" action="/oauth/authorize">${hidden}<div class="buttons">${cancel}</div></form>`,
    );
  }
  return shell(
    'Connect to your stores',
    `<h1>Connect ${esc(request.client.name)}</h1>
<p><strong>${esc(request.client.name)}</strong> wants to use your stores. It asks for:</p>
<ul>${askedFor(request)
      .map((line) => `<li>${esc(line)}</li>`)
      .join('')}</ul>
<p class="muted">You pick what it may see and change, area by area, before you approve. After you approve, you go back to <code>${esc(where)}</code>.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden}<div class="buttons">${
      signIn ? `<button type="submit" name="action" value="signin" class="primary">Sign in to ${esc(signIn)}</button>` : ''
    }${cancel}</div></form>`,
  );
}

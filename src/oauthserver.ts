// The OAuth 2.1 authorization server AI apps sign in with to use the MCP server (src/mcp.ts) and the
// HighLevel app (/apps): Better Auth's official MCP plugin (@better-auth/mcp, which is its OAuth
// provider configured for MCP), Client ID Metadata Documents (@better-auth/cimd) and its JWT plugin,
// which signs the access tokens. Configured here to do what AnyPress needs:
//
// - The API stays the authorization server's identity (the issuer is PUBLIC_URL), but people sign in
//   and approve on the dashboard (AUTH_URL), where their session lives: its /connect page is the
//   plugin's login, post-login and consent page. There they pick one storefront and tick what the app
//   may see and change, area by area (mcp/src/scopes.ts). The storefront is the consent's reference
//   (`product:<id>`, or `admin:<id>` for a platform admin), and every access token carries it.
// - "Sign in with your website" (/mcp/site): the store's wp-admin approves, and the store gets its own
//   Better Auth user (`storeTenantId`), so its grant is `tenant:<id>` and only edits that site.
// - Every token asks for offline_access, so connections refresh for 30 days like before, and a token
//   without a resource is for /mcp.
// - Each access token is re-checked when it is used and refreshed (src/oauth.ts): the person must still
//   be on the storefront's team, a member only looks, and a store's grant ends with the store.
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';
import type { BetterAuthPlugin } from 'better-auth';
import type { Pool } from './db.ts';
import { ALL_SCOPES, READ_SCOPES } from '../mcp/src/scopes.ts';

/** The protected resources tokens are for (RFC 8707), by path on the API. /mcp is the default. */
export const MCP_PATHS = ['/mcp', '/mcp/read-only', '/mcp/site'] as const;
export const APPS_PATH = '/apps';
export const RESOURCE_PATHS = [...MCP_PATHS, APPS_PATH] as const;

/** The scope that gets a refresh token; always added to what an app asks for. */
export const OFFLINE = 'offline_access';

/** The dashboard page that signs the person in, has them pick a storefront and tick scopes, and approves. */
export const CONNECT_PAGE = '/connect';

/** Access tokens last an hour, refresh tokens 30 days (as before the plugin). */
const ACCESS_TTL_S = 60 * 60;

/** What an app that names no scopes may be given at each resource: everything there, and the person ticks what it gets. */
function defaultScopes(resourcePath: string): readonly string[] {
  if (resourcePath === APPS_PATH) return ['stores:read', 'stores:write', 'webhooks:read', 'webhooks:write'];
  if (resourcePath === '/mcp/read-only') return READ_SCOPES;
  if (resourcePath === '/mcp/site') return ['site:read', 'site:write'];
  return ALL_SCOPES;
}
const REFRESH_TTL_S = 30 * 24 * 60 * 60;

/**
 * Who a grant is for, as the consent's reference id: a storefront for a person on its team, a
 * storefront a platform admin approved for, or one store ("Sign in with your website").
 */
export type GrantReference = { kind: 'product'; productId: string } | { kind: 'admin'; productId: string } | { kind: 'tenant'; tenantId: string };

export const referenceId = (ref: GrantReference) => (ref.kind === 'tenant' ? `tenant:${ref.tenantId}` : `${ref.kind}:${ref.productId}`);

function parseReference(value: string | undefined | null): GrantReference | null {
  const match = /^(product|admin|tenant):([0-9a-f-]{36})$/i.exec(value ?? '');
  if (!match) return null;
  const [, kind, id] = match;
  return kind === 'tenant' ? { kind, tenantId: id! } : { kind: kind as 'product' | 'admin', productId: id! };
}

/** The storefront (or store) picked for the sign-in a session is in the middle of, set by src/oauth.ts. */
async function pickFor(pool: Pool, sessionId: string): Promise<string | null> {
  const { rows } = await pool.query<{ reference: string }>(
    "SELECT reference FROM oauth_connect_picks WHERE session_id = $1 AND created_at > now() - interval '10 minutes'",
    [sessionId],
  );
  return rows[0]?.reference ?? null;
}

/** The claims every access token carries for the API: whose it is. Checked again on each call (src/oauth.ts). */
export const CLAIMS = { product: 'product_id', tenant: 'tenant_id', admin: 'platform_admin' } as const;

/**
 * Whether a grant may still be used: the store still exists; for a person, they are still on the
 * storefront's team (or its reseller's); for a platform admin's grant, the storefront still exists.
 * Answers the storefront's product id, or null when the grant is over.
 */
async function grantProduct(pool: Pool, ref: GrantReference, userId: string | undefined): Promise<string | null> {
  if (ref.kind === 'tenant') {
    const { rows } = await pool.query<{ product_id: string }>('SELECT product_id FROM tenants WHERE id = $1', [ref.tenantId]);
    return rows[0]?.product_id ?? null;
  }
  if (ref.kind === 'admin') {
    const { rowCount } = await pool.query('SELECT 1 FROM products WHERE id = $1', [ref.productId]);
    return rowCount ? ref.productId : null;
  }
  if (!userId) return null;
  return (await memberRole(pool, userId, ref.productId)) ? ref.productId : null;
}

/** A person's role on a storefront's team (or its reseller's), or null when they're not on it. */
export async function memberRole(pool: Pool, userId: string, productId: string): Promise<string | null> {
  const { rows } = await pool.query<{ role: string }>(
    `SELECT m.role FROM auth.member m JOIN auth.organization o ON o.id = m."organizationId"
      WHERE m."userId" = $1 AND (o."productId" = $2 OR o."resellerId" = (SELECT p.reseller_id FROM products p WHERE p.id = $2))
      ORDER BY (o."productId" IS NULL) LIMIT 1`,
    [userId, productId],
  );
  return rows[0]?.role ?? null;
}

export function mcpSignInPlugins(pool: Pool, options: { apiUrl: string; clientMetadataFetch?: ClientMetadataResourceFetch }): BetterAuthPlugin[] {
  const api = options.apiUrl;
  const resources = RESOURCE_PATHS.map((path) => `${api}${path}`);
  const scopes = [...ALL_SCOPES, OFFLINE];

  /** Before the plugin reads an authorization request: a default resource, and a refresh token always. */
  const authorizeDefaults: BetterAuthPlugin = {
    id: 'anypress-authorize-defaults',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/oauth2/authorize',
          handler: createAuthMiddleware(async (ctx) => {
            const query = { ...(ctx.query ?? {}) } as Record<string, unknown>;
            if (query.resource === undefined || query.resource === '') query.resource = `${api}/mcp`;
            // An app that names no scopes (HighLevel's install, for one) asks for what the resource offers.
            const named = typeof query.scope === 'string' ? query.scope.split(/\s+/).filter(Boolean) : [];
            const resource = typeof query.resource === 'string' && query.resource.startsWith(api) ? query.resource.slice(api.length) : '/mcp';
            const asked = named.length ? named : [...defaultScopes(resource)];
            query.scope = (asked.includes(OFFLINE) ? asked : [...asked, OFFLINE]).join(' ');
            return { context: { query } };
          }),
        },
      ],
    },
  };

  return [
    jwt({
      // The API is the issuer; the dashboard only hosts the pages (and proxies the endpoints).
      jwt: { issuer: api },
      disableSettingJwtHeader: true,
    }) as unknown as BetterAuthPlugin,
    authorizeDefaults,
    mcp({
      resource: `${api}/mcp`,
      resources: resources.slice(1),
      // Every enabled resource may be asked for by any app; what it gets is what the person ticks.
      enforcePerClientResources: false,
      scopes,
      advertisedMetadata: { scopes_supported: [...ALL_SCOPES] },
      grantTypes: ['authorization_code', 'refresh_token'],
      accessTokenExpiresIn: ACCESS_TTL_S,
      refreshTokenExpiresIn: REFRESH_TTL_S,
      // Apps register themselves (RFC 7591), as Claude, ChatGPT, the HighLevel app and the website
      // assistant always have; Client ID Metadata Documents come through cimd() below.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: 'infer',
      loginPage: CONNECT_PAGE,
      consentPage: CONNECT_PAGE,
      postLogin: {
        page: CONNECT_PAGE,
        // The person picks a storefront on /connect, then src/oauth.ts continues; a store's own sign-in is picked already.
        shouldRedirect: async ({ session, isContinuation }) => {
          const pick = await pickFor(pool, session.id);
          return !(pick && (isContinuation || pick.startsWith('tenant:')));
        },
        consentReferenceId: async ({ session }) => {
          const pick = await pickFor(pool, session.id);
          if (!pick) throw new APIError('BAD_REQUEST', { error: 'invalid_request', error_description: 'Pick a storefront first' });
          return pick;
        },
      },
      // Whose the token is. A grant that is over (the person left the team, the store was deleted) gets no new token.
      customAccessTokenClaims: async ({ user, referenceId: reference }) => {
        const ref = parseReference(reference);
        const productId = ref ? await grantProduct(pool, ref, user?.id) : null;
        if (!ref || !productId) {
          throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'This connection is no longer allowed. Connect the app again.' });
        }
        return {
          [CLAIMS.product]: productId,
          ...(ref.kind === 'tenant' ? { [CLAIMS.tenant]: ref.tenantId } : {}),
          ...(ref.kind === 'admin' ? { [CLAIMS.admin]: true } : {}),
        };
      },
    }) as unknown as BetterAuthPlugin,
    cimd({
      fetchClientMetadataResource: options.clientMetadataFetch ?? fetchClientMetadataResource,
      metadataProfile: 'mcp-2026-07-28',
    }) as unknown as BetterAuthPlugin,
  ];
}

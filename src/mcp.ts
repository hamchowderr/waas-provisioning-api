// The MCP server (mcp/) over Streamable HTTP at /mcp, so an AI agent can manage stores without
// running anything locally. Callers sign in with an OAuth access token (src/oauth.ts; what Claude
// and ChatGPT connectors use), which offers only the tools and actions of the scopes it was granted
// (mcp/src/scopes.ts), or with the same Basic auth as /v1, which offers every tool. Tool calls go through the /v1
// routes in-process, so they get the same checks and land in the request log. A store owner's token
// ("Sign in with your website") gets only the site tools, and only for that store.
import { createMcpHandler, requireBearerAuth } from '@modelcontextprotocol/server';
import type { Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { WaasClient } from 'waas-provisioning-sdk';
import { createWaasMcpServer } from '../mcp/src/server.ts';
import type { AppEnv, Deps } from './app.ts';
import { authenticate } from './keys.ts';
import { MCP_PATHS, protectedResourceMetadataUrl, publicBase, scopesFor, verifyAccessToken, type TokenOwner } from './oauth.ts';

type Caller = TokenOwner & { readOnly: boolean; scopes: string[]; [key: string]: unknown };

export function mcpRoutes(app: Hono<AppEnv>, deps: Deps) {
  const handler = createMcpHandler(
    (ctx) => {
      const { productId, apiKeyId, userId, tenantId, readOnly, scopes } = ctx.authInfo!.extra as unknown as Caller;
      const internalAuth = { productId, apiKeyId, userId };
      // The /v1 routes sign this caller in from internalAuth; the key and secret here are never checked.
      const client = new WaasClient({
        baseUrl: 'http://in-process',
        apiKey: 'mcp',
        apiSecret: 'mcp',
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          if (tenantId) {
            // One store's owner: its site routes, whatever store the call names.
            if (url.pathname !== '/v1/tenants/site') return Response.json({ statusCode: 403, message: 'This connection can only edit its own website' }, { status: 403 });
            url.search = `?tenantId=${tenantId}`;
          }
          return app.request(`${url.pathname}${url.search}`, init, { internalAuth });
        }) as typeof fetch,
      });
      return createWaasMcpServer(client, { readOnly, scopes, store: tenantId ? { tenantId } : undefined });
    },
    { onerror: (error) => console.error('mcp:', error.message) },
  );

  const verifier = { verifyAccessToken: (token: string) => verifyAccessToken(deps.pool, token) };

  const serve = async (c: Context<AppEnv>, path: (typeof MCP_PATHS)[number]) => {
    const base = publicBase(c, deps.config.publicUrl);
    const resourceMetadataUrl = protectedResourceMetadataUrl(base, path);
    const header = c.req.header('Authorization') ?? '';
    const readOnlyPath = path === '/mcp/read-only';

    if (/^Bearer\s/i.test(header)) {
      const auth = await requireBearerAuth({ verifier, requiredScopes: [], expectedResource: new URL(`${base}${path}`), resourceMetadataUrl })(c.req.raw);
      if (auth instanceof Response) return auth;
      // A person who may now only look keeps the read scopes; a token with none left can do nothing here.
      if (!auth.scopes.length) {
        return c.json({ error: 'insufficient_scope', error_description: 'This connection may not see anything. Connect the app again.' }, 403, {
          'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scopesFor(path).join(' ')}", resource_metadata="${resourceMetadataUrl}"`,
        });
      }
      const owner = auth.extra as unknown as TokenOwner;
      const caller: Caller = { ...owner, readOnly: readOnlyPath, scopes: auth.scopes };
      return handler.fetch(c.req.raw, { authInfo: { ...auth, extra: caller } });
    }

    // /mcp/site is only for one website's owner, who signs in with the website; an API key uses /mcp.
    const basic = path === '/mcp/site' ? null : /^Basic\s+(\S+)$/i.exec(header);
    if (basic) {
      const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const key = colon > 0 ? decoded.slice(0, colon) : '';
      const productId = key ? await authenticate(deps.pool, key, decoded.slice(colon + 1)) : null;
      if (productId) {
        const scopes = [...scopesFor(path)];
        const caller: Caller = { productId, apiKeyId: key, readOnly: readOnlyPath, scopes };
        return handler.fetch(c.req.raw, { authInfo: { token: key, clientId: productId, scopes, extra: caller } });
      }
    }

    // No (valid) credentials: point OAuth clients at the sign-in (RFC 9728), and offer Basic too.
    const scope = scopesFor(path).join(' ');
    const site = path === '/mcp/site';
    return c.json({ error: 'invalid_token', error_description: site ? 'Sign in with your website' : 'Sign in with OAuth, or with your API key and secret (Basic auth)' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scope}"${site ? '' : ', Basic realm="waas-mcp"'}`,
    });
  };

  // Browser-based MCP clients call /mcp cross-origin; credentials go in headers, never cookies.
  const open = cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'MCP-Protocol-Version', 'Mcp-Session-Id', 'Last-Event-ID'],
    exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
  });
  for (const path of MCP_PATHS) {
    app.use(path, open);
    app.all(path, (c) => serve(c, path));
  }
}

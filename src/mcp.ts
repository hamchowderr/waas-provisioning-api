// The MCP server (mcp/) over Streamable HTTP at /mcp, so an AI agent can manage stores without
// running anything locally. Callers sign in with an OAuth access token (src/oauth.ts; what Claude
// and ChatGPT connectors use) or with the same Basic auth as /v1. Tool calls go through the /v1
// routes in-process, so they get the same checks and land in the request log.
import { createMcpHandler, requireBearerAuth } from '@modelcontextprotocol/server';
import type { Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { WaasClient } from 'waas-provisioning-sdk';
import { createWaasMcpServer } from '../mcp/src/server.ts';
import type { AppEnv, Deps } from './app.ts';
import { authenticate } from './keys.ts';
import { MCP_PATHS, protectedResourceMetadataUrl, publicBase, SCOPE_READ, SCOPE_WRITE, verifyAccessToken, type TokenOwner } from './oauth.ts';

type Caller = TokenOwner & { readOnly: boolean; [key: string]: unknown };

export function mcpRoutes(app: Hono<AppEnv>, deps: Deps) {
  const handler = createMcpHandler(
    (ctx) => {
      const { productId, apiKeyId, userId, readOnly } = ctx.authInfo!.extra as unknown as Caller;
      const internalAuth = { productId, apiKeyId, userId };
      // The /v1 routes sign this caller in from internalAuth; the key and secret here are never checked.
      const client = new WaasClient({
        baseUrl: 'http://in-process',
        apiKey: 'mcp',
        apiSecret: 'mcp',
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          return app.request(`${url.pathname}${url.search}`, init, { internalAuth });
        }) as typeof fetch,
      });
      return createWaasMcpServer(client, { readOnly });
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
      const auth = await requireBearerAuth({ verifier, requiredScopes: [SCOPE_READ], expectedResource: new URL(`${base}${path}`), resourceMetadataUrl })(c.req.raw);
      if (auth instanceof Response) return auth;
      const owner = auth.extra as unknown as TokenOwner;
      const caller: Caller = { ...owner, readOnly: readOnlyPath || !auth.scopes.includes(SCOPE_WRITE) };
      return handler.fetch(c.req.raw, { authInfo: { ...auth, extra: caller } });
    }

    const basic = /^Basic\s+(\S+)$/i.exec(header);
    if (basic) {
      const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const key = colon > 0 ? decoded.slice(0, colon) : '';
      const productId = key ? await authenticate(deps.pool, key, decoded.slice(colon + 1)) : null;
      if (productId) {
        const caller: Caller = { productId, apiKeyId: key, readOnly: readOnlyPath };
        return handler.fetch(c.req.raw, { authInfo: { token: key, clientId: productId, scopes: readOnlyPath ? [SCOPE_READ] : [SCOPE_READ, SCOPE_WRITE], extra: caller } });
      }
    }

    // No (valid) credentials: point OAuth clients at the sign-in (RFC 9728), and offer Basic too.
    const scope = readOnlyPath ? SCOPE_READ : `${SCOPE_READ} ${SCOPE_WRITE}`;
    return c.json({ error: 'invalid_token', error_description: 'Sign in with OAuth, or with your API key and secret (Basic auth)' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scope}", Basic realm="waas-mcp"`,
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

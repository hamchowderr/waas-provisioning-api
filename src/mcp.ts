// The MCP server (mcp/) over Streamable HTTP at /mcp, so an AI agent can manage stores without
// running anything locally. Callers sign in with the same Basic auth as /v1; each tool call goes
// through the /v1 routes in-process, so it gets the same checks and lands in the request log.
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Context, Hono } from 'hono';
import { WaasClient } from 'waas-provisioning-sdk';
import { createWaasMcpServer } from '../mcp/src/server.ts';
import type { AppEnv } from './app.ts';
import type { Pool } from './db.ts';
import { authenticate } from './keys.ts';

type Credentials = { key: string; secret: string; readOnly: boolean };

export function mcpRoutes(app: Hono<AppEnv>, pool: Pool) {
  const handler = createMcpHandler(
    (ctx) => {
      const { key, secret, readOnly } = ctx.authInfo!.extra as Credentials;
      const client = new WaasClient({ baseUrl: 'http://in-process', apiKey: key, apiSecret: secret, fetch: inProcess(app) });
      return createWaasMcpServer(client, { readOnly });
    },
    { onerror: (error) => console.error('mcp:', error.message) },
  );

  const serve = async (c: Context<AppEnv>, readOnly: boolean) => {
    const match = /^Basic\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
    const decoded = match ? Buffer.from(match[1]!, 'base64').toString('utf8') : '';
    const colon = decoded.indexOf(':');
    const key = colon > 0 ? decoded.slice(0, colon) : '';
    const secret = decoded.slice(colon + 1);
    const productId = key ? await authenticate(pool, key, secret) : null;
    if (!productId) {
      return c.json({ statusCode: 401, message: 'Sign in with your API key and secret (Basic auth)' }, 401, {
        'WWW-Authenticate': 'Basic realm="waas-mcp"',
      });
    }
    const extra: Credentials = { key, secret, readOnly };
    return handler.fetch(c.req.raw, { authInfo: { token: key, clientId: productId, scopes: readOnly ? ['read'] : ['read', 'write'], extra } });
  };

  app.all('/mcp', (c) => serve(c, false));
  app.all('/mcp/read-only', (c) => serve(c, true));
}

/** A fetch that hands the SDK's requests straight to the app, without leaving the process. */
function inProcess(app: Hono<AppEnv>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    return app.request(`${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

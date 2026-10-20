import { Hono } from 'hono';
import type { PgBoss } from 'pg-boss';
import { accountRoutes, sessionAuth, type SessionCaller } from './accounts.ts';
import type { Auth } from './auth.ts';
import type { Config } from './config.ts';
import type { Pool } from './db.ts';
import type { DomainConnectNet } from './domainconnect.ts';
import { HttpError } from './errors.ts';
import { isUuid } from './http.ts';
import { authenticate } from './keys.ts';
import { checkHealth } from './health.ts';
import { mcpRoutes } from './mcp.ts';
import { oauthRoutes } from './oauth.ts';
import { buildPublicSpec, docsPage } from './publicspec.ts';
import { requestLogger } from './requestlog.ts';
import { adminRoutes } from './routes/admin.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import type { ReleaseStore } from './releases.ts';
import type { Secrets } from './secrets.ts';
import { baseSnapshotRoutes } from './routes/basesnapshots.ts';
import { domainRoutes } from './routes/domains.ts';
import { lifecycleRoutes } from './routes/lifecycle.ts';
import { siteRoutes } from './routes/site.ts';
import { keyRoutes } from './routes/keys.ts';
import { domainConnectRoutes } from './routes/domainconnect.ts';
import { mailDomainRoutes } from './routes/maildomains.ts';
import { pluginRoutes } from './routes/plugins.ts';
import { snapshotRoutes } from './routes/snapshots.ts';
import { tenantRoutes } from './routes/tenants.ts';
import { versionRoutes } from './routes/versions.ts';
import { webhookRoutes } from './routes/webhooks.ts';

export interface Deps {
  config: Config;
  pool: Pool;
  boss: PgBoss;
  provisioner: Provisioner;
  secrets: Secrets;
  /** Plugin releases (waas-hw4); absent when RELEASES_S3_BUCKET is not set. */
  releases?: ReleaseStore;
  /** DNS and HTTP for Domain Connect lookups; tests replace it. */
  domainConnectNet?: DomainConnectNet;
  /** Fetches OAuth Client ID Metadata Documents (src/oauth.ts); tests replace it. */
  clientMetadataFetch?: typeof fetch;
  /** Calls stores' site-editing routes (src/sitekeys.ts); tests replace it. */
  siteFetch?: typeof fetch;
  /** Sign-in for people (src/auth.ts); absent when AUTH_URL and AUTH_SECRET are not set. */
  auth?: Auth;
}

/**
 * `internalAuth` is only ever set by an in-process call (the MCP server at /mcp, src/mcp.ts), which
 * has already signed the caller in. Requests from outside can't set Bindings.
 */
export type AppEnv = {
  Bindings: { internalAuth?: { productId: string; apiKeyId?: string; userId?: string } };
  /** scopeProductId: the product a signed-in customer acts for on /account (src/routes/admin.ts). */
  Variables: { productId: string; apiKeyId?: string; userId?: string; sessionCaller?: SessionCaller; scopeProductId?: string };
};

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  // For uptime monitoring; outside /v1 and unauthenticated. 503 when Postgres or
  // the job queue doesn't answer within 3 seconds. `dbBackup` reports the last off-site database
  // backup (no object keys or errors here; those are in /admin/db-backups) and never causes a 503.
  app.get('/health', async (c) => {
    const health = await checkHealth(deps.pool, deps.boss, !!deps.config.dbBackup);
    return c.json(health, health.ok ? 200 : 503);
  });

  // The public API reference, unauthenticated like /health. Built on first request, once every
  // route below is registered, so it lists exactly the operations this server answers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let publicSpec: any;
  app.get('/openapi.json', (c) => {
    publicSpec ??= buildPublicSpec(new Set(app.routes.map((r) => `${r.method} ${r.path}`)));
    return c.json(publicSpec);
  });
  app.get('/docs', (c) => c.html(docsPage));

  // The request log (src/requestlog.ts): every /v1 call, failed sign-ins included, and admin changes.
  const logDays = deps.config.requestLogDays ?? 30;
  app.use('/admin/*', requestLogger(deps.pool, 'admin', logDays));
  app.use('/v1/*', requestLogger(deps.pool, 'v1', logDays));

  app.route('/admin', adminRoutes(deps));

  // Better Auth's own routes (src/auth.ts). The dashboard proxies /api/auth/* here from its origin.
  app.on(['GET', 'POST'], '/api/auth/*', (c) =>
    deps.auth ? deps.auth.handler(c.req.raw) : c.json({ statusCode: 404, message: 'Sign-in is off on this server' }, 404),
  );
  app.use('/account/*', requestLogger(deps.pool, 'account', logDays));
  app.route('/account', accountRoutes(deps));

  // A signed-in customer, passed on by the dashboard's server, acts as their organization's product.
  app.use('/v1/*', sessionAuth(deps));

  // Basic auth with the API key as username and the secret as password. Any failure is 403,
  // not 401: the storefront plugin's connection test reads 403 as "invalid key or secret".
  app.use('/v1/*', async (c, next) => {
    if (c.get('userId')) return next();
    const internal = c.env?.internalAuth;
    if (internal) {
      // An API key, or a person who connected an AI app by signing in (src/oauth.ts).
      if (internal.apiKeyId) c.set('apiKeyId', internal.apiKeyId);
      if (internal.userId) c.set('userId', internal.userId);
      c.set('productId', internal.productId);
      return next();
    }
    const match = /^Basic\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
    const decoded = match ? Buffer.from(match[1]!, 'base64').toString('utf8') : '';
    const colon = decoded.indexOf(':');
    const key = colon > 0 ? decoded.slice(0, colon) : '';
    // The key is an id, kept in the request log even when the secret is wrong; anything else typed
    // as the username (a pasted secret, say) is not.
    if (isUuid(key)) c.set('apiKeyId', key);
    const productId = key ? await authenticate(deps.pool, key, decoded.slice(colon + 1)) : null;
    if (!productId) return c.json({ statusCode: 403, message: 'Invalid API key or secret' }, 403);
    c.set('productId', productId);
    await next();
  });

  app.route('/v1/tenants', domainRoutes(deps));
  app.route('/v1/tenants', mailDomainRoutes(deps));
  app.route('/v1/tenants', domainConnectRoutes(deps));
  app.route('/v1/tenants', lifecycleRoutes(deps));
  app.route('/v1/tenants', siteRoutes(deps));
  app.route('/v1/tenants', tenantRoutes(deps));
  app.route('/v1/versions', versionRoutes(deps));
  app.route('/v1/snapshots', snapshotRoutes(deps));
  app.route('/v1/basesnapshots', baseSnapshotRoutes(deps));
  app.route('/v1/plugins', pluginRoutes(deps));
  app.route('/v1/keys', keyRoutes(deps));
  app.route('/v1/webhooks', webhookRoutes(deps));

  // The MCP server and the OAuth sign-in MCP clients use for it (mcp/README.md).
  oauthRoutes(app, deps);
  mcpRoutes(app, deps);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ statusCode: err.status, message: err.message }, err.status);
    console.error(err);
    return c.json({ statusCode: 500, message: 'Internal server error' }, 500);
  });

  return app;
}

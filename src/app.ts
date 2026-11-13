import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { PgBoss } from 'pg-boss';
import { accountRoutes, sessionAuth, type SessionCaller } from './accounts.ts';
import { publicApplicationRoutes } from './applications.ts';
import type { Auth } from './auth.ts';
import { publicBrandingRoutes } from './branding.ts';
import { PRICE_LIST } from './pricing.ts';
import { dashboardHostProduct } from './dashboarddomains.ts';
import type { Config } from './config.ts';
import type { Pool } from './db.ts';
import type { DomainConnectNet } from './domainconnect.ts';
import type { DomainSalesConfig } from './domainsales.ts';
import { HttpError } from './errors.ts';
import { isUuid } from './http.ts';
import type { PlacesSearch } from './prospects.ts';
import { APP_PATHS, highLevelRoutes } from './highlevel.ts';
import { authenticateKey } from './keys.ts';
import { callerAddress, recordWrongKey, tooManyWrongKeys, WRONG_KEY_RETRY_SECONDS } from './keyattempts.ts';
import type { CpuWatch } from './cpuwatch.ts';
import { checkHealth, publicHealth } from './health.ts';
import { iconRoutes } from './icon.ts';
import { mcpRoutes } from './mcp.ts';
import { isAppsResource, oauthRoutes, verifyAccessToken, type TokenOwner } from './oauth.ts';
import { assistantUsageRoutes } from './assistant-usage.ts';
import { demoAssistantRoutes } from './demo-assistant.ts';
import { voiceRoutes } from './voice.ts';
import { buildPublicSpec, docsPage } from './publicspec.ts';
import { requestLogger } from './requestlog.ts';
import { setClientIp } from './clientip.ts';
import { partnerRoutes, PARTNER_ONLY, SHARED_TEMPLATES } from './routes/partner.ts';
import { pluginChoiceRoutes } from './pluginchoices.ts';
import type { WpOrg } from './wporg.ts';
import { demoDraftRoutes } from './demodrafts.ts';
import { importRoutes } from './imports.ts';
import { referenceRoutes } from './references.ts';
import { siteDownloadRoutes } from './sitedownloads.ts';
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
import { supportRoutes } from './support.ts';
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
  /** The server CPU watch for /health (src/cpuwatch.ts); absent when off. */
  cpuWatch?: CpuWatch;
  /** Plugin releases (waas-hw4); absent when RELEASES_S3_BUCKET is not set. */
  releases?: ReleaseStore;
  /** DNS and HTTP for Domain Connect lookups; tests replace it. */
  domainConnectNet?: DomainConnectNet;
  /** Buying domains for stores (src/domainsales.ts); absent when Name.com or Stripe isn't set up. */
  domainSales?: DomainSalesConfig;
  /** The wordpress.org plugin directory, for plugin choices (src/wporg.ts); tests replace it. */
  wporg?: WpOrg;
  /** Calls stores' site-editing routes (src/sitekeys.ts); tests replace it. */
  siteFetch?: typeof fetch;
  /** Sign-in for people (src/auth.ts); absent when AUTH_URL and AUTH_SECRET are not set. */
  auth?: Auth;
  /** Google Places, for the prospect finder (src/prospects.ts); tests replace it. */
  placesSearch?: PlacesSearch;
  /** Posts prospects to sellers' HighLevel webhooks (src/prospectcrm.ts); tests replace it. */
  crmFetch?: typeof fetch;
  /** Calls the support desk's storefront (src/support.ts); tests replace it. */
  supportFetch?: typeof fetch;
}

/**
 * `internalAuth` is only ever set by an in-process call (the MCP server at /mcp, src/mcp.ts), which
 * has already signed the caller in. Requests from outside can't set Bindings.
 */
export type AppEnv = {
  Bindings: { internalAuth?: { productId: string; apiKeyId?: string; userId?: string; storeTenantId?: string } };
  /**
   * scopeProductId: the product a signed-in customer acts for on /account (src/routes/admin.ts).
   * resellerId: set for a partner key, which also sets productId from the productId query.
   * storeTenantId: a store's owner signed in with their website (its MCP connection), who may only reach their own store.
   */
  Variables: { productId: string; apiKeyId?: string; userId?: string; storeTenantId?: string; sessionCaller?: SessionCaller; scopeProductId?: string; resellerId?: string; appScopes?: string[] };
};

/** The sign-in parameters that say where to send the browser afterwards. */
const REDIRECT_PARAMS = ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL', 'redirectTo', 'updateCallbackURL'];

/**
 * The first redirect parameter (in the query or a JSON or form body) that points off `hosts`, or null. A path
 * ("/stores") is fine; so is a full address on one of `hosts`.
 */
async function offSiteRedirect(request: Request, hosts: string[]): Promise<string | null> {
  const url = new URL(request.url);
  const body = request.method === 'POST' ? await formOrJson(request) : {};
  for (const name of REDIRECT_PARAMS) {
    const values: unknown[] = [...url.searchParams.getAll(name), body[name]];
    if (values.some((value) => !onSite(value, hosts))) return name;
  }
  return null;
}

/** A request's JSON or form body as an object; empty for anything else. */
async function formOrJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text().catch(() => '');
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  if (!type.includes('application/json')) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Whether a redirect value stays here: empty, a path, or an http(s) address on one of `hosts`. */
function onSite(value: unknown, hosts: string[]): boolean {
  if (value === undefined || value === null || value === '') return true;
  // "//evil.example" and "/\evil.example" are addresses on another host to a browser.
  return typeof value === 'string' && (/^\/(?![/\\])/.test(value) || onHosts(value, hosts));
}

/** Whether `value` is an http(s) address on one of `hosts`. */
function onHosts(value: string, hosts: string[]): boolean {
  const target = URL.canParse(value) ? new URL(value) : null;
  return /^https?:$/.test(target?.protocol ?? '') && hosts.includes(target!.host.toLowerCase());
}

/** The largest request body the API reads. */
const MAX_BODY_BYTES = 25 * 1024 ** 2;

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  // Every answer gets an X-Request-Id (or keeps the one the caller sent), which error logs repeat.
  app.use('*', requestId());
  // Standard security headers. Logos and icons are shown on other sites (the dashboard, sellers' own
  // addresses), so they may be loaded cross-origin.
  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin', crossOriginOpenerPolicy: false }));
  // Files go straight to storage (upload URLs), so no request needs a big body; this stops one from
  // filling the API's memory. Branding images, the largest bodies, are far below it.
  app.use(
    '*',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ statusCode: 413, message: `The request body is over ${MAX_BODY_BYTES / 1024 ** 2} MB` }, 413) }),
  );

  // For uptime monitoring; outside /v1 and unauthenticated. 503 when Postgres or
  // the job queue doesn't answer within 3 seconds. Only the flags monitors alert on (src/health.ts publicHealth);
  // backup times, failed-job counts and CPU figures are in /admin/overview. A stale backup never causes a 503.
  iconRoutes(app);

  app.get('/health', async (c) => {
    const health = await checkHealth(deps.pool, deps.boss, !!deps.config.dbBackup, !!deps.config.restoreTest, deps.cpuWatch);
    return c.json(publicHealth(health), health.ok ? 200 : 503);
  });

  // The public API reference, unauthenticated like /health. Built on first request, once every
  // route below is registered, so it lists exactly the operations this server answers.
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
  // It answers on AUTH_URL and on sellers' live dashboard addresses (src/dashboarddomains.ts): any other
  // forwarded host is replaced with AUTH_URL's, so links in sign-in emails can't point anywhere else.
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    if (!deps.auth || !deps.config.auth) return c.json({ statusCode: 404, message: 'Sign-in is off on this server' }, 404);
    const own = new URL(deps.config.auth.url);
    const asked = (c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '').split(',')[0]!.trim().toLowerCase();
    const live = asked && asked !== own.host && (await dashboardHostProduct(deps.pool, asked)) ? asked : null;
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-forwarded-host', live ?? own.host);
    headers.set('x-forwarded-proto', own.protocol.replace(':', ''));
    // The browser's own fetch mode, which the dashboard's server passes on (its fetch sends "cors").
    // The plugin's authorization endpoint redirects a browser that navigates and answers JSON otherwise.
    const mode = c.req.header('x-forwarded-sec-fetch-mode');
    if (mode && /^[a-z-]{1,20}$/.test(mode)) headers.set('sec-fetch-mode', mode);
    headers.delete('x-forwarded-sec-fetch-mode');
    setClientIp(headers, deps.config.adminToken);
    // Better Auth trusts every origin here (its allowedHosts is '*', so sellers' addresses resolve), so where a
    // sign-in sends the person afterwards is checked here: a path, or an address on the host this request is for.
    const request = new Request(c.req.raw, { headers });
    const away = await offSiteRedirect(request.clone(), [own.host, live ?? own.host]);
    if (away) return c.json({ statusCode: 400, message: `${away} must be a path on this dashboard` }, 400);
    return deps.auth.handler(request);
  });
  // Applications to sell on the platform, from the marketing site's form (src/applications.ts). No sign-in.
  app.route('/applications', publicApplicationRoutes(deps));
  // Sites moved in from another host: the AnyPress Export plugin, holding an import code (src/imports.ts). No API key,
  // and not in the request log, which would keep the code.
  app.route('/imports', importRoutes(deps));
  // Demos people build on Playground, saved for their checkout (src/demodrafts.ts). No API key.
  app.route('/demos', demoDraftRoutes(deps));
  // Dashboard logos and icons (src/branding.ts). Public: the sign-in page shows them.
  app.route('/branding', publicBrandingRoutes(deps));
  // The one price list (src/pricing.ts). Public: anypress.io and the dashboard show it.
  app.get('/pricing', (c) => c.json(PRICE_LIST, 200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' }));

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
      if (internal.storeTenantId) c.set('storeTenantId', internal.storeTenantId);
      c.set('productId', internal.productId);
      return next();
    }
    // The HighLevel app installed with "Sign in to AnyPress" (OAuth): a token for the /apps resource.
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
    if (bearer && APP_PATHS.test(c.req.path)) {
      const info = await verifyAccessToken(deps, bearer[1]!).catch(() => null);
      // 401, so HighLevel refreshes the token and tries again.
      if (!info || !isAppsResource(info.resource?.pathname ?? '') || (info.expiresAt ?? 0) * 1000 < Date.now()) {
        return c.json({ statusCode: 401, message: 'The AnyPress sign-in for this account has expired. Reconnect the AnyPress app in HighLevel and sign in again' }, 401);
      }
      const owner = info.extra as TokenOwner;
      c.set('productId', owner.productId);
      if ('userId' in owner && owner.userId) c.set('userId', owner.userId);
      if ('apiKeyId' in owner && owner.apiKeyId) c.set('apiKeyId', owner.apiKeyId);
      c.set('appScopes', info.scopes);
      return next();
    }
    const match = /^Basic\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
    let decoded = match ? Buffer.from(match[1]!, 'base64').toString('utf8') : '';
    // The HighLevel app (src/highlevel.ts) sends the key and secret its install was given as headers.
    const appKey = c.req.header('X-AnyPress-Key')?.trim();
    if (!match && appKey && APP_PATHS.test(c.req.path)) decoded = `${appKey}:${c.req.header('X-AnyPress-Secret')?.trim() ?? ''}`;
    const colon = decoded.indexOf(':');
    const key = colon > 0 ? decoded.slice(0, colon) : '';
    // The key is an id, kept in the request log even when the secret is wrong; anything else typed
    // as the username (a pasted secret, say) is not.
    if (isUuid(key)) c.set('apiKeyId', key);
    const ip = callerAddress(c.req.header('cf-connecting-ip'));
    if (key && tooManyWrongKeys(ip)) {
      return c.json({ statusCode: 429, message: 'Too many wrong API keys from this address. Try again in a few minutes' }, 429, { 'Retry-After': String(WRONG_KEY_RETRY_SECONDS) });
    }
    const caller = key ? await authenticateKey(deps.pool, key, decoded.slice(colon + 1)) : null;
    if (!caller) {
      if (key) recordWrongKey(ip);
      // HighLevel shows this message in the workflow's history: say what the install is missing.
      if (!match && APP_PATHS.test(c.req.path)) {
        const message = !appKey
          ? 'The AnyPress app has no API key for this account. Reinstall it from inside the sub-account and enter your AnyPress API key and secret'
          : 'The API key the AnyPress app was given is not an AnyPress API key. Reinstall the app and paste the key and secret from your AnyPress dashboard';
        return c.json({ statusCode: 403, message: isUuid(key) ? 'Invalid API key or secret' : message }, 403);
      }
      return c.json({ statusCode: 403, message: 'Invalid API key or secret' }, 403);
    }
    if (caller.productId) {
      // A storefront's own key ignores any productId query (the contract says so).
      c.set('productId', caller.productId);
      return next();
    }
    // A partner key (docs/resellers.md): the productId query says which of the reseller's storefronts
    // the call is for, and every route below reads it as usual. The partner-only routes need none.
    c.set('resellerId', caller.resellerId!);
    // The HighLevel app's calls name their storefront themselves.
    if (PARTNER_ONLY.test(c.req.path) || APP_PATHS.test(c.req.path)) return next();
    const productId = c.req.query('productId');
    // Templates and plugin choices made with a partner key are the reseller's, shared by all its storefronts: no productId needed.
    if (!productId && SHARED_TEMPLATES.test(c.req.path)) return next();
    if (!productId) return c.json({ statusCode: 400, message: 'productId is required with a partner key' }, 400);
    const own =
      isUuid(productId) &&
      (await deps.pool.query('SELECT 1 FROM products WHERE id = $1 AND reseller_id = $2', [productId, caller.resellerId])).rowCount;
    if (!own) return c.json({ statusCode: 403, message: `Product ${productId} is not one of this partner's storefronts` }, 403);
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
  app.route('/v1/plugin-choices', pluginChoiceRoutes(deps));
  app.route('/v1/keys', keyRoutes(deps));
  app.route('/v1/webhooks', webhookRoutes(deps));
  app.route('/v1', partnerRoutes(deps));
  // Support tickets for the signed-in person, filed with whoever helps them (src/support.ts).
  app.route('/v1/support', supportRoutes(deps));
  // References to build a site from: a website, Shopify shop, Figma file or document (src/references.ts).
  referenceRoutes(app, deps);
  // The AnyPress app for HighLevel: its actions, trigger and install (src/highlevel.ts).
  highLevelRoutes(app, deps);
  // "Download my site" from a store's own wp-admin, signed with its site key (src/sitedownloads.ts).
  siteDownloadRoutes(app, deps);

  // The MCP server and the OAuth sign-in MCP clients use for it (mcp/README.md).
  oauthRoutes(app, deps);
  // The website assistant's monthly allowance per store (src/assistant-usage.ts).
  assistantUsageRoutes(app, deps);
  // The assistant inside a demo on anypress.io/try (src/demo-assistant.ts). Public, capped per demo.
  demoAssistantRoutes(app, deps);
  // The phone receptionist agent's calls about a store, by the number that was called (src/voice.ts).
  voiceRoutes(app, deps);
  mcpRoutes(app, deps);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ statusCode: err.status, message: err.message }, err.status);
    console.error(`request ${c.get('requestId')}:`, err);
    return c.json({ statusCode: 500, message: 'Internal server error' }, 500);
  });

  return app;
}

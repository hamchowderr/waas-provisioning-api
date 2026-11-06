import type { Context, Hono } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import type { PgBoss } from 'pg-boss';
import { withTransaction, type Pool } from './db.ts';
import { enqueue } from './queue.ts';
import { Status } from './status.ts';
import { HIGHLEVEL_SITE_TYPE } from './tenants.ts';
import { badRequest, HttpError } from './errors.ts';
import { isUuid, readJson } from './http.ts';
import type { Secrets } from './secrets.ts';
import { checkEndpointUrl, EVENT_TYPES, generateSecret, type WebhookConfig } from './webhooks.ts';

/**
 * The AnyPress app for HighLevel's Marketplace (integrations/highlevel/README.md). An agency installs it on its
 * sub-accounts; their workflows then create and manage sites with the app's actions and start
 * when a site changes with its trigger.
 *
 * - The install asks for an AnyPress API key and secret (HighLevel's External Authentication), which
 *   HighLevel sends back on every action and trigger call as X-AnyPress-Key and X-AnyPress-Secret.
 *   A partner key adds X-AnyPress-Storefront. So /v1/apps signs in like any other /v1 call. Or the
 *   install signs in to AnyPress (OAuth 2.0, the /apps resource in src/oauth.ts), and HighLevel sends
 *   the person's token instead; someone with no storefront makes one as they approve.
 * - Each site Create site makes keeps its sub-account (extras.locationId): the other actions only find
 *   a sub-account's own sites, and the trigger only fires in the sub-account a site belongs to.
 * - Actions: POST /v1/apps/actions/<action> with HighLevel's {data, extras, meta}. Each answers the
 *   site as flat fields for the workflow's next steps.
 * - The trigger: HighLevel tells POST /v1/apps/triggers when a workflow adds, changes or removes it.
 *   Each one becomes a webhook endpoint of kind 'highlevel' whose url is the trigger's targetUrl,
 *   sent the flat site fields with the sub-account's HighLevel token.
 * - HighLevel's own OAuth install lands on GET /apps/oauth/callback, which keeps the agency's or
 *   sub-account's token (HIGHLEVEL_CLIENT_ID and HIGHLEVEL_CLIENT_SECRET). Paths never say
 *   "HighLevel": its Marketplace refuses addresses that do.
 */

export interface HighLevelConfig {
  clientId: string;
  clientSecret: string;
  /** HighLevel's API, https://services.leadconnectorhq.com unless HIGHLEVEL_API_URL says otherwise. */
  apiUrl: string;
}

export function loadHighLevelConfig(env: NodeJS.ProcessEnv): HighLevelConfig | undefined {
  const clientId = env.HIGHLEVEL_CLIENT_ID?.trim();
  const clientSecret = env.HIGHLEVEL_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) throw new Error('HIGHLEVEL_CLIENT_ID and HIGHLEVEL_CLIENT_SECRET go together: set both, or neither');
  const apiUrl = (env.HIGHLEVEL_API_URL?.trim() || 'https://services.leadconnectorhq.com').replace(/\/+$/, '');
  return { clientId, clientSecret, apiUrl };
}

/** The API version HighLevel's OAuth and trigger calls are made with. */
const API_VERSION = '2021-07-28';

/** /v1 paths that take the app's headers and need no productId with a partner key. */
export const APP_PATHS = /^\/v1\/apps(\/|$)/;

/** The site events the trigger can start a workflow on. A function: webhooks.ts imports this file too. */
const siteEvents = (): string[] => EVENT_TYPES.filter((t) => t.startsWith('tenant.'));

// --- Tokens ---

interface TokenAnswer {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  userType?: string;
  companyId?: string;
  locationId?: string;
}

async function oauthPost(hl: HighLevelConfig, path: string, form: Record<string, string>, bearer?: string): Promise<TokenAnswer> {
  const res = await fetch(`${hl.apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Version: API_VERSION,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HighLevel ${path} answered ${res.status}: ${text.slice(0, 200)}`);
  const answer = JSON.parse(text) as TokenAnswer;
  if (!answer.access_token) throw new Error(`HighLevel ${path} gave no access token`);
  return answer;
}

/** Keeps a token, replacing the one before for the same agency or sub-account. */
async function saveToken(pool: Pool, secrets: Secrets, answer: TokenAnswer, fallback: { userType?: string; companyId?: string; locationId?: string } = {}) {
  const userType = (answer.userType ?? fallback.userType) === 'Company' ? 'Company' : 'Location';
  const companyId = answer.companyId ?? fallback.companyId ?? null;
  const locationId = answer.locationId ?? fallback.locationId ?? null;
  if (userType === 'Company' ? !companyId : !locationId) throw new Error(`HighLevel's token names no ${userType === 'Company' ? 'agency' : 'sub-account'}`);
  const expiresAt = new Date(Date.now() + (answer.expires_in ?? 86_399) * 1000);
  const conflict = userType === 'Company' ? "(company_id) WHERE user_type = 'Company'" : "(location_id) WHERE user_type = 'Location'";
  await pool.query(
    `INSERT INTO highlevel_tokens (user_type, company_id, location_id, access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ${conflict} DO UPDATE SET company_id = COALESCE(EXCLUDED.company_id, highlevel_tokens.company_id),
       access_token = EXCLUDED.access_token, refresh_token = COALESCE(EXCLUDED.refresh_token, highlevel_tokens.refresh_token),
       expires_at = EXCLUDED.expires_at, date_changed = now()`,
    [userType, companyId, userType === 'Location' ? locationId : null, secrets.encrypt(answer.access_token), answer.refresh_token ? secrets.encrypt(answer.refresh_token) : null, expiresAt],
  );
  return { userType, companyId, locationId };
}

/** The code HighLevel's install sends to the redirect URL, turned into the install's token. */
export async function exchangeCode(pool: Pool, secrets: Secrets, hl: HighLevelConfig, code: string, redirectUri: string) {
  const answer = await oauthPost(hl, '/oauth/token', {
    client_id: hl.clientId,
    client_secret: hl.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  return saveToken(pool, secrets, answer);
}

/** A token of this kind, refreshed when it ends within five minutes. Null when there is none. */
async function storedToken(pool: Pool, secrets: Secrets, hl: HighLevelConfig, userType: 'Company' | 'Location', id: string): Promise<string | null> {
  const column = userType === 'Company' ? 'company_id' : 'location_id';
  const { rows } = await pool.query(`SELECT * FROM highlevel_tokens WHERE user_type = $1 AND ${column} = $2`, [userType, id]);
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() - Date.now() > 5 * 60_000) return secrets.decrypt(row.access_token);
  if (!row.refresh_token) return null;
  const answer = await oauthPost(hl, '/oauth/token', {
    client_id: hl.clientId,
    client_secret: hl.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: secrets.decrypt(row.refresh_token),
    user_type: userType,
  });
  await saveToken(pool, secrets, answer, { userType, companyId: row.company_id ?? undefined, locationId: row.location_id ?? undefined });
  return answer.access_token;
}

/**
 * A sub-account token: its own install's, or one made from its agency's install
 * (POST /oauth/locationToken), which is kept for next time. Null when neither was installed.
 */
export async function locationToken(pool: Pool, secrets: Secrets, hl: HighLevelConfig, locationId: string, companyId: string | null): Promise<string | null> {
  const own = await storedToken(pool, secrets, hl, 'Location', locationId);
  if (own || !companyId) return own;
  const agency = await storedToken(pool, secrets, hl, 'Company', companyId);
  if (!agency) return null;
  const answer = await oauthPost(hl, '/oauth/locationToken', { companyId, locationId }, agency);
  await saveToken(pool, secrets, answer, { userType: 'Location', companyId, locationId });
  return answer.access_token;
}

// --- Trigger deliveries ---

/** The flat fields a trigger sends its workflow, from a webhook event's body. */
export function triggerBody(eventBody: string, eventId: string): string {
  const event = JSON.parse(eventBody) as { type: string; timestamp: string; data?: Record<string, unknown> };
  const { tenant, version, ...rest } = (event.data ?? {}) as { tenant?: Record<string, unknown>; version?: unknown };
  return JSON.stringify({
    ...(tenant ?? {}),
    ...rest,
    ...(tenant ? { siteId: tenant.id, url: tenant.domainName ? `https://${tenant.domainName}` : null } : {}),
    event: event.type,
    eventId,
    timestamp: event.timestamp,
  });
}

/**
 * Headers for a delivery to a trigger: the sub-account's token, but only to HighLevel's own
 * address, so a targetUrl elsewhere never gets one.
 */
export async function triggerHeaders(
  pool: Pool,
  secrets: Secrets,
  config: WebhookConfig,
  target: string,
  locationId: string | null,
  companyId: string | null,
): Promise<Record<string, string>> {
  const hl = config.highlevel;
  if (!hl || !locationId || new URL(target).origin !== new URL(hl.apiUrl).origin) return {};
  try {
    const token = await locationToken(pool, secrets, hl, locationId, companyId);
    return token ? { Authorization: `Bearer ${token}`, Version: API_VERSION } : {};
  } catch (err) {
    console.error(`highlevel: no token for sub-account ${locationId}: ${(err as Error).message}`);
    return {};
  }
}

// --- Routes ---

interface AppCall {
  data?: Record<string, unknown>;
  extras?: { locationId?: string; contactId?: string; workflowId?: string; companyId?: string };
  meta?: { key?: string; version?: string };
}

const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');

/** The storefront a call is for: a storefront key's own, or the one a partner key names. */
async function storefront(c: Context<AppEnv>, pool: Pool, data?: Record<string, unknown>): Promise<string> {
  const own = c.get('productId');
  if (own) return own;
  const resellerId = c.get('resellerId');
  const named = text(data?.storefront) || c.req.header('X-AnyPress-Storefront')?.trim() || c.req.query('productId') || '';
  if (!resellerId) throw new HttpError(403, 'Sign in with an API key');
  if (!named) throw badRequest('Choose a storefront: a partner key works for several');
  const ok = isUuid(named) && (await pool.query('SELECT 1 FROM products WHERE id = $1 AND reseller_id = $2', [named, resellerId])).rowCount;
  if (!ok) throw new HttpError(403, `Storefront ${named} is not one of this partner's storefronts`);
  return named;
}

/** A site as flat fields, with its address. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const flatSite = (tenant: any) => ({ ...tenant, siteId: tenant.id, url: tenant.domainName ? `https://${tenant.domainName}` : null });

const ACTIONS = ['create-site', 'get-site', 'suspend-site', 'resume-site', 'delete-site'] as const;

/** Which site events a trigger wants, from its Event filter (values like "tenant.ready" or "ready"). Every site event without one. */
function triggerEvents(filters: unknown): string[] {
  const list = Array.isArray(filters) ? (filters as { field?: string; value?: unknown }[]) : [];
  const wanted = list
    .filter((f) => f?.field === 'event')
    .flatMap((f) => (Array.isArray(f.value) ? f.value : [f.value]))
    .map((v) => text(v))
    .map((v) => (v.startsWith('tenant.') ? v : `tenant.${v}`))
    .filter((v) => siteEvents().includes(v));
  return wanted.length ? [...new Set(wanted)] : siteEvents();
}

/**
 * Makes the storefront a HighLevel agency's (or not). Its new sites made without a site type get the HighLevel one
 * (src/routes/tenants.ts), and turning it on gives its existing sites that have none (every plugin on) the HighLevel
 * type too, written to each site. Sites moved in keep their own code. Answers how many sites it retyped.
 */
export async function setHighLevelAgency(pool: Pool, boss: PgBoss, productId: string, on: boolean): Promise<number> {
  return withTransaction(pool, async (client) => {
    await client.query('UPDATE products SET highlevel_agency = $2 WHERE id = $1', [productId, on]);
    if (!on) return 0;
    const { rows } = await client.query<{ id: string }>(
      `UPDATE tenants SET php_constants = php_constants || jsonb_build_object('ANYPRESS_TENANT_ROLES', jsonb_build_object('value', $2::text, 'isPrivate', false)),
         status = $3, date_changed = now()
       WHERE product_id = $1 AND NOT own_code AND status = $4 AND NOT (php_constants ? 'ANYPRESS_TENANT_ROLES')
       RETURNING id`,
      [productId, HIGHLEVEL_SITE_TYPE, Status.Pending, Status.Done],
    );
    for (const t of rows) await enqueue(boss, client, { type: 'tenant.update', tenantId: t.id, phpConstantNames: ['ANYPRESS_TENANT_ROLES'] });
    return rows.length;
  });
}

/**
 * Marks the storefront as a HighLevel agency's the first time the HighLevel app is used for it. A storefront others
 * follow (a store template, such as the shop's) is never marked: its sites are the platform's own.
 */
export async function markHighLevelAgency(pool: Pool, boss: PgBoss, productId: string) {
  const { rows } = await pool.query(
    `SELECT 1 FROM products p WHERE p.id = $1 AND NOT p.highlevel_agency AND NOT EXISTS (SELECT 1 FROM products f WHERE f.follows_product_id = p.id)`,
    [productId],
  );
  if (rows.length) await setHighLevelAgency(pool, boss, productId, true);
}

export function highLevelRoutes(app: Hono<AppEnv>, deps: Deps) {
  const { pool, secrets, config } = deps;
  const webhookConfig = config.webhooks ?? { allowPrivate: false, logDays: 30 };

  /** A /v1 call made in-process for this storefront, with the caller's key. */
  async function v1(c: Context<AppEnv>, productId: string, method: string, path: string, body?: unknown) {
    const res = await app.request(
      path,
      { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
      { internalAuth: { productId, apiKeyId: c.get('apiKeyId'), userId: c.get('userId') } },
    );
    const answer = res.status === 200 && res.headers.get('Content-Length') === '0' ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const status = ([400, 403, 404, 409, 410, 429] as const).find((s) => s === res.status) ?? 502;
      throw new HttpError(status, (answer as { message?: string } | null)?.message ?? `The call answered ${res.status}`);
    }
    return answer;
  }

  /** The site, when it is this sub-account's: a site another sub-account made is "not found" here. */
  async function site(c: Context<AppEnv>, productId: string, ref: { tenantId?: string; externalId?: string }, locationId?: string) {
    const query = ref.tenantId ? `tenantId=${encodeURIComponent(ref.tenantId)}` : `externalId=${encodeURIComponent(ref.externalId!)}`;
    const list = (await v1(c, productId, 'GET', `/v1/tenants?${query}`)) as { id: string }[];
    const found = list[0];
    const owner = found && locationId ? (await pool.query<{ loc: string | null }>('SELECT highlevel_location_id AS loc FROM tenants WHERE id = $1', [found.id])).rows[0]?.loc : null;
    if (!found || (owner && owner !== locationId)) throw new HttpError(404, `Site ${ref.tenantId ?? ref.externalId} not found`);
    return flatSite(found);
  }

  function siteRef(data: Record<string, unknown>) {
    const tenantId = text(data.siteId) || undefined;
    const externalId = text(data.externalId) || undefined;
    if (!tenantId && !externalId) throw badRequest('Fill in Your Reference or Site ID');
    return tenantId ? { tenantId } : { externalId };
  }

  // HighLevel's install verifies the key with this (External Authentication), and shows the name.
  app.get('/v1/apps/account', async (c) => {
    const productId = c.get('productId');
    if (productId) {
      const { rows } = await pool.query('SELECT id, name FROM products WHERE id = $1', [productId]);
      return c.json({ id: rows[0].id, name: rows[0].name, type: 'storefront' });
    }
    const { rows } = await pool.query('SELECT id, name FROM resellers WHERE id = $1', [c.get('resellerId')]);
    return c.json({ id: rows[0].id, name: rows[0].name, type: 'partner' });
  });

  // The choices of the actions' Storefront field: a partner key's storefronts, or a storefront key's own.
  app.get('/v1/apps/storefronts', async (c) => {
    const productId = c.get('productId');
    const { rows } = productId
      ? await pool.query('SELECT id, name FROM products WHERE id = $1', [productId])
      : await pool.query('SELECT id, name FROM products WHERE reseller_id = $1 ORDER BY name', [c.get('resellerId')]);
    return c.json({ options: rows.map((r) => ({ label: r.name as string, value: r.id as string })) });
  });

  app.post('/v1/apps/actions/:action', async (c) => {
    const action = c.req.param('action') as (typeof ACTIONS)[number];
    if (!ACTIONS.includes(action)) throw new HttpError(404, `No action ${action}`);
    const call = ((await readJson(c)) ?? {}) as AppCall;
    const data = call.data ?? {};
    const productId = await storefront(c, pool, data);
    await markHighLevelAgency(pool, deps.boss, productId);
    // Signed in to AnyPress (OAuth): the actions need what the person allowed.
    const scopes = c.get('appScopes');
    const needs = action === 'get-site' ? 'stores:read' : 'stores:write';
    if (scopes && !scopes.includes(needs)) {
      throw new HttpError(403, `The AnyPress sign-in for this account doesn't allow ${needs === 'stores:read' ? 'seeing' : 'changing'} sites. Reconnect the AnyPress app in HighLevel and tick Stores`);
    }
    const locationId = text(call.extras?.locationId) || undefined;

    if (action === 'create-site') {
      const name = text(data.name);
      if (!name) throw badRequest('Site Name is required');
      // The contact's id by default, so a workflow that runs twice for the same contact makes one site.
      const externalId = text(data.externalId) || text(call.extras?.contactId) || undefined;
      const body: Record<string, unknown> = { name, ...(externalId && { externalId }) };
      const email = text(data.email);
      if (!email) throw badRequest('Client Email is required: it is the site owner\'s login');
      body.wordPressUserEmail = email;
      body.wordPressUserName = text(data.username) || email;
      body.wordPressUserRole = text(data.role) || 'administrator';
      for (const field of ['size', 'groupName', 'customDomainName']) if (text(data[field])) body[field] = text(data[field]);
      // The storefront is a HighLevel agency's, so a site with no site type gets the HighLevel one (src/routes/tenants.ts).
      if (text(data.siteType)) body.phpConstants = { ANYPRESS_TENANT_ROLES: { value: text(data.siteType), isPrivate: false } };
      if (data.notifyOwner === true || ['true', 'yes'].includes(text(data.notifyOwner).toLowerCase())) body.notifyOwner = true;
      const created = (await v1(c, productId, 'POST', '/v1/tenants', body)) as { id?: string; tenantId?: string };
      const tenantId = created.tenantId ?? created.id;
      // The site belongs to the sub-account whose workflow made it.
      if (tenantId && locationId) {
        await pool.query('UPDATE tenants SET highlevel_location_id = $2, highlevel_company_id = $3 WHERE id = $1 AND product_id = $4', [
          tenantId,
          locationId,
          text(call.extras?.companyId) || null,
          productId,
        ]);
      }
      return c.json(await site(c, productId, { tenantId }));
    }

    const ref = siteRef(data);
    // Only this sub-account's sites (or ones made outside HighLevel).
    await site(c, productId, ref, locationId);
    const query = ref.tenantId ? `tenantId=${encodeURIComponent(ref.tenantId)}` : `externalId=${encodeURIComponent(ref.externalId!)}`;
    if (action === 'suspend-site') await v1(c, productId, 'POST', `/v1/tenants/suspend?${query}`, {});
    if (action === 'resume-site') await v1(c, productId, 'POST', `/v1/tenants/resume?${query}`, {});
    if (action === 'delete-site') {
      const before = await site(c, productId, ref, locationId);
      await v1(c, productId, 'DELETE', `/v1/tenants?${query}`);
      return c.json({ ...before, deleted: true });
    }
    return c.json(await site(c, productId, ref, locationId));
  });

  // HighLevel calls this when a workflow adds, changes or removes the app's trigger.
  app.post('/v1/apps/triggers', async (c) => {
    const body = ((await readJson(c)) ?? {}) as {
      triggerData?: { id?: string; key?: string; eventType?: string; targetUrl?: string; filters?: unknown };
      extras?: { locationId?: string; companyId?: string; workflowId?: string };
    };
    const trigger = body.triggerData ?? {};
    const id = text(trigger.id);
    if (!id) throw badRequest('triggerData.id is required');
    const productId = await storefront(c, pool);
    if (trigger.eventType !== 'DELETED') await markHighLevelAgency(pool, deps.boss, productId);
    if (trigger.eventType === 'DELETED') {
      await pool.query(
        `DELETE FROM webhook_endpoints WHERE kind = 'highlevel' AND highlevel_trigger_id = $1
           AND (product_id = $2 OR (highlevel_location_id IS NOT NULL AND highlevel_location_id = $3))`,
        [id, productId, text(body.extras?.locationId) || null],
      );
      return c.json({ ok: true });
    }
    if (trigger.eventType !== 'CREATED' && trigger.eventType !== 'UPDATED') throw badRequest('triggerData.eventType must be CREATED, UPDATED or DELETED');
    const url = checkEndpointUrl(trigger.targetUrl, webhookConfig);
    const workflow = text(body.extras?.workflowId);
    const { rows } = await pool.query(
      `INSERT INTO webhook_endpoints (product_id, url, description, event_types, secret, api_key_id, kind, highlevel_trigger_id, highlevel_location_id, highlevel_company_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'highlevel', $7, $8, $9)
       ON CONFLICT (highlevel_trigger_id) WHERE kind = 'highlevel' DO UPDATE SET url = EXCLUDED.url, description = EXCLUDED.description,
         event_types = EXCLUDED.event_types, highlevel_location_id = EXCLUDED.highlevel_location_id, highlevel_company_id = EXCLUDED.highlevel_company_id,
         product_id = EXCLUDED.product_id, api_key_id = EXCLUDED.api_key_id, date_changed = now()
       WHERE webhook_endpoints.product_id = EXCLUDED.product_id
          -- The same sub-account, reinstalled with another storefront's key: the trigger moves with it.
          OR (webhook_endpoints.highlevel_location_id IS NOT NULL AND webhook_endpoints.highlevel_location_id = EXCLUDED.highlevel_location_id)
       RETURNING id`,
      [
        productId,
        url,
        `HighLevel workflow${workflow ? ` ${workflow}` : ''}`.slice(0, 200),
        triggerEvents(trigger.filters),
        secrets.encrypt(generateSecret()),
        c.get('apiKeyId') ?? null,
        id,
        text(body.extras?.locationId) || null,
        text(body.extras?.companyId) || null,
      ],
    );
    if (!rows[0]) throw new HttpError(403, 'This trigger belongs to another storefront');
    return c.json({ ok: true });
  });

  // Where HighLevel's install sends the person, with the code for the install's token.
  app.get('/apps/oauth/callback', async (c) => {
    const hl = config.webhooks?.highlevel;
    const page = (title: string, message: string, status: 200 | 400 | 503) =>
      c.html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>` +
          `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.5rem}</style></head>` +
          `<body><h1>${title}</h1><p>${message}</p></body></html>`,
        status,
      );
    if (!hl) return page('Not set up yet', 'This AnyPress server is not connected to HighLevel.', 503);
    const code = c.req.query('code');
    if (!code) return page('Something went wrong', 'The install sent no code. Try installing the app again.', 400);
    const url = new URL(c.req.url);
    const base = config.publicUrl ?? `${c.req.header('X-Forwarded-Proto') ?? url.protocol.replace(':', '')}://${c.req.header('Host') ?? url.host}`;
    try {
      await exchangeCode(pool, secrets, hl, code, `${base}/apps/oauth/callback`);
    } catch (err) {
      console.error(`highlevel: install not finished: ${(err as Error).message}`);
      return page('Something went wrong', 'The install could not be finished. Try installing the app again, or write to support@anypress.io.', 400);
    }
    return page('AnyPress is connected', 'Your workflows can now use AnyPress. You can close this tab.', 200);
  });
}

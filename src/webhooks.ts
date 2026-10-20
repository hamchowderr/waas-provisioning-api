import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { Client, Pool } from './db.ts';
import { badRequest, HttpError } from './errors.ts';
import type { JobData, JobHandlers } from './queue.ts';
import type { Secrets } from './secrets.ts';
import { TENANT_SELECT, toTenant } from './tenants.ts';
import { toVersion } from './routes/versions.ts';

/**
 * Outgoing webhooks (docs/webhooks.md). A product registers endpoints; when one of its stores or
 * versions finishes a change, every endpoint that wants that event gets a signed POST. Signed the
 * Standard Webhooks way (webhook-id, webhook-timestamp, webhook-signature: HMAC-SHA256 over
 * "<id>.<timestamp>.<body>"), so its libraries verify them. Each delivery is a pg-boss job,
 * retried with growing gaps for several hours, and kept with its last answer for the dashboard.
 */

export const WEBHOOK_QUEUE = 'webhooks';

export const EVENT_TYPES = [
  'tenant.ready',
  'tenant.updated',
  'tenant.version_changed',
  'tenant.domains_changed',
  'tenant.suspended',
  'tenant.resumed',
  'tenant.deleted',
  'tenant.restored',
  'tenant.rolled_back',
  'tenant.backup_completed',
  'tenant.backup_failed',
  'tenant.failed',
  'version.ready',
  'version.deleted',
  'version.failed',
  'webhook.test',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Endpoints a product may have. */
export const MAX_ENDPOINTS = 10;
/** Seconds an endpoint has to answer. */
const TIMEOUT_SECONDS = 10;
/** Characters kept of an endpoint's answer or error. */
const MAX_TEXT = 500;

export interface WebhookConfig {
  /**
   * WEBHOOK_ALLOW_PRIVATE=true: endpoints may be http:// and on private or loopback addresses.
   * For self-hosting on a private network, and tests. Off, only https:// on public addresses.
   */
  allowPrivate: boolean;
  /** Days events and deliveries are kept (WEBHOOK_LOG_DAYS, default 30). */
  logDays: number;
}

export function loadWebhookConfig(env: NodeJS.ProcessEnv): WebhookConfig {
  const raw = env.WEBHOOK_LOG_DAYS;
  const logDays = raw === undefined || raw === '' ? 30 : Number(raw);
  if (!Number.isInteger(logDays) || logDays < 1) throw new Error('WEBHOOK_LOG_DAYS must be a whole number of days, at least 1');
  return { allowPrivate: env.WEBHOOK_ALLOW_PRIVATE?.trim().toLowerCase() === 'true', logDays };
}

const clip = (value: string | null | undefined) => (value ? value.slice(0, MAX_TEXT) : null);

// --- Signing ---

export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

/** The webhook-signature header value: "v1,<base64 HMAC-SHA256>" keyed by the secret's bytes. */
export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

// --- Where an endpoint may be ---

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && ip.split('.')[2] === '0') ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Loopback, private, link-local, shared (CGNAT), multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4Private(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return ipv4Private(mapped[1]!);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff') || v6.startsWith('64:ff9b:');
}

/** Checks an endpoint URL; throws 400 with the reason. Returns it normalised. */
export function checkEndpointUrl(input: unknown, config: WebhookConfig): string {
  if (typeof input !== 'string' || !input.trim()) throw badRequest('url is required');
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw badRequest('url is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(config.allowPrivate && url.protocol === 'http:')) throw badRequest('url must start with https://');
  if (url.username || url.password) throw badRequest('url must not contain a user name or password');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!config.allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isPrivateAddress(host)))) {
    throw badRequest('url must be on a public address');
  }
  if (url.href.length > 2000) throw badRequest('url is too long');
  return url.href;
}

/**
 * A DNS lookup that refuses private addresses, used for the connection itself so the name can't
 * resolve to a public address when checked and a private one when connected.
 */
function guardedLookup(allowPrivate: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (hostname: string, options: any, callback: any) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as unknown as LookupAddress[];
      const blocked = allowPrivate ? undefined : list.find((a) => isPrivateAddress(a.address));
      if (blocked) return callback(new Error(`${hostname} resolves to a private address (${blocked.address})`));
      if (!list.length) return callback(new Error(`${hostname} has no address`));
      if (options?.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

interface PostResult {
  status: number | null;
  body: string | null;
  error: string | null;
  durationMs: number;
}

/** One POST. Never follows redirects; any 2xx is success. */
function post(target: string, headers: Record<string, string>, body: string, allowPrivate: boolean): Promise<PostResult> {
  const started = performance.now();
  const done = (r: Omit<PostResult, 'durationMs'>): PostResult => ({ ...r, durationMs: Math.round(performance.now() - started) });
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return resolve(done({ status: null, body: null, error: 'Invalid URL' }));
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && isIP(host) && isPrivateAddress(host)) {
      return resolve(done({ status: null, body: null, error: `${host} is a private address` }));
    }
    const client = url.protocol === 'http:' ? http : https;
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
        lookup: guardedLookup(allowPrivate),
        timeout: TIMEOUT_SECONDS * 1000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (text.length < MAX_TEXT) text += chunk;
        });
        res.on('end', () => resolve(done({ status: res.statusCode ?? null, body: clip(text), error: null })));
        res.on('error', (err) => resolve(done({ status: res.statusCode ?? null, body: clip(text), error: clip(err.message) })));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`No answer within ${TIMEOUT_SECONDS} seconds`)));
    req.on('error', (err) => resolve(done({ status: null, body: null, error: clip(err.message) })));
    req.end(body);
  });
}

// --- Events ---

export interface WebhookEvent {
  type: EventType;
  data: Record<string, unknown>;
  tenantId?: string;
  versionId?: string;
}

/**
 * Records an event and queues one delivery for each enabled endpoint of the product that wants it.
 * Nothing is recorded when no endpoint wants it. Pass `endpointId` to send to that endpoint only
 * (a test event). Returns the delivery ids.
 */
export async function emit(pool: Pool, boss: PgBoss, productId: string, event: WebhookEvent, endpointId?: string): Promise<string[]> {
  const { rows: endpoints } = await pool.query<{ id: string }>(
    `SELECT id FROM webhook_endpoints
      WHERE product_id = $1 AND ($3::uuid IS NOT NULL OR (enabled AND (cardinality(event_types) = 0 OR $2 = ANY(event_types))))
        AND ($3::uuid IS NULL OR id = $3)`,
    [productId, event.type, endpointId ?? null],
  );
  if (!endpoints.length) return [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const eventId = (await client.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
    const at = new Date();
    const body = JSON.stringify({ type: event.type, timestamp: at.toISOString(), data: event.data });
    await client.query('INSERT INTO webhook_events (id, product_id, type, tenant_id, version_id, body, at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      eventId,
      productId,
      event.type,
      event.tenantId ?? null,
      event.versionId ?? null,
      body,
      at,
    ]);
    const ids: string[] = [];
    for (const endpoint of endpoints) {
      const { rows } = await client.query<{ id: string }>('INSERT INTO webhook_deliveries (event_id, endpoint_id) VALUES ($1, $2) RETURNING id', [eventId, endpoint.id]);
      ids.push(rows[0]!.id);
      await sendJob(boss, client, rows[0]!.id);
    }
    await client.query('COMMIT');
    return ids;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function sendJob(boss: PgBoss, client: Client | null, deliveryId: string) {
  return boss.send(WEBHOOK_QUEUE, { deliveryId }, client ? { db: { executeSql: (text, values) => client.query(text, values) } } : {});
}

/** Which event a finished job is, or a failed one. */
function eventFor(data: JobData, ok: boolean): EventType | null {
  if (!ok) {
    if (data.type === 'tenant.backup') return 'tenant.backup_failed';
    if (data.type === 'version.create') return 'version.failed';
    if (data.type === 'version.delete') return 'version.failed';
    return data.type.startsWith('tenant.') ? 'tenant.failed' : null;
  }
  const map: Partial<Record<JobData['type'], EventType>> = {
    'tenant.create': 'tenant.ready',
    'tenant.update': 'tenant.updated',
    'tenant.email-packs': 'tenant.updated',
    'tenant.move': 'tenant.version_changed',
    'tenant.domains': 'tenant.domains_changed',
    'tenant.suspend': 'tenant.suspended',
    'tenant.resume': 'tenant.resumed',
    'tenant.delete': 'tenant.deleted',
    'tenant.restore': 'tenant.restored',
    'tenant.rollback': 'tenant.rolled_back',
    'tenant.backup': 'tenant.backup_completed',
    'version.create': 'version.ready',
    'version.delete': 'version.deleted',
  };
  return map[data.type] ?? null;
}

/** What a job's event is about, read before the job runs (a delete removes the row). */
async function subject(pool: Pool, data: JobData) {
  if ('tenantId' in data) {
    const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
    return rows[0] ? { productId: rows[0].product_id as string, tenant: toTenant(rows[0]) } : null;
  }
  if ('versionId' in data) {
    const { rows } = await pool.query('SELECT * FROM versions WHERE id = $1', [data.versionId]);
    return rows[0] ? { productId: rows[0].product_id as string, version: toVersion(rows[0]) } : null;
  }
  return null;
}

/** The job's own name for what it was doing, for tenant.failed and version.failed. */
const ACTIONS: Record<string, string> = {
  'tenant.create': 'create',
  'tenant.update': 'update',
  // Within v1 the action list doesn't grow: email packs not applied are a failed update.
  'tenant.email-packs': 'update',
  'tenant.move': 'change_version',
  'tenant.domains': 'change_domains',
  'tenant.delete': 'delete',
  'tenant.suspend': 'suspend',
  'tenant.resume': 'resume',
  'tenant.restore': 'restore',
  'tenant.rollback': 'roll_back',
  'version.create': 'create',
  'version.delete': 'delete',
};

/**
 * Wraps the job handlers so each finished or failed store and version job sends its event, and the
 * daily maintenance prunes old events. A webhook problem never fails the job.
 */
export function withWebhooks<H extends JobHandlers>(handlers: H, pool: Pool, boss: PgBoss, config: WebhookConfig): H {
  async function send(data: JobData, ok: boolean, before: Awaited<ReturnType<typeof subject>>) {
    const type = eventFor(data, ok);
    if (!type) return;
    // After a delete the row is gone: send what it was. Otherwise send what it is now.
    const now = type === 'tenant.deleted' || type === 'version.deleted' ? before : await subject(pool, data);
    if (!now) return;
    const payload: Record<string, unknown> = 'tenant' in now ? { tenant: now.tenant } : { version: now.version };
    if (type === 'tenant.failed' || type === 'version.failed') payload.action = ACTIONS[data.type] ?? data.type;
    if (data.type === 'tenant.backup') payload.backupId = data.backupId;
    await emit(pool, boss, now.productId, {
      type,
      data: payload,
      tenantId: 'tenantId' in data ? data.tenantId : undefined,
      versionId: 'versionId' in data ? data.versionId : undefined,
    });
  }

  async function safely(data: JobData, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      console.error(`webhooks: event for ${data.type} not sent: ${(err as Error).message}`);
    }
  }

  return {
    ...handlers,
    async run(data: JobData) {
      let before: Awaited<ReturnType<typeof subject>> = null;
      if (data.type === 'tenant.delete' || data.type === 'version.delete') await safely(data, async () => void (before = await subject(pool, data)));
      await handlers.run(data);
      await safely(data, () => send(data, true, before));
    },
    async fail(data: JobData, error: unknown, job: { id: string; attempts: number }) {
      await handlers.fail(data, error, job);
      await safely(data, () => send(data, false, null));
    },
    async maintenance() {
      await handlers.maintenance();
      await pruneWebhookLog(pool, config.logDays);
    },
  };
}

export async function pruneWebhookLog(pool: Pool, days: number): Promise<number> {
  const { rowCount } = await pool.query('DELETE FROM webhook_events WHERE at < now() - make_interval(days => $1)', [days]);
  return rowCount ?? 0;
}

// --- Delivery ---

/** One attempt at a delivery. Throws when it should be tried again. */
export async function deliver(pool: Pool, secrets: Secrets, config: WebhookConfig, deliveryId: string, lastAttempt: boolean): Promise<void> {
  const { rows } = await pool.query(
    `SELECT d.id, d.status, e.id AS event_id, e.body, e.at, w.url, w.secret, w.enabled
       FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id JOIN webhook_endpoints w ON w.id = d.endpoint_id
      WHERE d.id = $1`,
    [deliveryId],
  );
  const row = rows[0];
  if (!row || row.status !== 'pending') return; // pruned, the endpoint deleted, or already settled
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = secrets.decrypt(row.secret);
  const result = await post(
    row.url,
    {
      'Content-Type': 'application/json',
      'User-Agent': 'WaaS-Webhooks/1.0',
      'webhook-id': row.event_id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': sign(secret, row.event_id, timestamp, row.body),
    },
    row.body,
    config.allowPrivate,
  );
  const ok = result.status !== null && result.status >= 200 && result.status < 300;
  const error = ok ? null : (result.error ?? `HTTP ${result.status}`);
  await pool.query(
    `UPDATE webhook_deliveries SET attempts = attempts + 1, last_attempt_at = now(), response_status = $2, response_body = $3,
            error = $4, duration_ms = $5, status = CASE WHEN $6 THEN 'delivered' WHEN $7 THEN 'failed' ELSE status END
      WHERE id = $1`,
    [deliveryId, result.status, result.body, ok ? null : clip(error), result.durationMs, ok, lastAttempt],
  );
  if (!ok && !lastAttempt) throw new Error(`Webhook delivery ${deliveryId}: ${error}`);
}

/**
 * Works the webhooks queue: up to 10 retries after the first try, from 30 seconds apart doubling
 * to an hour, about seven hours in all. A delivery still failing then is marked failed.
 */
export async function startWebhookWorker(
  boss: PgBoss,
  pool: Pool,
  secrets: Secrets,
  config: WebhookConfig,
  { retryDelaySeconds = 30, retryLimit = 10, pollingIntervalSeconds = 2 } = {},
): Promise<void> {
  if (!(await boss.getQueue(WEBHOOK_QUEUE))) {
    await boss.createQueue(WEBHOOK_QUEUE, {
      retryLimit,
      retryDelay: retryDelaySeconds,
      retryBackoff: true,
      retryDelayMax: 3600,
      expireInSeconds: TIMEOUT_SECONDS * 6,
      deleteAfterSeconds: 7 * 24 * 3600,
    });
  }
  // Five workers, so one slow endpoint doesn't hold back the rest.
  await boss.work(WEBHOOK_QUEUE, { includeMetadata: true, pollingIntervalSeconds, localConcurrency: 5 }, async ([job]: JobWithMetadata<{ deliveryId: string }>[]) => {
    if (!job) return;
    await deliver(pool, secrets, config, job.data.deliveryId, job.retryCount >= job.retryLimit);
  });
}

// --- Endpoints (the /v1 and admin routes share these) ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toEndpoint(row: any) {
  return {
    id: row.id as string,
    url: row.url as string,
    description: (row.description as string | null) ?? null,
    eventTypes: row.event_types as string[],
    enabled: row.enabled as boolean,
    dateCreated: row.date_created.toISOString(),
    dateChanged: row.date_changed.toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toDelivery(row: any) {
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    eventType: row.type as string,
    endpointId: row.endpoint_id as string,
    tenantId: (row.tenant_id as string | null) ?? null,
    versionId: (row.version_id as string | null) ?? null,
    status: row.status as 'pending' | 'delivered' | 'failed',
    attempts: row.attempts as number,
    responseStatus: (row.response_status as number | null) ?? null,
    responseBody: (row.response_body as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    dateCreated: row.date_created.toISOString(),
    lastAttemptAt: row.last_attempt_at ? row.last_attempt_at.toISOString() : null,
  };
}

export const DELIVERY_SELECT = `
  SELECT d.*, e.type, e.tenant_id, e.version_id FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id`;

interface EndpointInput {
  url?: unknown;
  description?: unknown;
  eventTypes?: unknown;
  enabled?: unknown;
}

function checkEventTypes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw badRequest('eventTypes must be a list of event types');
  const unknown = value.filter((v) => !(EVENT_TYPES as readonly string[]).includes(v));
  if (unknown.length) throw badRequest(`Unknown event type ${unknown.join(', ')}; see the WebhookEventType list`);
  return [...new Set(value as string[])];
}

function checkDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('description must be text');
  return value.trim().slice(0, 200) || null;
}

function checkEnabled(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest('enabled must be true or false');
  return value;
}

export function webhookService(pool: Pool, boss: PgBoss, secrets: Secrets, config: WebhookConfig) {
  const notFound = () => new HttpError(404, 'Webhook endpoint not found');

  async function get(productId: string | null, id: string) {
    const { rows } = await pool.query('SELECT * FROM webhook_endpoints WHERE id = $1 AND ($2::uuid IS NULL OR product_id = $2)', [id, productId]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  return {
    get,

    async list(productId: string) {
      const { rows } = await pool.query('SELECT * FROM webhook_endpoints WHERE product_id = $1 ORDER BY date_created', [productId]);
      return rows.map(toEndpoint);
    },

    /** Returns the endpoint with its secret, the only time the secret is shown. */
    async create(productId: string, input: EndpointInput, apiKeyId: string | null) {
      const url = checkEndpointUrl(input.url, config);
      const eventTypes = checkEventTypes(input.eventTypes);
      const description = checkDescription(input.description);
      const enabled = checkEnabled(input.enabled) ?? true;
      const secret = generateSecret();
      const { rows: count } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_endpoints WHERE product_id = $1', [productId]);
      if (count[0]!.n >= MAX_ENDPOINTS) throw badRequest(`A storefront can have at most ${MAX_ENDPOINTS} webhook endpoints`);
      const { rows } = await pool.query(
        `INSERT INTO webhook_endpoints (product_id, url, description, event_types, secret, enabled, api_key_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [productId, url, description, eventTypes, secrets.encrypt(secret), enabled, apiKeyId],
      );
      return { ...toEndpoint(rows[0]), secret };
    },

    async update(productId: string | null, id: string, input: EndpointInput) {
      const current = await get(productId, id);
      const url = input.url === undefined ? current.url : checkEndpointUrl(input.url, config);
      const eventTypes = input.eventTypes === undefined ? current.event_types : checkEventTypes(input.eventTypes);
      const description = input.description === undefined ? current.description : checkDescription(input.description);
      const enabled = checkEnabled(input.enabled) ?? current.enabled;
      const { rows } = await pool.query(
        'UPDATE webhook_endpoints SET url = $2, event_types = $3, description = $4, enabled = $5, date_changed = now() WHERE id = $1 RETURNING *',
        [id, url, eventTypes, description, enabled],
      );
      return toEndpoint(rows[0]);
    },

    async remove(productId: string | null, id: string) {
      const current = await get(productId, id);
      await pool.query('DELETE FROM webhook_endpoints WHERE id = $1', [id]);
      return toEndpoint(current);
    },

    /** A new secret; the old one stops working at once. */
    async rotateSecret(productId: string | null, id: string) {
      await get(productId, id);
      const secret = generateSecret();
      const { rows } = await pool.query('UPDATE webhook_endpoints SET secret = $2, date_changed = now() WHERE id = $1 RETURNING *', [id, secrets.encrypt(secret)]);
      return { ...toEndpoint(rows[0]), secret };
    },

    /** Queues a webhook.test event to this endpoint alone, enabled or not. Returns the delivery. */
    async test(productId: string | null, id: string) {
      const endpoint = await get(productId, id);
      const [deliveryId] = await emit(pool, boss, endpoint.product_id, { type: 'webhook.test', data: { endpointId: id } }, id);
      const { rows } = await pool.query(`${DELIVERY_SELECT} WHERE d.id = $1`, [deliveryId]);
      return toDelivery(rows[0]);
    },

    async deliveries(productId: string | null, filters: { endpointId?: string; status?: string; tenantId?: string }, pageSize: number, offset: number) {
      if (filters.status && !['pending', 'delivered', 'failed'].includes(filters.status)) throw badRequest('status must be pending, delivered or failed');
      const params = [productId, filters.endpointId ?? null, filters.status ?? null, filters.tenantId ?? null];
      const where = `($1::uuid IS NULL OR w.product_id = $1) AND ($2::uuid IS NULL OR d.endpoint_id = $2)
        AND ($3::text IS NULL OR d.status = $3) AND ($4::uuid IS NULL OR e.tenant_id = $4)`;
      const from = `FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id JOIN webhook_endpoints w ON w.id = d.endpoint_id`;
      const [{ rows }, total] = await Promise.all([
        pool.query(
          `SELECT d.*, e.type, e.tenant_id, e.version_id, w.url, w.product_id, p.name AS product_name, t.name AS tenant_name ${from}
             JOIN products p ON p.id = w.product_id LEFT JOIN tenants t ON t.id = e.tenant_id
            WHERE ${where} ORDER BY d.date_created DESC, d.id LIMIT ${pageSize} OFFSET ${offset}`,
          params,
        ),
        pool.query(`SELECT count(*)::int AS n ${from} WHERE ${where}`, params),
      ]);
      return { rows, total: total.rows[0].n as number };
    },

    /** Sends a delivery again from the start (its retries too). Only once it has settled. */
    async redeliver(productId: string | null, deliveryId: string) {
      const updated = await pool.query(
        `UPDATE webhook_deliveries d SET status = 'pending', attempts = 0
           FROM webhook_endpoints w
          WHERE d.id = $1 AND w.id = d.endpoint_id AND ($2::uuid IS NULL OR w.product_id = $2) AND d.status <> 'pending'
          RETURNING d.id`,
        [deliveryId, productId],
      );
      if (!updated.rowCount) {
        const { rowCount } = await pool.query(
          'SELECT 1 FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id WHERE d.id = $1 AND ($2::uuid IS NULL OR w.product_id = $2)',
          [deliveryId, productId],
        );
        if (!rowCount) throw new HttpError(404, 'Delivery not found');
        throw badRequest('This delivery is still being sent');
      }
      await sendJob(boss, null, deliveryId);
      const { rows } = await pool.query(`${DELIVERY_SELECT} WHERE d.id = $1`, [deliveryId]);
      return toDelivery(rows[0]);
    },
  };
}

/** When the config has no webhooks section (tests, older callers). */
export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = { allowPrivate: false, logDays: 30 };

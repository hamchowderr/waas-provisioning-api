// The phone receptionist (voice/): each store can have one phone number, and calls to it reach the voice agent on
// LiveKit, which asks the API about the store by the number that was called. The agent holds one token,
// VOICE_AGENT_TOKEN, and through it can only read a line's store, call that store's phone routes in AnyPress Client
// (/site/phone/*, plus the business profile) and log calls. Lines are set by the platform admin (/admin/voice-lines).
import type { Hono } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import type { Pool } from './db.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import { readJson } from './http.ts';
import { DEFAULT_SIZE, isSize, SIZES } from './plans.ts';
import { tokenMatches } from './routes/admin.ts';
import { callSite, siteKeys, type SiteRequest } from './sitekeys.ts';
import { Status } from './status.ts';

const E164 = /^\+[1-9]\d{6,14}$/;
/** Store paths the agent may call: the phone routes, and the business profile (read only). */
const PHONE_PATH = /^\/phone\/(services|services\/\d+\/times|bookings|callers)$/;
const OUTCOMES = ['booked', 'message', 'transferred', 'answered', 'hung_up'] as const;
type Outcome = (typeof OUTCOMES)[number];

/** "+1 (213) 555-0100" and "12135550100" as "+12135550100"; null when it isn't a phone number. */
export function toE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  const number = `+${digits.length === 10 ? `1${digits}` : digits}`;
  return E164.test(number) ? number : null;
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

interface Line {
  number: string;
  tenant_id: string;
  forward_to: string | null;
  name: string;
  size: string;
  status: number;
  is_suspended: boolean;
  main_domain: string | null;
}

async function lineFor(pool: Pool, number: string): Promise<Line> {
  const { rows } = await pool.query<Line>(
    `SELECT l.number, l.tenant_id, l.forward_to, t.name, t.size, t.status, t.is_suspended,
       (SELECT d.domain_name FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_main) AS main_domain
     FROM voice_lines l JOIN tenants t ON t.id = l.tenant_id WHERE l.number = $1`,
    [number],
  );
  if (!rows[0]) throw notFound('No store has this number');
  return rows[0];
}

/** This month's answered seconds and the plan's limit, in minutes. */
export async function voiceUsage(pool: Pool, tenantId: string, size: string, now = new Date()) {
  const limit = SIZES[isSize(size) ? size : DEFAULT_SIZE].voiceMinutesPerMonth;
  const { rows } = await pool.query<{ seconds: number }>('SELECT seconds FROM voice_usage WHERE tenant_id = $1 AND month = $2', [tenantId, monthStart(now)]);
  const usedMinutes = Math.ceil((rows[0]?.seconds ?? 0) / 60);
  return { usedMinutes, limitMinutes: limit, minutesLeft: Math.max(0, limit - usedMinutes) };
}

export function voiceRoutes(app: Hono<AppEnv>, deps: Deps) {
  const keyFor = siteKeys(deps.config.secretsKey);

  app.use('/voice/*', async (c, next) => {
    const expected = deps.config.voiceAgentToken;
    if (!expected) return c.json({ statusCode: 404, message: 'The phone receptionist is off on this server' }, 404);
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
    if (!match || !tokenMatches(match[1]!, expected)) return c.json({ statusCode: 403, message: 'Voice agent token required' }, 403);
    await next();
  });

  const lineOf = async (raw: string) => {
    const number = toE164(decodeURIComponent(raw));
    if (!number) throw badRequest('Not a phone number');
    const line = await lineFor(deps.pool, number);
    if (line.status !== Status.Done || line.is_suspended || !line.main_domain) throw new HttpError(409, 'This store is not answering calls right now');
    return line;
  };
  const store = (line: Line, request: SiteRequest) => callSite(keyFor(line.tenant_id), line.main_domain!, request, deps.siteFetch, 15_000);

  // Who answers this number: the store's name, its business profile and how many minutes it has left.
  app.get('/voice/lines/:number', async (c) => {
    const line = await lineOf(c.req.param('number'));
    let business: unknown = null;
    try {
      const answer = await store(line, { method: 'GET', path: '/business' });
      if (answer.status === 200) business = answer.body;
    } catch {
      // The agent still answers with the store's name.
    }
    return c.json(
      { tenantId: line.tenant_id, name: line.name, domain: line.main_domain, forwardTo: line.forward_to, ...(await voiceUsage(deps.pool, line.tenant_id, line.size)), business },
      200,
      { 'Cache-Control': 'no-store' },
    );
  });

  // One of the store's phone routes, signed with its site key; the store's answer comes back as it is.
  app.post('/voice/lines/:number/store', async (c) => {
    const line = await lineOf(c.req.param('number'));
    const body = (await readJson(c)) as Partial<SiteRequest>;
    if ((body.method !== 'GET' && body.method !== 'POST') || typeof body.path !== 'string' || !PHONE_PATH.test(body.path)) {
      throw badRequest('Only the store’s phone routes can be called');
    }
    const query = body.query && typeof body.query === 'object' ? Object.fromEntries(Object.entries(body.query).map(([k, v]) => [k, String(v)])) : undefined;
    try {
      return c.json(await store(line, { method: body.method, path: body.path, query, body: body.body }));
    } catch (error) {
      throw new HttpError(502, `The store did not answer: ${(error as Error).message}`);
    }
  });

  // A finished call: kept for the call log and counted against the month's minutes.
  app.post('/voice/lines/:number/calls', async (c) => {
    const number = toE164(decodeURIComponent(c.req.param('number')));
    if (!number) throw badRequest('Not a phone number');
    const line = await lineFor(deps.pool, number);
    const body = (await readJson(c)) as { caller?: unknown; seconds?: unknown; outcome?: unknown; urgent?: unknown; summary?: unknown };
    const seconds = Number(body.seconds);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 4 * 3600) throw badRequest('seconds must be a whole number of seconds');
    if (!OUTCOMES.includes(body.outcome as Outcome)) throw badRequest(`outcome must be one of ${OUTCOMES.join(', ')}`);
    const summary = typeof body.summary === 'string' ? body.summary.slice(0, 4000) : '';
    const { rows } = await deps.pool.query<{ id: string }>(
      'INSERT INTO voice_calls (tenant_id, caller, seconds, outcome, urgent, summary) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [line.tenant_id, toE164(body.caller), seconds, body.outcome, body.urgent === true, summary],
    );
    await deps.pool.query(
      `INSERT INTO voice_usage (tenant_id, month, seconds) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, month) DO UPDATE SET seconds = voice_usage.seconds + EXCLUDED.seconds`,
      [line.tenant_id, monthStart(new Date()), seconds],
    );
    return c.json({ id: rows[0]!.id, ...(await voiceUsage(deps.pool, line.tenant_id, line.size)) }, 201);
  });
}

/** Mounted at /admin/voice-lines (platform admin only): give a store its number, change it, or take it away. */
export function voiceAdminRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.get('/voice-lines', async (c) => {
    const { rows } = await deps.pool.query('SELECT number, tenant_id AS "tenantId", forward_to AS "forwardTo", created_at AS "createdAt" FROM voice_lines ORDER BY created_at');
    return c.json({ lines: rows });
  });

  app.put('/voice-lines/:number', async (c) => {
    const number = toE164(decodeURIComponent(c.req.param('number')));
    if (!number) throw badRequest('Not a phone number');
    const body = (await readJson(c)) as { tenantId?: unknown; forwardTo?: unknown };
    if (typeof body.tenantId !== 'string') throw badRequest('tenantId is required');
    const forwardTo = body.forwardTo == null || body.forwardTo === '' ? null : toE164(body.forwardTo);
    if (body.forwardTo && !forwardTo) throw badRequest('forwardTo is not a phone number');
    const { rowCount } = await deps.pool.query('SELECT 1 FROM tenants WHERE id = $1', [body.tenantId]).catch(() => ({ rowCount: 0 }));
    if (!rowCount) throw notFound('No such tenant');
    await deps.pool.query('DELETE FROM voice_lines WHERE tenant_id = $1 AND number <> $2', [body.tenantId, number]);
    await deps.pool.query(
      `INSERT INTO voice_lines (number, tenant_id, forward_to) VALUES ($1, $2, $3)
       ON CONFLICT (number) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, forward_to = EXCLUDED.forward_to`,
      [number, body.tenantId, forwardTo],
    );
    return c.json({ number, tenantId: body.tenantId, forwardTo });
  });

  app.delete('/voice-lines/:number', async (c) => {
    const number = toE164(decodeURIComponent(c.req.param('number')));
    if (!number) throw badRequest('Not a phone number');
    const { rowCount } = await deps.pool.query('DELETE FROM voice_lines WHERE number = $1', [number]);
    if (!rowCount) throw notFound('No store has this number');
    return c.body(null, 204);
  });
}

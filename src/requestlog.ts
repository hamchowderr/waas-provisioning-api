import type { Context, MiddlewareHandler } from 'hono';
import type { Pool } from './db.ts';
import { isUuid } from './http.ts';

/**
 * The request log: one row per call to the product API (/v1/*) and per change made from the
 * dashboard (any /admin or /account request that isn't a GET), for the dashboard's Requests page.
 * Records who called what and how it went, never what was sent: no bodies, no headers beyond the
 * user agent, and no secrets. The API key (Basic auth username, an id) or the signed-in person's
 * user id is kept; secrets, session cookies and the admin token never are. Rows
 * older than REQUEST_LOG_DAYS are deleted by the daily maintenance job.
 */

export type RequestSource = 'v1' | 'admin' | 'account';

const MAX_TEXT = 500;
const clip = (value: string | null | undefined) => (value ? value.slice(0, MAX_TEXT) : null);

/** The caller's address: the first hop the proxy in front of the API (Cloudflare, Traefik) saw. */
function clientIp(c: Context): string | null {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? (forwarded || null);
}

/** The store a request is about: /tenants/<id>/... in the path, else a tenantId query parameter. */
function tenantOf(path: string, query: URLSearchParams): string | null {
  const fromPath = /\/tenants\/([^/]+)/.exec(path)?.[1];
  if (fromPath && isUuid(fromPath)) return fromPath;
  const fromQuery = query.get('tenantId');
  return fromQuery && isUuid(fromQuery) ? fromQuery : null;
}

/** The message of an error response ({ statusCode, message }), when it has one. */
async function errorMessage(res: Response): Promise<string | null> {
  if (res.status < 400 || !res.headers.get('content-type')?.includes('application/json')) return null;
  try {
    const body = (await res.clone().json()) as { message?: unknown };
    return typeof body?.message === 'string' ? body.message : null;
  } catch {
    return null;
  }
}

/**
 * Records each request it sees once the response is ready. A failed write is logged to the console
 * and never changes the response. `days` 0 turns the log off.
 */
export function requestLogger(pool: Pool, source: RequestSource, days: number): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    if (days <= 0 || (source !== 'v1' && (c.req.method === 'GET' || c.req.method === 'HEAD'))) return;
    const url = new URL(c.req.url);
    const vars = c.var as { productId?: string; apiKeyId?: string; userId?: string };
    try {
      await pool.query(
        `INSERT INTO api_requests (source, method, path, query, status, duration_ms, product_id, api_key_id, tenant_id, external_id, ip, user_agent, error, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          source,
          c.req.method,
          clip(url.pathname),
          clip(url.search.replace(/^\?/, '')),
          c.res.status,
          Math.round(performance.now() - started),
          vars.productId ?? null,
          vars.apiKeyId ?? null,
          tenantOf(url.pathname, url.searchParams),
          clip(url.searchParams.get('externalId')),
          clip(clientIp(c)),
          clip(c.req.header('user-agent')),
          clip(await errorMessage(c.res)),
          vars.userId ?? null,
        ],
      );
    } catch (err) {
      console.error(`Request log write failed: ${(err as Error).message}`);
    }
  };
}

/** Deletes rows older than `days`. Returns how many went. */
export async function pruneRequestLog(pool: Pool, days: number): Promise<number> {
  if (days <= 0) return 0;
  const { rowCount } = await pool.query('DELETE FROM api_requests WHERE at < now() - make_interval(days => $1)', [days]);
  return rowCount ?? 0;
}

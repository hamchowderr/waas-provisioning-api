// How much of its plan's website assistant a store has used this month. The assistant (agent/) asks before each
// message the owner sends, with the owner's own "Sign in with your website" token, so the count is per store and
// the store's size sets the limit (src/plans.ts). A month is a calendar month in UTC, like the email allowance.
// After each model step it also sends the step's tokens, kept next to the count so each store's real assistant cost
// can be read (recordAssistantTokens); the owner never sees them.
import type { Hono } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import type { Pool } from './db.ts';
import { HttpError } from './errors.ts';
import { isSiteResource, verifyAccessToken } from './oauth.ts';
import { DEFAULT_SIZE, isSize, SIZES } from './plans.ts';

export interface AssistantUsage {
  used: number;
  limit: number;
  /** When the count starts again: the first of next month, UTC. */
  resetsAt: string;
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
const day = (date: Date) => date.toISOString().slice(0, 10);

async function limitFor(pool: Pool, tenantId: string): Promise<number> {
  const { rows } = await pool.query<{ size: string }>('SELECT size FROM tenants WHERE id = $1', [tenantId]);
  const size = rows[0]?.size;
  return SIZES[isSize(size) ? size : DEFAULT_SIZE].assistantMessagesPerMonth;
}

/** This month's count, without changing it. */
export async function assistantUsage(pool: Pool, tenantId: string, now = new Date()): Promise<AssistantUsage> {
  const limit = await limitFor(pool, tenantId);
  const { rows } = await pool.query<{ messages: number }>('SELECT messages FROM assistant_usage WHERE tenant_id = $1 AND month = $2', [tenantId, day(monthStart(now))]);
  return { used: rows[0]?.messages ?? 0, limit, resetsAt: nextMonth(now).toISOString() };
}

/** Counts one message, unless the month's allowance is spent: then null, and nothing is counted. */
export async function countAssistantMessage(pool: Pool, tenantId: string, now = new Date()): Promise<AssistantUsage | null> {
  const limit = await limitFor(pool, tenantId);
  const { rows } = await pool.query<{ messages: number }>(
    `INSERT INTO assistant_usage (tenant_id, month, messages) VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, month) DO UPDATE SET messages = assistant_usage.messages + 1 WHERE assistant_usage.messages < $3
     RETURNING messages`,
    [tenantId, day(monthStart(now)), limit],
  );
  if (!rows[0] || rows[0].messages > limit) return null;
  return { used: rows[0].messages, limit, resetsAt: nextMonth(now).toISOString() };
}

/** One model step's tokens: input not read from the cache, output, and the prompt cache's reads and writes. */
interface AssistantTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
/** More than any one model step can use (a 1M-token context and its output), so a bad count can't swamp a month. */
const MAX_STEP_TOKENS = 2_000_000;

/** A step's tokens from a request body, or null when a field is missing, not a whole number, or out of range. */
function parseAssistantTokens(body: unknown): AssistantTokens | null {
  if (!body || typeof body !== 'object') return null;
  const out = {} as AssistantTokens;
  for (const field of TOKEN_FIELDS) {
    const value = (body as Record<string, unknown>)[field] ?? 0;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_STEP_TOKENS) return null;
    out[field] = value;
  }
  return out;
}

/** Adds one model step's tokens to the store's month. Not capped: the message itself was already allowed. */
export async function recordAssistantTokens(pool: Pool, tenantId: string, tokens: AssistantTokens, now = new Date()): Promise<void> {
  await pool.query(
    `INSERT INTO assistant_usage (tenant_id, month, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model_steps)
     VALUES ($1, $2, $3, $4, $5, $6, 1)
     ON CONFLICT (tenant_id, month) DO UPDATE SET
       input_tokens = assistant_usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = assistant_usage.output_tokens + EXCLUDED.output_tokens,
       cache_read_tokens = assistant_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
       cache_write_tokens = assistant_usage.cache_write_tokens + EXCLUDED.cache_write_tokens,
       model_steps = assistant_usage.model_steps + 1`,
    [tenantId, day(monthStart(now)), tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens],
  );
}

export function assistantUsageRoutes(app: Hono<AppEnv>, deps: Deps) {
  /** The store a website sign-in token is for; anything else is refused. */
  const storeOf = async (header: string | undefined): Promise<string> => {
    const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
    if (token) {
      try {
        const auth = await verifyAccessToken(deps, token);
        const tenantId = (auth.extra as { tenantId?: string }).tenantId;
        if (tenantId && auth.resource && isSiteResource(auth.resource.href) && auth.expiresAt! * 1000 > Date.now()) return tenantId;
      } catch {
        // An unknown or revoked token: signed out, below.
      }
    }
    throw new HttpError(403, 'Sign in with your website again.');
  };

  app.get('/oauth/site/assistant-usage', async (c) => {
    const tenantId = await storeOf(c.req.header('Authorization'));
    return c.json(await assistantUsage(deps.pool, tenantId), 200, { 'Cache-Control': 'no-store' });
  });

  app.post('/oauth/site/assistant-usage', async (c) => {
    const tenantId = await storeOf(c.req.header('Authorization'));
    const counted = await countAssistantMessage(deps.pool, tenantId);
    if (!counted) {
      const usage = await assistantUsage(deps.pool, tenantId);
      return c.json({ ...usage, error: 'limit' }, 429, { 'Cache-Control': 'no-store' });
    }
    return c.json(counted, 200, { 'Cache-Control': 'no-store' });
  });

  // One model step's tokens, from the assistant after the step finishes ({ inputTokens, outputTokens,
  // cacheReadTokens, cacheWriteTokens }).
  app.post('/oauth/site/assistant-usage/tokens', async (c) => {
    const tenantId = await storeOf(c.req.header('Authorization'));
    const tokens = parseAssistantTokens(await c.req.json().catch(() => null));
    if (!tokens) throw new HttpError(400, 'Send the step\'s inputTokens, outputTokens, cacheReadTokens and cacheWriteTokens as whole numbers.');
    await recordAssistantTokens(deps.pool, tenantId, tokens);
    return c.body(null, 204);
  });
}

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import type { Pool } from './db.ts';
import { HttpError } from './errors.ts';
import { readJson } from './http.ts';
import { SITE_TYPES } from './demodrafts.ts';

/**
 * The website assistant inside a demo on anypress.io/try. A demo runs on WordPress Playground in the visitor's
 * browser, so there is no store for the assistant to sign in to: anypress.io asks here for a demo sign-in
 * (POST /demos/assistant), puts it in the demo, and the assistant beside the demo's page editor uses it. With it the
 * assistant only changes the page open in the editor, which never leaves the visitor's browser.
 *
 * AnyPress pays for these messages, so each demo gets a few (MESSAGES_PER_DEMO), and only so many demos may start one
 * an hour (DEMOS_PER_HOUR). The assistant counts each message here first (POST /demos/assistant/usage).
 */

/** Messages one demo may send the assistant. */
export const MESSAGES_PER_DEMO = 12;
/** Demo sign-ins everyone may start in an hour, before the route answers 429. */
export const DEMOS_PER_HOUR = 40;
/** How long a demo's sign-in lasts: a long visit to /try. */
const DEMO_HOURS = 3;

/** A demo's sign-in starts with this, so the assistant can tell it from a website's. */
const DEMO_TOKEN_PREFIX = 'apdemo_';
const TOKEN = /^apdemo_[A-Za-z0-9_-]{43}$/;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

interface DemoAssistantUsage {
  used: number;
  limit: number;
  /** When this demo's sign-in ends. */
  expiresAt: string;
}

/** The demo a sign-in is for, while it lasts. */
async function demoOf(pool: Pool, header: string | undefined): Promise<{ hash: string; messages: number; expires_at: Date }> {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1] ?? '';
  if (TOKEN.test(token)) {
    const { rows } = await pool.query<{ hash: string; messages: number; expires_at: Date }>(
      'SELECT token_hash AS hash, messages, expires_at FROM demo_assistants WHERE token_hash = $1 AND expires_at > now()',
      [hash(token)],
    );
    if (rows[0]) return rows[0];
  }
  throw new HttpError(403, 'This demo has ended. Start it again to keep going.');
}

const usageOf = (demo: { messages: number; expires_at: Date }): DemoAssistantUsage => ({
  used: demo.messages,
  limit: MESSAGES_PER_DEMO,
  expiresAt: demo.expires_at.toISOString(),
});

export function demoAssistantRoutes(app: Hono<AppEnv>, { pool }: Deps) {
  // A new demo's sign-in for the assistant: { siteType } → { token, limit, expiresAt }. Public, like demo drafts.
  app.post('/demos/assistant', async (c) => {
    const body = ((await readJson(c)) ?? {}) as { siteType?: unknown };
    const siteType = typeof body.siteType === 'string' && (SITE_TYPES as readonly string[]).includes(body.siteType) ? body.siteType : null;
    if (!siteType) throw new HttpError(400, `siteType must be one of: ${SITE_TYPES.join(', ')}`);
    await pool.query(`DELETE FROM demo_assistants WHERE expires_at < now() - interval '1 day'`);
    const recent = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM demo_assistants WHERE created_at > now() - interval '1 hour'`);
    if (recent.rows[0]!.n >= DEMOS_PER_HOUR) throw new HttpError(429, 'The assistant is busy with other demos right now. Try again in a few minutes.');
    const token = DEMO_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const { rows } = await pool.query<{ expires_at: Date }>(
      'INSERT INTO demo_assistants (token_hash, site_type, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3)) RETURNING expires_at',
      [hash(token), siteType, DEMO_HOURS],
    );
    return c.json({ token, limit: MESSAGES_PER_DEMO, expiresAt: rows[0]!.expires_at.toISOString() }, 201, { 'Cache-Control': 'no-store' });
  });

  // How many of its messages the demo has used.
  app.get('/demos/assistant/usage', async (c) => {
    const demo = await demoOf(pool, c.req.header('Authorization'));
    return c.json(usageOf(demo), 200, { 'Cache-Control': 'no-store' });
  });

  // Counts one message, unless the demo's are all used: then 429, and nothing is counted.
  app.post('/demos/assistant/usage', async (c) => {
    const demo = await demoOf(pool, c.req.header('Authorization'));
    const { rows } = await pool.query<{ messages: number; expires_at: Date }>(
      'UPDATE demo_assistants SET messages = messages + 1 WHERE token_hash = $1 AND messages < $2 RETURNING messages, expires_at',
      [demo.hash, MESSAGES_PER_DEMO],
    );
    if (!rows[0]) return c.json({ ...usageOf(demo), error: 'limit' }, 429, { 'Cache-Control': 'no-store' });
    return c.json(usageOf(rows[0]), 200, { 'Cache-Control': 'no-store' });
  });
}

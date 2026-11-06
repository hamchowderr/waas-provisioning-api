import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

/**
 * The pool every query goes through. node-postgres requires an `error` listener: an idle connection
 * that drops (Postgres restarts, a network blip) emits one, and with no listener Node ends the
 * process. The pool throws that connection away and opens a new one on the next query.
 * `statement_timeout` stops one stuck query from holding a connection forever; long work
 * (backups, imports) runs outside the pool or sets its own limit.
 */
export function createPool(databaseUrl: string, { statementTimeoutMs = 60_000 } = {}): Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: 'waas-api',
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: 5 * 60_000,
  });
  pool.on('error', (err) => console.error('postgres: idle connection error:', err.message));
  return pool;
}

export async function migrate(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: fileURLToPath(new URL('../migrations', import.meta.url)),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}

export async function withTransaction<T>(pool: Pool, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Whether a query failed on the named unique constraint (Postgres error 23505). */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === constraint;
}

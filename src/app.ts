import { Hono } from 'hono';
import type { PgBoss } from 'pg-boss';
import type { Config } from './config.ts';
import type { Pool } from './db.ts';
import { HttpError } from './errors.ts';
import { authenticate } from './keys.ts';
import { QUEUE } from './queue.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import type { Secrets } from './secrets.ts';
import { baseSnapshotRoutes } from './routes/basesnapshots.ts';
import { domainRoutes } from './routes/domains.ts';
import { lifecycleRoutes } from './routes/lifecycle.ts';
import { snapshotRoutes } from './routes/snapshots.ts';
import { tenantRoutes } from './routes/tenants.ts';
import { versionRoutes } from './routes/versions.ts';

export interface Deps {
  config: Config;
  pool: Pool;
  boss: PgBoss;
  provisioner: Provisioner;
  secrets: Secrets;
}

export type AppEnv = { Variables: { productId: string } };

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  // For uptime monitoring; outside the WPCS contract and unauthenticated. 503 when Postgres or
  // the job queue doesn't answer within 3 seconds.
  app.get('/health', async (c) => {
    const check = async (fn: () => Promise<unknown>) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), 3000)))]);
        return 'ok';
      } catch {
        return 'down';
      } finally {
        clearTimeout(timer);
      }
    };
    const [database, queue] = await Promise.all([
      check(() => deps.pool.query('SELECT 1')),
      check(async () => {
        if (!(await deps.boss.getQueue(QUEUE))) throw new Error('queue missing');
      }),
    ]);
    const ok = database === 'ok' && queue === 'ok';
    return c.json({ ok, database, queue }, ok ? 200 : 503);
  });

  // Basic auth with the API key as username and the secret as password. Any failure is 403,
  // not 401: the storefront plugin's connection test reads 403 as "invalid key or secret".
  app.use('/v1/*', async (c, next) => {
    const match = /^Basic\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '');
    const decoded = match ? Buffer.from(match[1]!, 'base64').toString('utf8') : '';
    const colon = decoded.indexOf(':');
    const productId = colon > 0 ? await authenticate(deps.pool, decoded.slice(0, colon), decoded.slice(colon + 1)) : null;
    if (!productId) return c.json({ statusCode: 403, message: 'Invalid API key or secret' }, 403);
    c.set('productId', productId);
    await next();
  });

  app.route('/v1/tenants', domainRoutes(deps));
  app.route('/v1/tenants', lifecycleRoutes(deps));
  app.route('/v1/tenants', tenantRoutes(deps));
  app.route('/v1/versions', versionRoutes(deps));
  app.route('/v1/snapshots', snapshotRoutes(deps));
  app.route('/v1/basesnapshots', baseSnapshotRoutes(deps));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ statusCode: err.status, message: err.message }, err.status);
    console.error(err);
    return c.json({ statusCode: 500, message: 'Internal server error' }, 500);
  });

  return app;
}

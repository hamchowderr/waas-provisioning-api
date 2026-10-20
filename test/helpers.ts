import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { createApp, type Deps } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { createPool, migrate, type Pool } from '../src/db.ts';
import { createJobHandlers } from '../src/jobs.ts';
import { createApiKey } from '../src/keys.ts';
import { FakeProvisioner } from '../src/provisioner/fake.ts';
import { startBoss, startWorker } from '../src/queue.ts';
import { Secrets } from '../src/secrets.ts';
import { startWebhookWorker, withWebhooks, type WebhookConfig } from '../src/webhooks.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/waas_test';

/** Test-only admin bearer token. */
export const TEST_ADMIN_TOKEN = 'test-admin-token-not-a-secret';

/** A fixed key for tests only. */
export const TEST_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

export interface TestContext {
  pool: Pool;
  boss: PgBoss;
  provisioner: FakeProvisioner;
  app: ReturnType<typeof createApp>;
  deps: Deps;
  productId: string;
  auth: string;
  /** Sends a request with valid credentials unless `auth` is given. */
  call(method: string, path: string, options?: { body?: unknown; auth?: string | null; headers?: Record<string, string> }): Promise<Response>;
  close(): Promise<void>;
}

export const basic = (key: string, secret: string) => `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;

/** Wipes the test database, migrates it, and starts the app with a queue worker and the fake provisioner. */
export async function setup(): Promise<TestContext> {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;');
  await admin.end();

  await migrate(TEST_DATABASE_URL);
  const config: Config = { databaseUrl: TEST_DATABASE_URL, port: 0, storesDomain: 'stores.waas.example', versionsDomain: 'versions.waas.example', platformDomain: 'waas.example', brandDomain: 'brand.example', secretsKey: TEST_SECRETS_KEY, backupRetentionDays: 90, adminToken: TEST_ADMIN_TOKEN, provisioner: 'fake' };
  const pool = createPool(TEST_DATABASE_URL);
  const boss = await startBoss(TEST_DATABASE_URL, { retryDelaySeconds: 1 });
  const provisioner = new FakeProvisioner();
  const secrets = new Secrets(TEST_SECRETS_KEY);
  // Webhook endpoints in tests are local test servers.
  const webhooks: WebhookConfig = { allowPrivate: true, logDays: 30 };
  config.webhooks = webhooks;
  await startWorker(boss, withWebhooks(createJobHandlers(pool, provisioner, secrets, config.backupRetentionDays, 30, config), pool, boss, webhooks), 0.5);
  await startWebhookWorker(boss, pool, secrets, webhooks, { retryDelaySeconds: 1, retryLimit: 2, pollingIntervalSeconds: 0.5 });
  const deps: Deps = { config, pool, boss, provisioner, secrets };
  const app = createApp(deps);

  const productId = (await pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Example storefront') RETURNING id")).rows[0]!.id;
  const { key, secret } = await createApiKey(pool, productId);
  const auth = basic(key, secret);

  return {
    pool,
    boss,
    provisioner,
    app,
    deps,
    productId,
    auth,
    async call(method, path, { body, auth: authOverride, headers } = {}) {
      const authorization = authOverride === undefined ? auth : authOverride;
      return app.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
    },
    async close() {
      await boss.stop({ graceful: false });
      await pool.end();
    },
  };
}

/** Polls until `check` returns a truthy value. */
export async function waitFor<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

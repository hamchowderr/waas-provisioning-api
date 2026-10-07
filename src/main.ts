import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool, migrate } from './db.ts';
import { createJobHandlers } from './jobs.ts';
import { FakeProvisioner } from './provisioner/fake.ts';
import { startBoss, startWorker } from './queue.ts';
import { Secrets } from './secrets.ts';

const config = loadConfig();
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl);
const boss = await startBoss(config.databaseUrl);
// The only Provisioner until the store host is chosen (waas-api-2hl.4).
const provisioner = new FakeProvisioner();
const secrets = new Secrets(config.secretsKey);
await startWorker(boss, createJobHandlers(pool, provisioner, secrets, config.backupRetentionDays));

const server = serve({ fetch: createApp({ config, pool, boss, provisioner, secrets }).fetch, port: config.port }, (info) =>
  console.log(`WaaS provisioning API listening on :${info.port} (fake provisioner)`),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.close();
    await boss.stop();
    await pool.end();
    process.exit(0);
  });
}

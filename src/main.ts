import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool, migrate } from './db.ts';
import { backupCipherKey, DbBackups, pgDump, startDbBackups } from './dbbackup.ts';
import { createJobHandlers } from './jobs.ts';
import { ensureStoreCrons } from './maintenance.ts';
import { S3 } from './provisioner/s3.ts';
import { CoolifyProvisioner } from './provisioner/coolify/provisioner.ts';
import { FakeProvisioner } from './provisioner/fake.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import { startBoss, startWorker } from './queue.ts';
import { Secrets } from './secrets.ts';

const config = loadConfig();
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl);
const boss = await startBoss(config.databaseUrl);
// Coolify for normal stores (docs/adr/0001-coolify-provisioner.md); the fake for local runs and tests.
const provisioner: Provisioner = config.coolify ? new CoolifyProvisioner(config.coolify) : new FakeProvisioner();
const secrets = new Secrets(config.secretsKey);
await startWorker(boss, createJobHandlers(pool, provisioner, secrets, config.backupRetentionDays));
// Daily off-site backup of this database (docs/db-backups.md), when the S3_* settings are set.
const dbBackups = config.dbBackup
  ? new DbBackups(pool, new S3(config.dbBackup.s3), backupCipherKey(config.secretsKey), config.dbBackup, () => pgDump(config.databaseUrl))
  : undefined;
await startDbBackups(boss, dbBackups, config.dbBackup?.schedule ?? '');
// In the background: a store that already has its cron task costs one Coolify lookup.
void ensureStoreCrons(pool, provisioner);

const server = serve({ fetch: createApp({ config, pool, boss, provisioner, secrets }).fetch, port: config.port }, (info) =>
  console.log(`WaaS provisioning API listening on :${info.port} (${config.provisioner} provisioner${config.adminToken ? '' : '; admin API off: ADMIN_TOKEN not set'}${config.dbBackup ? '' : '; database backups off: S3_* not set'})`),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.close();
    await boss.stop();
    await pool.end();
    process.exit(0);
  });
}

import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool, migrate } from './db.ts';
import { backupCipherKey, DbBackups, pgDump, startDbBackups } from './dbbackup.ts';
import { createJobHandlers } from './jobs.ts';
import { startMailDomainChecks } from './maildomains.ts';
import { maintainStores } from './maintenance.ts';
import { S3 } from './provisioner/s3.ts';
import { CoolifyProvisioner } from './provisioner/coolify/provisioner.ts';
import { FakeProvisioner } from './provisioner/fake.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import { startBoss, startWorker } from './queue.ts';
import { S3ReleaseStore } from './releases.ts';
import { Secrets } from './secrets.ts';
import { startStoreBackups } from './storebackups.ts';

const config = loadConfig();
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl);
const boss = await startBoss(config.databaseUrl);
// Coolify for normal stores (docs/coolify.md); the fake for local runs and tests.
const provisioner: Provisioner = config.coolify ? new CoolifyProvisioner(config.coolify) : new FakeProvisioner();
const secrets = new Secrets(config.secretsKey);
const releases = config.releases ? new S3ReleaseStore(config.releases) : undefined;
const handlers = createJobHandlers(pool, provisioner, secrets, config.backupRetentionDays);
await startWorker(boss, handlers);
// Daily off-site backup of this database (docs/db-backups.md), when the S3_* settings are set.
const dbBackups = config.dbBackup
  ? new DbBackups(pool, new S3(config.dbBackup.s3), backupCipherKey(config.secretsKey), config.dbBackup, () => pgDump(config.databaseUrl))
  : undefined;
await startDbBackups(boss, dbBackups, config.dbBackup?.schedule ?? '');
// Nightly backup of every live store (docs/store-backups.md), unless STORE_BACKUP=off.
await startStoreBackups(boss, pool, provisioner, handlers, config.storeBackup);
// Stores' own sending domains (docs/store-email.md): checked every 10 minutes, when toSend is set up.
await startMailDomainChecks(boss, pool, config.sendingDomains, provisioner);
// In the background: a store already up to date costs two Coolify lookups.
void maintainStores(pool, provisioner);

const server = serve({ fetch: createApp({ config, pool, boss, provisioner, secrets, releases }).fetch, port: config.port }, (info) =>
  console.log(`WaaS provisioning API listening on :${info.port} (${config.provisioner} provisioner${config.adminToken ? '' : '; admin API off: ADMIN_TOKEN not set'}${config.dbBackup ? '' : '; database backups off: S3_* not set'}${config.storeBackup ? '' : '; store backups off'}${releases ? '' : '; plugin updates off: RELEASES_S3_BUCKET not set'})`),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.close();
    await boss.stop();
    await pool.end();
    process.exit(0);
  });
}

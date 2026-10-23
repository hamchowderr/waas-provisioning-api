import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { loadConfig } from './config.ts';
import { createPool, migrate } from './db.ts';
import { backupCipherKey, DbBackups, pgDump, startDbBackups } from './dbbackup.ts';
import { withClientSites } from './clients.ts';
import { withFailureAlerts } from './jobalerts.ts';
import { createJobHandlers } from './jobs.ts';
import { startMailCounts } from './mailcount.ts';
import { startMailDomainChecks } from './maildomains.ts';
import { maintainStores } from './maintenance.ts';
import { S3 } from './provisioner/s3.ts';
import { startResellerInvoices } from './resellerinvoices.ts';
import { startRestoreTests } from './restoretests.ts';
import { CoolifyProvisioner } from './provisioner/coolify/provisioner.ts';
import { FakeProvisioner } from './provisioner/fake.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import { startBoss, startWorker } from './queue.ts';
import { S3ReleaseStore } from './releases.ts';
import { Secrets } from './secrets.ts';
import { siteKey, siteKeyMaster } from './sitekeys.ts';
import { startStoreBackups } from './storebackups.ts';
import { DEFAULT_WEBHOOK_CONFIG, startWebhookWorker, withWebhooks } from './webhooks.ts';

const config = loadConfig();
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl);
const boss = await startBoss(config.databaseUrl);
// Coolify for normal stores (docs/coolify.md); the fake for local runs and tests.
const siteKeys = siteKeyMaster(config.secretsKey);
const provisioner: Provisioner = config.coolify
  ? new CoolifyProvisioner({ ...config.coolify, siteKey: (storeId) => siteKey(siteKeys, storeId) })
  : new FakeProvisioner();
const secrets = new Secrets(config.secretsKey);
const releases = config.releases ? new S3ReleaseStore(config.releases) : undefined;
const webhooks = config.webhooks ?? DEFAULT_WEBHOOK_CONFIG;
// Each finished or failed store and version job sends its webhook event (docs/webhooks.md).
// A client's site is made once their storefront's version has built (src/clients.ts).
// A job that fails its last retry is emailed to the admins (src/jobalerts.ts).
const handlers = withFailureAlerts(
  withClientSites(
    withWebhooks(createJobHandlers(pool, provisioner, secrets, config.backupRetentionDays, config.requestLogDays, config, () => config.dashboardHost), pool, boss, webhooks),
    { config, pool, boss, secrets, provisioner },
  ),
  pool,
  { mail: config.auth?.mail, to: config.jobAlerts, dashboardUrl: config.auth?.url },
);
await startWorker(boss, handlers);
await startWebhookWorker(boss, pool, secrets, webhooks);
// Daily off-site backup of this database (docs/db-backups.md), when the S3_* settings are set.
const dbBackups = config.dbBackup
  ? new DbBackups(pool, new S3(config.dbBackup.s3), backupCipherKey(config.secretsKey), config.dbBackup, () => pgDump(config.databaseUrl))
  : undefined;
await startDbBackups(boss, dbBackups, config.dbBackup?.schedule ?? '');
// Nightly backup of every live store (docs/store-backups.md), unless STORE_BACKUP=off.
await startStoreBackups(boss, pool, provisioner, handlers, config.storeBackup);
// Nightly, one store's latest backup restored into a throwaway copy and checked (docs/store-backups.md), unless RESTORE_TEST=off.
await startRestoreTests(boss, pool, provisioner, config.restoreTest, { mail: config.auth?.mail, to: config.jobAlerts });
// Stores' own sending domains (docs/store-email.md): checked every 10 minutes, when toSend is set up.
await startMailDomainChecks(boss, pool, config.sendingDomains, provisioner, config);
// The platform's count of each store's email (docs/store-email.md): every hour, when toSend is set up.
await startMailCounts(boss, pool, config.mailCounter, provisioner);
// Resellers' monthly wholesale bill as a Stripe invoice (docs/resellers.md), when STRIPE_SECRET_KEY is set.
await startResellerInvoices(boss, pool, config.resellerInvoices);
// In the background: a store already up to date costs two Coolify lookups.
void maintainStores(pool, provisioner, config);

// Sign-in for people (docs/accounts.md), when AUTH_URL and AUTH_SECRET are set.
const auth = config.auth ? createAuth(pool, config.auth) : undefined;

const server = serve({ fetch: createApp({ config, pool, boss, provisioner, secrets, releases, auth }).fetch, port: config.port }, (info) =>
  console.log(`WaaS provisioning API listening on :${info.port} (${config.provisioner} provisioner${config.adminToken ? '' : '; admin API off: ADMIN_TOKEN not set'}${config.dbBackup ? '' : '; database backups off: S3_* not set'}${config.storeBackup ? '' : '; store backups off'}${releases ? '' : '; plugin updates off: RELEASES_S3_BUCKET not set'}${auth ? '' : '; sign-in off: AUTH_URL not set'})`),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.close();
    await boss.stop();
    await pool.end();
    process.exit(0);
  });
}

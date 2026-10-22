import { maintainDashboardDomains } from './dashboarddomains.ts';
import type { Pool } from './db.ts';
import type { Brand, Provisioner, VersionPlugin } from './provisioner/provisioner.ts';
import type { JobData, JobHandlers } from './queue.ts';
import { purgeExpiredImports } from './imports.ts';
import { recordMailSender, storeMailbox, type MailboxDomains } from './mailcount.ts';
import { storeSenders } from './maildomains.ts';
import { pruneRequestLog } from './requestlog.ts';
import type { Secrets } from './secrets.ts';
import { Status } from './status.ts';
import { decodePhpConstants, emailPacksBought, TENANT_SELECT } from './tenants.ts';
import type { DashboardHost } from './vercel.ts';

/**
 * `mailboxDomains` names each store's mailbox at the platform's sending domain (src/mailcount.ts); without
 * them stores send from the platform's address.
 */
export function createJobHandlers(
  pool: Pool,
  provisioner: Provisioner,
  secrets: Secrets,
  backupRetentionDays: number,
  requestLogDays = 30,
  mailboxDomains?: MailboxDomains,
  /** Sellers' own dashboard addresses, checked nightly (src/dashboarddomains.ts). */
  dashboardHost: () => DashboardHost | undefined = () => undefined,
): JobHandlers {
  const mailbox = (tenantId: string) => (mailboxDomains ? storeMailbox(pool, provisioner, mailboxDomains, tenantId) : Promise.resolve(undefined));

  const setTenantStatus = (tenantId: string, status: number, onlyFrom?: number) =>
    pool.query(
      `UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 ${onlyFrom === undefined ? '' : 'AND status = $3'}`,
      onlyFrom === undefined ? [tenantId, status] : [tenantId, status, onlyFrom],
    );

  return {
    async run(data: JobData) {
      switch (data.type) {
        case 'version.create':
          return createVersion(pool, provisioner, secrets, data);
        case 'basesnapshot.delete':
          await provisioner.deleteBaseSnapshot({ baseSnapshotId: data.baseSnapshotId });
          return;
        case 'version.delete':
          await provisioner.deleteVersion({ versionId: data.versionId });
          await pool.query('DELETE FROM versions WHERE id = $1', [data.versionId]);
          return;
        case 'tenant.create':
          return createTenant(pool, provisioner, secrets, data, await mailbox(data.tenantId));
        case 'tenant.update': {
          const { rows } = await pool.query('SELECT php_constants, size FROM tenants WHERE id = $1', [data.tenantId]);
          if (!rows[0]) return;
          await provisioner.updateStore({
            storeId: data.tenantId,
            wpOptions: data.wpOptions,
            // The full set whenever any constant changed: a host may have to rewrite them all at once.
            phpConstants: data.phpConstantNames?.length ? decodePhpConstants(secrets, rows[0].php_constants) : undefined,
            // The size on record, not the job's: a later PUT may have changed it again before this ran.
            size: data.size ? rows[0].size : undefined,
          });
          // A move or delete queued meanwhile has set its own status; only finish a Pending one.
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        }
        case 'tenant.move': {
          const { rows } = await pool.query('SELECT own_code FROM tenants WHERE id = $1', [data.tenantId]);
          await provisioner.moveStore({ storeId: data.tenantId, targetVersionId: data.targetVersionId, ownCode: rows[0]?.own_code === true });
          await pool.query('UPDATE tenants SET version_id = $2, date_changed = now() WHERE id = $1', [data.tenantId, data.targetVersionId]);
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        }
        case 'tenant.domains': {
          const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
          if (!rows[0]) return;
          // The store's mailbox follows its main domain; a store sending from its own domain keeps it.
          const sender = (await storeSenders(pool, data.tenantId)).get(data.tenantId);
          const mail = mailboxDomains && (sender ? { sender } : { mailbox: await mailbox(data.tenantId) });
          await provisioner.setDomains({ storeId: data.tenantId, mainDomain: rows[0].main_domain, redirectDomains: rows[0].redirect_domains, mail });
          if (mail) await recordMailSender(pool, provisioner, data.tenantId, mail);
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        }
        case 'tenant.delete': {
          await provisioner.deleteStore({ storeId: data.tenantId });
          // A site that was being moved in leaves no upload behind.
          await provisioner.deleteImport({ storeId: data.tenantId });
          // Keep what a restore needs on the backups, which outlive the tenant.
          const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
          const { rows: domains } = await pool.query(
            'SELECT domain_name, is_main, is_base FROM tenant_domains WHERE tenant_id = $1 ORDER BY date_created',
            [data.tenantId],
          );
          const record = rows[0] && {
            name: rows[0].name,
            versionId: rows[0].version_id,
            snapshotId: rows[0].snapshot_id,
            snapshotName: rows[0].snapshot_name,
            snapshotGroupName: rows[0].snapshot_group_name,
            size: rows[0].size,
            ownCode: rows[0].own_code,
            domains: domains.map((d) => ({ domainName: d.domain_name, isMain: d.is_main, isBase: d.is_base })),
          };
          await pool.query(
            'UPDATE tenant_backups SET tenant_deleted_at = now(), tenant_record = COALESCE($2, tenant_record) WHERE tenant_id = $1 AND tenant_deleted_at IS NULL',
            [data.tenantId, record ?? null],
          );
          await pool.query('DELETE FROM tenants WHERE id = $1', [data.tenantId]);
          return;
        }
        case 'tenant.restore': {
          const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
          const tenant = rows[0];
          if (!tenant) return;
          const restoredMailbox = await mailbox(tenant.id);
          await provisioner.restoreDeletedStore({
            storeId: tenant.id,
            backupId: data.backupId,
            versionId: tenant.version_id,
            mainDomain: tenant.main_domain,
            redirectDomains: tenant.redirect_domains,
            phpConstants: decodePhpConstants(secrets, tenant.php_constants),
            wpOptions: tenant.wp_options,
            size: tenant.size,
            ownCode: tenant.own_code,
            mailbox: restoredMailbox,
          });
          await recordMailSender(pool, provisioner, tenant.id, { mailbox: restoredMailbox });
          await setTenantStatus(tenant.id, Status.Done, Status.Pending);
          return;
        }
        case 'tenant.rollback': {
          if (data.safetyBackupId) await backUp(pool, provisioner, data.tenantId, data.safetyBackupId);
          const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
          if (!rows[0]) return;
          await provisioner.rollbackStore({
            storeId: data.tenantId,
            backupId: data.backupId,
            wpOptions: rows[0].wp_options,
            mainDomain: rows[0].main_domain,
            ownCode: rows[0].own_code,
          });
          // The backup's database holds the pack total of its day; tell the store the one on record again.
          const purchased = await emailPacksBought(pool, data.tenantId);
          if (purchased) await provisioner.setEmailPacks({ storeId: data.tenantId, purchased });
          // Its platform email count is an older one too: the next count tells the store again.
          await pool.query('DELETE FROM tenant_mail_usage WHERE tenant_id = $1', [data.tenantId]);
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        }
        case 'tenant.suspend':
          if (data.backupId) await backUp(pool, provisioner, data.tenantId, data.backupId);
          await provisioner.suspendStore({ storeId: data.tenantId, brand: await resellerBrand(pool, data.tenantId) });
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        case 'tenant.resume':
          await provisioner.resumeStore({ storeId: data.tenantId });
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        case 'tenant.backup':
          await backUp(pool, provisioner, data.tenantId, data.backupId);
          return;
        case 'tenant.email-packs': {
          const { rowCount } = await pool.query('SELECT 1 FROM tenants WHERE id = $1', [data.tenantId]);
          if (!rowCount) return;
          // The total on record when the job runs, not when it was queued: packs bought meanwhile are included.
          await provisioner.setEmailPacks({ storeId: data.tenantId, purchased: await emailPacksBought(pool, data.tenantId) });
          return;
        }
      }
    },

    async maintenance() {
      await purgeExpiredBackups(pool, provisioner, backupRetentionDays);
      await purgeExpiredImports(pool, provisioner);
      await pruneRequestLog(pool, requestLogDays);
      await maintainDashboardDomains(pool, dashboardHost());
    },

    async fail(data: JobData, error: unknown, job: { id: string; attempts: number }) {
      await pool.query(
        `INSERT INTO job_failures (job_id, job_type, job_data, tenant_id, version_id, error_message, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          job.id,
          data.type,
          data,
          'tenantId' in data ? data.tenantId : null,
          'versionId' in data ? data.versionId : null,
          error instanceof Error ? error.message : String(error),
          job.attempts,
        ],
      );
      switch (data.type) {
        case 'version.create':
          await pool.query('UPDATE versions SET status = $2, date_changed = now() WHERE id = $1 AND status = $3', [data.versionId, Status.Failed, Status.Pending]);
          await pool.query('UPDATE snapshots SET status = $2 WHERE version_id = $1 AND status = $3', [data.versionId, Status.Failed, Status.Pending]);
          return;
        case 'basesnapshot.delete':
          return; // the row is gone already; the job error is logged
        case 'version.delete':
          await pool.query('UPDATE versions SET status = $2, date_changed = now() WHERE id = $1', [data.versionId, Status.Failed]);
          await pool.query('UPDATE snapshots SET status = $2 WHERE version_id = $1 AND status = $3', [data.versionId, Status.Failed, Status.Removing]);
          return;
        case 'tenant.create':
        case 'tenant.update':
        case 'tenant.move':
        case 'tenant.domains':
          await setTenantStatus(data.tenantId, Status.Failed, Status.Pending);
          return;
        case 'tenant.email-packs':
          // The store still works; it just doesn't have its new pack emails yet. The shop's retry sends them again.
          return;
        case 'tenant.delete':
          await setTenantStatus(data.tenantId, Status.Failed);
          return;
        case 'tenant.suspend':
        case 'tenant.resume':
          if ('backupId' in data && data.backupId) await failBackup(pool, data.backupId);
          await setTenantStatus(data.tenantId, Status.Failed, Status.Pending);
          return;
        case 'tenant.backup':
          await failBackup(pool, data.backupId);
          return;
        case 'tenant.restore':
          await setTenantStatus(data.tenantId, Status.Failed, Status.Pending);
          return;
        case 'tenant.rollback': {
          // The backup taken first never finished: the store was not touched and still works.
          const untouched = data.safetyBackupId && (await failBackup(pool, data.safetyBackupId)).rowCount;
          await setTenantStatus(data.tenantId, untouched ? Status.Done : Status.Failed, Status.Pending);
          return;
        }
      }
    },
  };
}

/** The brand of the reseller a store's storefront belongs to, when it set one: its stores' "unavailable" page shows it. */
async function resellerBrand(pool: Pool, tenantId: string): Promise<Brand | undefined> {
  const { rows } = await pool.query(
    `SELECT r.brand_name, r.brand_url FROM tenants t JOIN products p ON p.id = t.product_id JOIN resellers r ON r.id = p.reseller_id
      WHERE t.id = $1 AND r.brand_name IS NOT NULL`,
    [tenantId],
  );
  return rows[0] ? { name: rows[0].brand_name, url: rows[0].brand_url ?? undefined } : undefined;
}

async function createVersion(pool: Pool, provisioner: Provisioner, secrets: Secrets, data: Extract<JobData, { type: 'version.create' }>) {
  const { rows } = await pool.query('SELECT * FROM versions WHERE id = $1', [data.versionId]);
  const version = rows[0];
  if (!version) return; // removed before the build ran

  // Plugin choices (docs/plugin-choices.md) as they were when the version was made; each added plugin's file is kept.
  // Licence constants stay encrypted in the row and are only opened here, for the build.
  const plugins: (VersionPlugin & { name?: string; file?: string; licence?: string })[] = version.plugin_choices ?? [];
  const { pluginFiles } = await provisioner.buildVersion({
    versionId: version.id,
    domain: version.domain,
    wordPressVersion: version.wordpress_version,
    phpVersion: version.php_version,
    source: data.source,
    plugins: plugins.map(({ name: _name, file: _file, licence, ...p }) => (licence ? { ...p, constants: JSON.parse(secrets.decrypt(licence)) } : p)),
  });
  if (plugins.length) {
    const withFiles = plugins.map((p) => (pluginFiles[p.slug] ? { ...p, file: pluginFiles[p.slug] } : p));
    await pool.query('UPDATE versions SET plugin_choices = $2 WHERE id = $1', [version.id, JSON.stringify(withFiles)]);
  }

  const snapshots = await pool.query('SELECT id, source_snapshot_id, source_base_snapshot_id FROM snapshots WHERE version_id = $1 AND status = $2', [
    version.id,
    Status.Pending,
  ]);
  for (const snapshot of snapshots.rows) {
    if (snapshot.source_base_snapshot_id) {
      await provisioner.copyBaseSnapshot({ baseSnapshotId: snapshot.source_base_snapshot_id, newSnapshotId: snapshot.id, targetVersionId: version.id });
    } else if (snapshot.source_snapshot_id) {
      await provisioner.copySnapshot({ snapshotId: snapshot.source_snapshot_id, newSnapshotId: snapshot.id, targetVersionId: version.id });
    } else {
      await provisioner.snapshotUpload({ versionId: version.id, snapshotId: snapshot.id });
    }
    await pool.query('UPDATE snapshots SET status = $2 WHERE id = $1 AND status = $3', [snapshot.id, Status.Done, Status.Pending]);
  }

  // A delete queued meanwhile has already set Removing; leave that alone.
  await pool.query('UPDATE versions SET status = $2, date_changed = now() WHERE id = $1 AND status = $3', [version.id, Status.Done, Status.Pending]);
}

async function createTenant(pool: Pool, provisioner: Provisioner, secrets: Secrets, data: Extract<JobData, { type: 'tenant.create' }>, mailbox?: string) {
  const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
  const tenant = rows[0];
  if (!tenant) return; // removed before it was built

  const user = data.user && {
    name: data.user.name,
    email: data.user.email,
    role: data.user.role,
    password: data.user.encryptedPassword ? secrets.decrypt(data.user.encryptedPassword) : undefined,
  };
  await provisioner.createStore({
    storeId: tenant.id,
    versionId: tenant.version_id,
    snapshotId: tenant.snapshot_id,
    mainDomain: tenant.main_domain,
    redirectDomains: tenant.redirect_domains,
    phpConstants: decodePhpConstants(secrets, tenant.php_constants),
    wpOptions: tenant.wp_options,
    size: tenant.size,
    ownCode: tenant.own_code,
    mailbox,
    user,
  });
  await recordMailSender(pool, provisioner, tenant.id, { mailbox });
  await pool.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 AND status = $3', [tenant.id, Status.Done, Status.Pending]);
  // A site moved in is built: its upload is no longer needed.
  if (tenant.snapshot_id === null) await provisioner.deleteImport({ storeId: tenant.id });
}

async function backUp(pool: Pool, provisioner: Provisioner, tenantId: string, backupId: string) {
  const { rows } = await pool.query('SELECT status FROM tenant_backups WHERE id = $1', [backupId]);
  if (rows[0]?.status !== Status.Pending) return; // already taken on an earlier attempt
  const { sizeBytes } = await provisioner.backupStore({ storeId: tenantId, backupId });
  // The constants and options a restore from this backup brings back.
  await pool.query(
    `UPDATE tenant_backups b SET status = $2, size_bytes = $3, wp_options = t.wp_options, php_constants = t.php_constants
       FROM tenants t WHERE b.id = $1 AND t.id = b.tenant_id`,
    [backupId, Status.Done, sizeBytes],
  );
}

const failBackup = (pool: Pool, backupId: string) =>
  pool.query('UPDATE tenant_backups SET status = $2 WHERE id = $1 AND status = $3', [backupId, Status.Failed, Status.Pending]);

/** Deletes the backups of tenants deleted more than `retentionDays` ago. Safe to re-run. */
export async function purgeExpiredBackups(pool: Pool, provisioner: Provisioner, retentionDays: number): Promise<number> {
  const { rows } = await pool.query('SELECT id FROM tenant_backups WHERE tenant_deleted_at < now() - make_interval(days => $1)', [retentionDays]);
  for (const { id } of rows) {
    await provisioner.deleteBackup({ backupId: id });
    await pool.query('DELETE FROM tenant_backups WHERE id = $1', [id]);
  }
  return rows.length;
}

import type { Pool } from './db.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import type { JobData, JobHandlers } from './queue.ts';
import type { Secrets } from './secrets.ts';
import { Status } from './status.ts';
import { decodePhpConstants, TENANT_SELECT } from './tenants.ts';

export function createJobHandlers(pool: Pool, provisioner: Provisioner, secrets: Secrets, backupRetentionDays: number): JobHandlers {
  const setTenantStatus = (tenantId: string, status: number, onlyFrom?: number) =>
    pool.query(
      `UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 ${onlyFrom === undefined ? '' : 'AND status = $3'}`,
      onlyFrom === undefined ? [tenantId, status] : [tenantId, status, onlyFrom],
    );

  return {
    async run(data: JobData) {
      switch (data.type) {
        case 'version.create':
          return createVersion(pool, provisioner, data);
        case 'basesnapshot.delete':
          await provisioner.deleteBaseSnapshot({ baseSnapshotId: data.baseSnapshotId });
          return;
        case 'version.delete':
          await provisioner.deleteVersion({ versionId: data.versionId });
          await pool.query('DELETE FROM versions WHERE id = $1', [data.versionId]);
          return;
        case 'tenant.create':
          return createTenant(pool, provisioner, secrets, data);
        case 'tenant.update': {
          const { rows } = await pool.query('SELECT php_constants FROM tenants WHERE id = $1', [data.tenantId]);
          if (!rows[0]) return;
          await provisioner.updateStore({
            storeId: data.tenantId,
            wpOptions: data.wpOptions,
            phpConstants: decodePhpConstants(secrets, rows[0].php_constants, data.phpConstantNames ?? []),
          });
          // A move or delete queued meanwhile has set its own status; only finish a Pending one.
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        }
        case 'tenant.move':
          await provisioner.moveStore({ storeId: data.tenantId, targetVersionId: data.targetVersionId });
          await pool.query('UPDATE tenants SET version_id = $2, date_changed = now() WHERE id = $1', [data.tenantId, data.targetVersionId]);
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        case 'tenant.domains': {
          const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [data.tenantId]);
          if (!rows[0]) return;
          await provisioner.setDomains({ storeId: data.tenantId, mainDomain: rows[0].main_domain, redirectDomains: rows[0].redirect_domains });
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        }
        case 'tenant.delete': {
          await provisioner.deleteStore({ storeId: data.tenantId });
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
          await provisioner.restoreDeletedStore({
            storeId: tenant.id,
            backupId: data.backupId,
            versionId: tenant.version_id,
            mainDomain: tenant.main_domain,
            redirectDomains: tenant.redirect_domains,
            phpConstants: decodePhpConstants(secrets, tenant.php_constants),
            wpOptions: tenant.wp_options,
          });
          await setTenantStatus(tenant.id, Status.Done, Status.Pending);
          return;
        }
        case 'tenant.suspend':
          if (data.backupId) await backUp(pool, provisioner, data.tenantId, data.backupId);
          await provisioner.suspendStore({ storeId: data.tenantId });
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        case 'tenant.resume':
          await provisioner.resumeStore({ storeId: data.tenantId });
          await setTenantStatus(data.tenantId, Status.Done, Status.Pending);
          return;
        case 'tenant.backup':
          await backUp(pool, provisioner, data.tenantId, data.backupId);
          return;
      }
    },

    async maintenance() {
      await purgeExpiredBackups(pool, provisioner, backupRetentionDays);
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
      }
    },
  };
}

async function createVersion(pool: Pool, provisioner: Provisioner, data: Extract<JobData, { type: 'version.create' }>) {
  const { rows } = await pool.query('SELECT * FROM versions WHERE id = $1', [data.versionId]);
  const version = rows[0];
  if (!version) return; // removed before the build ran

  await provisioner.buildVersion({
    versionId: version.id,
    domain: version.domain,
    wordPressVersion: version.wordpress_version,
    phpVersion: version.php_version,
    source: data.source,
  });

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

async function createTenant(pool: Pool, provisioner: Provisioner, secrets: Secrets, data: Extract<JobData, { type: 'tenant.create' }>) {
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
    user,
  });
  await pool.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1 AND status = $3', [tenant.id, Status.Done, Status.Pending]);
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

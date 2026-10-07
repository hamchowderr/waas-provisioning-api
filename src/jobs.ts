import type { Pool } from './db.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import type { JobData, JobHandlers } from './queue.ts';
import type { Secrets } from './secrets.ts';
import { Status } from './status.ts';
import { decodePhpConstants, TENANT_SELECT } from './tenants.ts';

export function createJobHandlers(pool: Pool, provisioner: Provisioner, secrets: Secrets): JobHandlers {
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
        case 'tenant.delete':
          await provisioner.deleteStore({ storeId: data.tenantId });
          await pool.query('DELETE FROM tenants WHERE id = $1', [data.tenantId]);
          return;
      }
    },

    async fail(data: JobData) {
      switch (data.type) {
        case 'version.create':
          await pool.query('UPDATE versions SET status = $2, date_changed = now() WHERE id = $1 AND status = $3', [data.versionId, Status.Failed, Status.Pending]);
          await pool.query('UPDATE snapshots SET status = $2 WHERE version_id = $1 AND status = $3', [data.versionId, Status.Failed, Status.Pending]);
          return;
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

  const snapshots = await pool.query('SELECT id, source_snapshot_id FROM snapshots WHERE version_id = $1 AND status = $2', [version.id, Status.Pending]);
  for (const snapshot of snapshots.rows) {
    if (snapshot.source_snapshot_id) {
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

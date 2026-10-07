import type { Pool } from './db.ts';
import type { Provisioner } from './provisioner/provisioner.ts';
import type { JobData, JobHandlers } from './queue.ts';
import { Status } from './status.ts';

export function createJobHandlers(pool: Pool, provisioner: Provisioner): JobHandlers {
  return {
    async run(data: JobData) {
      switch (data.type) {
        case 'version.create':
          return createVersion(pool, provisioner, data);
        case 'version.delete':
          await provisioner.deleteVersion({ versionId: data.versionId });
          await pool.query('DELETE FROM versions WHERE id = $1', [data.versionId]);
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

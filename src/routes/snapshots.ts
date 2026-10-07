import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { badRequest } from '../errors.ts';
import { booleanQuery, compact, requiredUuidQuery, uuidQuery } from '../http.ts';
import { Status, statusName } from '../status.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSnapshot(row: any) {
  return compact({
    id: row.id,
    versionId: row.version_id,
    dateCreated: row.date_created.toISOString(),
    name: row.name,
    groupName: row.group_name,
    isCustomSnapshot: row.is_custom_snapshot,
    isTenantSnapshot: row.is_tenant_snapshot,
    statusCode: row.status,
    statusName: statusName(row.status),
  });
}

export function snapshotRoutes({ pool, provisioner }: Deps) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const { rows } = await pool.query(
      `SELECT s.* FROM snapshots s JOIN versions v ON v.id = s.version_id
        WHERE s.product_id = $1
          AND ($2::uuid IS NULL OR s.version_id = $2)
          AND ($3::uuid IS NULL OR s.id = $3)
          AND ($4::text IS NULL OR s.name = $4)
          AND ($5::text IS NULL OR s.group_name = $5)
          AND (NOT $6::boolean OR v.is_production)
        ORDER BY s.date_created`,
      [
        c.get('productId'),
        uuidQuery(c, 'versionId') ?? null,
        uuidQuery(c, 'snapshotId') ?? null,
        c.req.query('snapshotName') || null,
        c.req.query('groupName') || null,
        booleanQuery(c, 'onlyProductionVersion') ?? false,
      ],
    );
    return c.json(rows.map(toSnapshot));
  });

  app.get('/download', async (c) => {
    const snapshotId = requiredUuidQuery(c, 'snapshotId');
    const { rows } = await pool.query('SELECT status FROM snapshots WHERE id = $1 AND product_id = $2', [snapshotId, c.get('productId')]);
    if (!rows[0]) throw badRequest(`Snapshot ${snapshotId} not found`);
    if (rows[0].status !== Status.Done) throw badRequest(`Snapshot ${snapshotId} is ${statusName(rows[0].status)}, not Done`);
    const zip = await provisioner.downloadSnapshot({ snapshotId });
    return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${snapshotId}.zip"`,
    });
  });

  return app;
}

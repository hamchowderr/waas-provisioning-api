import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { withTransaction } from '../db.ts';
import { badRequest } from '../errors.ts';
import { compact, readJson, requiredUuidQuery, uuidQuery } from '../http.ts';
import { validateBody } from '../openapi.ts';
import { enqueue } from '../queue.ts';
import { Status, statusName } from '../status.ts';

interface CreateVersionParams {
  name: string;
  phpVersion: string;
  wordPressVersion: string;
  snapshotId?: string;
  snapshotIdsToCopy?: string[] | null;
  useCustomUpload?: boolean;
  asZip?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toVersion(row: any) {
  return {
    id: row.id,
    isProduction: row.is_production,
    name: row.name,
    dateChanged: row.date_changed.toISOString(),
    dateCreated: row.date_created.toISOString(),
    statusCode: row.status,
    statusName: statusName(row.status),
    domain: row.domain,
  };
}

/** "V1.1 beta" -> "v1-1-beta" */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'version'
  );
}

export function versionRoutes({ config, pool, boss, provisioner }: Deps) {
  const app = new Hono<AppEnv>();

  async function findVersion(productId: string, versionId: string) {
    const { rows } = await pool.query('SELECT * FROM versions WHERE id = $1 AND product_id = $2', [versionId, productId]);
    if (!rows[0]) throw badRequest(`Version ${versionId} not found`);
    return rows[0];
  }

  app.get('/', async (c) => {
    const versionId = uuidQuery(c, 'versionId');
    const versionName = c.req.query('versionName') || undefined;
    const { rows } = await pool.query(
      `SELECT * FROM versions
        WHERE product_id = $1 AND ($2::uuid IS NULL OR id = $2) AND ($3::text IS NULL OR name = $3)
        ORDER BY date_created`,
      [c.get('productId'), versionId ?? null, versionName ?? null],
    );
    return c.json(rows.map(toVersion));
  });

  app.post('/', async (c) => {
    const productId = c.get('productId');
    const body = validateBody<CreateVersionParams>('CreateVersionParams', await readJson(c));
    for (const field of ['name', 'phpVersion', 'wordPressVersion'] as const) {
      if (!body[field].trim()) throw badRequest(`${field} is required`);
    }
    const upload = body.useCustomUpload === true;
    if (upload === Boolean(body.snapshotId)) throw badRequest('Send either a snapshotId or useCustomUpload: true');
    if (body.asZip && !upload) throw badRequest('asZip can only be used with useCustomUpload');

    // The base snapshot and any extra ones are copied into the new version.
    const copyIds = [...new Set([...(body.snapshotId ? [body.snapshotId] : []), ...(body.snapshotIdsToCopy ?? [])])];
    const { rows: sources } = await pool.query(
      'SELECT * FROM snapshots WHERE product_id = $1 AND id = ANY($2::uuid[]) AND status = $3',
      [productId, copyIds, Status.Done],
    );
    const missing = copyIds.filter((id) => !sources.some((s) => s.id === id));
    if (missing.length) throw badRequest(`Snapshot ${missing.join(', ')} not found or not ready`);

    const id = randomUUID();
    const base = slug(body.name);
    const taken = await pool.query('SELECT 1 FROM versions WHERE domain = $1', [`${base}.${config.versionsDomain}`]);
    const domain = `${taken.rowCount ? `${base}-${id.slice(0, 8)}` : base}.${config.versionsDomain}`;
    const uploadUrl = upload ? await provisioner.createUploadUrl({ versionId: id, asZip: body.asZip === true }) : undefined;

    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO versions (id, product_id, name, domain, wordpress_version, php_version, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, productId, body.name, domain, body.wordPressVersion, body.phpVersion, Status.Pending],
      );
      for (const s of sources) {
        await client.query(
          `INSERT INTO snapshots (product_id, version_id, name, group_name, is_custom_snapshot, is_tenant_snapshot, source_snapshot_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [productId, id, s.name, s.group_name, s.is_custom_snapshot, s.is_tenant_snapshot, s.id, Status.Pending],
        );
      }
      if (upload) {
        await client.query(
          'INSERT INTO snapshots (product_id, version_id, name, is_custom_snapshot, status) VALUES ($1, $2, $3, true, $4)',
          [productId, id, body.name, Status.Pending],
        );
      }
      await enqueue(boss, client, {
        type: 'version.create',
        versionId: id,
        source: body.snapshotId ? { snapshotId: body.snapshotId } : { upload: true },
      });
    });

    return c.json(
      compact({ id, domainName: domain, name: body.name, wordPressVersion: body.wordPressVersion, phpVersion: body.phpVersion, uploadUrl }),
    );
  });

  app.delete('/', async (c) => {
    const productId = c.get('productId');
    const version = await findVersion(productId, requiredUuidQuery(c, 'versionId'));
    if (version.is_production) throw badRequest('The production version cannot be removed');
    if (version.status !== Status.Removing) {
      await withTransaction(pool, async (client) => {
        await client.query('UPDATE versions SET status = $2, date_changed = now() WHERE id = $1', [version.id, Status.Removing]);
        await client.query('UPDATE snapshots SET status = $2 WHERE version_id = $1', [version.id, Status.Removing]);
        await enqueue(boss, client, { type: 'version.delete', versionId: version.id });
      });
    }
    return c.body(null, 200);
  });

  app.put('/production', async (c) => {
    const productId = c.get('productId');
    const body = validateBody<{ versionId: string }>('ProductionVersionParams', await readJson(c));
    const version = await findVersion(productId, body.versionId);
    if (version.status !== Status.Done) throw badRequest(`Version ${version.id} is ${statusName(version.status)}, not Done`);
    await withTransaction(pool, async (client) => {
      await client.query('UPDATE versions SET is_production = false, date_changed = now() WHERE product_id = $1 AND is_production', [productId]);
      await client.query('UPDATE versions SET is_production = true, date_changed = now() WHERE id = $1', [version.id]);
    });
    return c.json({ id: version.id });
  });

  return app;
}

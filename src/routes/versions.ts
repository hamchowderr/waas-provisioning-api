import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { withTransaction } from '../db.ts';
import { badRequest } from '../errors.ts';
import { compact, readJson, requiredUuidQuery, uuidQuery } from '../http.ts';
import { validateBody } from '../openapi.ts';
import { enqueue } from '../queue.ts';
import { PRODUCT_TEMPLATES } from './basesnapshots.ts';
import { Status, statusName } from '../status.ts';
import { dnsSafeLabel } from '../tenants.ts';

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

/**
 * The version operations, for one product. Used by the /v1 routes below (product from the API
 * key) and the admin routes (product from the path), so both behave and answer the same.
 */
export function versionService({ config, pool, boss, provisioner }: Deps) {
  async function findVersion(productId: string, versionId: string) {
    const { rows } = await pool.query('SELECT * FROM versions WHERE id = $1 AND product_id = $2', [versionId, productId]);
    if (!rows[0]) throw badRequest(`Version ${versionId} not found`);
    return rows[0];
  }

  async function list(productId: string, filter: { versionId?: string; versionName?: string } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM versions
        WHERE product_id = $1 AND ($2::uuid IS NULL OR id = $2) AND ($3::text IS NULL OR name = $3)
        ORDER BY date_created`,
      [productId, filter.versionId ?? null, filter.versionName ?? null],
    );
    return rows.map(toVersion);
  }

  /** CreateVersionParams in, CreateVersionCommandResult out. */
  async function create(productId: string, input: unknown) {
    const body = validateBody<CreateVersionParams>('CreateVersionParams', input);
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
    // Ids that aren't version snapshots may be the product's base snapshots (templates), or its reseller's shared ones.
    const { rows: templates } = await pool.query(`SELECT * FROM base_snapshots WHERE ${PRODUCT_TEMPLATES('$1')} AND id = ANY($2::uuid[])`, [
      productId,
      copyIds.filter((id) => !sources.some((s) => s.id === id)),
    ]);
    const missing = copyIds.filter((id) => !sources.some((s) => s.id === id) && !templates.some((b) => b.id === id));
    if (missing.length) throw badRequest(`Snapshot ${missing.join(', ')} not found or not ready`);

    const id = randomUUID();
    const base = dnsSafeLabel(slug(body.name), 'v');
    const taken = await pool.query('SELECT 1 FROM versions WHERE domain = $1', [`${base}.${config.versionsDomain}`]);
    const domain = `${taken.rowCount ? dnsSafeLabel(`${base}-${id.slice(0, 8)}`, 'v') : base}.${config.versionsDomain}`;
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
      for (const b of templates) {
        await client.query(
          `INSERT INTO snapshots (product_id, version_id, name, group_name, is_tenant_snapshot, source_base_snapshot_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [productId, id, b.name, b.group_name, b.is_tenant_snapshot, b.id, Status.Pending],
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
        source: !body.snapshotId
          ? { upload: true }
          : templates.some((b) => b.id === body.snapshotId)
            ? { baseSnapshotId: body.snapshotId }
            : { snapshotId: body.snapshotId },
      });
    });

    return compact({ id, domainName: domain, name: body.name, wordPressVersion: body.wordPressVersion, phpVersion: body.phpVersion, uploadUrl });
  }

  async function remove(productId: string, versionId: string) {
    const version = await findVersion(productId, versionId);
    if (version.is_production) throw badRequest('The production version cannot be removed');
    const inUse = await pool.query('SELECT count(*)::int AS n FROM tenants WHERE version_id = $1', [version.id]);
    if (inUse.rows[0].n > 0) throw badRequest(`Version ${version.id} still has ${inUse.rows[0].n} tenant(s); move them first`);
    if (version.status !== Status.Removing) {
      await withTransaction(pool, async (client) => {
        await client.query('UPDATE versions SET status = $2, date_changed = now() WHERE id = $1', [version.id, Status.Removing]);
        await client.query('UPDATE snapshots SET status = $2 WHERE version_id = $1', [version.id, Status.Removing]);
        await enqueue(boss, client, { type: 'version.delete', versionId: version.id });
      });
    }
  }

  /** SetProductionVersionCommandResult out. */
  async function setProduction(productId: string, versionId: string) {
    const version = await findVersion(productId, versionId);
    if (version.status !== Status.Done) throw badRequest(`Version ${version.id} is ${statusName(version.status)}, not Done`);
    await withTransaction(pool, async (client) => {
      await client.query('UPDATE versions SET is_production = false, date_changed = now() WHERE product_id = $1 AND is_production', [productId]);
      await client.query('UPDATE versions SET is_production = true, date_changed = now() WHERE id = $1', [version.id]);
    });
    return { id: version.id };
  }

  /**
   * The production version of `sourceProductId` and its newest template, as they would build a store
   * now; 400 when it has none ready. What a new product can start from.
   */
  async function productionSource(sourceProductId: string) {
    const { rows } = await pool.query(
      `SELECT v.name, v.wordpress_version, v.php_version, s.id AS snapshot_id, s.name AS snapshot_name, s.group_name
         FROM versions v JOIN snapshots s ON s.version_id = v.id AND s.status = $2
        WHERE v.product_id = $1 AND v.is_production AND v.status = $2
        ORDER BY s.date_created DESC LIMIT 1`,
      [sourceProductId, Status.Done],
    );
    if (!rows[0]) throw badRequest('That storefront has no ready production version with a template to start from');
    return rows[0] as { name: string; wordpress_version: string; php_version: string; snapshot_id: string; snapshot_name: string; group_name: string | null };
  }

  /**
   * Gives a new product a copy of that version and template, as its production version, so stores can
   * be made at once (the dashboard's New agency). It builds like any version; until it is Done, a new
   * store is refused as for any version still building.
   */
  async function copyProduction(productId: string, source: Awaited<ReturnType<typeof productionSource>>) {
    const id = randomUUID();
    const domain = `${dnsSafeLabel(`${slug(source.name)}-${id.slice(0, 8)}`, 'v')}.${config.versionsDomain}`;
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO versions (id, product_id, name, domain, wordpress_version, php_version, is_production, status)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
        [id, productId, source.name, domain, source.wordpress_version, source.php_version, Status.Pending],
      );
      await client.query(
        `INSERT INTO snapshots (product_id, version_id, name, group_name, source_snapshot_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
        [productId, id, source.snapshot_name, source.group_name, source.snapshot_id, Status.Pending],
      );
      await enqueue(boss, client, { type: 'version.create', versionId: id, source: { snapshotId: source.snapshot_id } });
    });
    return id;
  }

  return { list, create, remove, setProduction, productionSource, copyProduction };
}

export function versionRoutes(deps: Deps) {
  const versions = versionService(deps);
  const app = new Hono<AppEnv>();

  app.get('/', async (c) =>
    c.json(await versions.list(c.get('productId'), { versionId: uuidQuery(c, 'versionId'), versionName: c.req.query('versionName') || undefined })),
  );

  app.post('/', async (c) => c.json(await versions.create(c.get('productId'), await readJson(c))));

  app.delete('/', async (c) => {
    await versions.remove(c.get('productId'), requiredUuidQuery(c, 'versionId'));
    return c.body(null, 200);
  });

  app.put('/production', async (c) => {
    const body = validateBody<{ versionId: string }>('ProductionVersionParams', await readJson(c));
    return c.json(await versions.setProduction(c.get('productId'), body.versionId));
  });

  return app;
}

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { withTransaction } from '../db.ts';
import { badRequest } from '../errors.ts';
import { booleanQuery, compact, readJson, requiredUuidQuery, uuidQuery } from '../http.ts';
import { validateBody } from '../openapi.ts';
import { enqueue } from '../queue.ts';

interface CreateBaseSnapshotParams {
  name: string;
  comment: string;
  isTenantSnapshot?: boolean;
  groupName?: string;
  showInConsole?: boolean;
}

const NAME = /^[A-Za-z0-9 -]{5,50}$/;

/**
 * Base snapshots (templates). Phase 2 operations that product keys may use (contract draft.5):
 * a product's templates belong to it alone, and createVersion copies them into versions.
 */
export function baseSnapshotRoutes({ pool, boss, provisioner }: Deps) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    // onlyPartnerSpecific has no effect for product keys; it is still validated.
    booleanQuery(c, 'onlyPartnerSpecific');
    const { rows } = await pool.query(
      `SELECT * FROM base_snapshots
        WHERE product_id = $1 AND ($2::uuid IS NULL OR id = $2) AND ($3::text IS NULL OR name = $3) AND ($4::text IS NULL OR group_name = $4)
        ORDER BY date_created`,
      [c.get('productId'), uuidQuery(c, 'baseSnapshotId') ?? null, c.req.query('name') || null, c.req.query('groupName') || null],
    );
    return c.json(
      rows.map((b) =>
        compact({
          id: b.id,
          name: b.name,
          comment: b.comment,
          uri: b.uri,
          isDefault: false,
          isTenantSnapshot: b.is_tenant_snapshot,
          groupName: b.group_name,
          showAsBaseSnapshot: b.show_in_console,
        }),
      ),
    );
  });

  app.post('/', async (c) => {
    const body = validateBody<CreateBaseSnapshotParams>('CreateBaseSnapshotParams', await readJson(c));
    if (!NAME.test(body.name)) throw badRequest('name must be 5 to 50 characters: letters, digits, spaces and dashes');
    if (!body.comment.trim()) throw badRequest('comment is required');
    const groupName = body.groupName?.trim() || null;
    if (groupName && !body.isTenantSnapshot) throw badRequest('groupName can only be set on a tenant snapshot');

    const id = randomUUID();
    const { uploadUrl, uri } = await provisioner.createBaseSnapshotUpload({ baseSnapshotId: id });
    await pool.query(
      `INSERT INTO base_snapshots (id, product_id, name, comment, is_tenant_snapshot, group_name, show_in_console, uri)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, c.get('productId'), body.name, body.comment, body.isTenantSnapshot === true, groupName, body.showInConsole === true, uri],
    );
    return c.json({ id, name: body.name, comment: body.comment, showInConsole: body.showInConsole === true, uploadUrl });
  });

  // Versions keep their own copies, so deleting a template leaves them alone.
  app.delete('/', async (c) => {
    const id = requiredUuidQuery(c, 'id');
    await withTransaction(pool, async (client) => {
      const { rowCount } = await client.query('DELETE FROM base_snapshots WHERE id = $1 AND product_id = $2', [id, c.get('productId')]);
      if (!rowCount) throw badRequest(`Base snapshot ${id} not found`);
      await enqueue(boss, client, { type: 'basesnapshot.delete', baseSnapshotId: id });
    });
    return c.json({ baseSnapshotId: id });
  });

  return app;
}

import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { withTransaction } from '../db.ts';
import { badRequest } from '../errors.ts';
import { isUuid, readJson } from '../http.ts';
import { validateBody } from '../openapi.ts';
import { enqueue } from '../queue.ts';
import { Status, statusName } from '../status.ts';
import { findTenant } from '../tenants.ts';

/** Suspend, resume and backups (contract draft.3, tag TenantLifecycle). Mounted at /v1/tenants. */
export function lifecycleRoutes({ pool, boss }: Deps) {
  const app = new Hono<AppEnv>();

  async function liveTenant(c: Context<AppEnv>) {
    const tenant = await findTenant(pool, c);
    if (tenant.status === Status.Removing || tenant.status === Status.Failed) {
      throw badRequest(`Tenant ${tenant.external_id} is ${statusName(tenant.status)}`);
    }
    return tenant;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (tenant: any, backupId: string | null) => ({ tenantId: tenant.id, externalId: tenant.external_id, backupId });

  app.post('/suspend', async (c) => {
    const tenant = await liveTenant(c);
    const body = validateBody<{ takeBackup?: boolean }>('SuspendTenantParams', await readJson(c));
    // Idempotent: no second suspension and no second backup.
    if (tenant.is_suspended) return c.json(result(tenant, null));
    const backupId = body.takeBackup === false ? null : randomUUID();
    await withTransaction(pool, async (client) => {
      if (backupId) {
        await client.query(
          "INSERT INTO tenant_backups (id, product_id, tenant_id, external_id, reason) VALUES ($1, $2, $3, $4, 'suspend')",
          [backupId, tenant.product_id, tenant.id, tenant.external_id],
        );
      }
      await client.query(
        'UPDATE tenants SET is_suspended = true, date_suspended = now(), status = $2, date_changed = now() WHERE id = $1',
        [tenant.id, Status.Pending],
      );
      await enqueue(boss, client, { type: 'tenant.suspend', tenantId: tenant.id, backupId: backupId ?? undefined });
    });
    return c.json(result(tenant, backupId));
  });

  app.post('/resume', async (c) => {
    const tenant = await liveTenant(c);
    if (tenant.is_suspended) {
      await withTransaction(pool, async (client) => {
        await client.query(
          'UPDATE tenants SET is_suspended = false, date_suspended = NULL, status = $2, date_changed = now() WHERE id = $1',
          [tenant.id, Status.Pending],
        );
        await enqueue(boss, client, { type: 'tenant.resume', tenantId: tenant.id });
      });
    }
    return c.json(result(tenant, null));
  });

  // Also lists the backups of a deleted tenant, so it doesn't go through findTenant.
  app.get('/backups', async (c) => {
    const productId = c.get('productId');
    const tenantId = c.req.query('tenantId') || undefined;
    const externalId = c.req.query('externalId') || undefined;
    if (!tenantId && !externalId) throw badRequest('tenantId or externalId is required');
    const [column, value] = tenantId && isUuid(tenantId) ? ['tenant_id', tenantId] : ['external_id', (tenantId ?? externalId)!];
    const { rows } = await pool.query(
      `SELECT * FROM tenant_backups WHERE product_id = $1 AND ${column} = $2 ORDER BY date_created DESC, id`,
      [productId, value],
    );
    if (!rows.length) {
      const known = await pool.query(`SELECT 1 FROM tenants WHERE product_id = $1 AND ${column === 'tenant_id' ? 'id' : 'external_id'} = $2`, [productId, value]);
      if (!known.rowCount) throw badRequest(`Tenant ${value} not found`);
    }
    return c.json(
      rows.map((b) => ({
        id: b.id,
        tenantId: b.tenant_id,
        externalId: b.external_id,
        reason: b.reason,
        dateCreated: b.date_created.toISOString(),
        sizeBytes: b.size_bytes === null ? null : Number(b.size_bytes),
        statusCode: b.status,
        statusName: statusName(b.status),
      })),
    );
  });

  app.post('/backups', async (c) => {
    const tenant = await liveTenant(c);
    const backupId = randomUUID();
    await withTransaction(pool, async (client) => {
      await client.query(
        "INSERT INTO tenant_backups (id, product_id, tenant_id, external_id, reason) VALUES ($1, $2, $3, $4, 'manual')",
        [backupId, tenant.product_id, tenant.id, tenant.external_id],
      );
      await enqueue(boss, client, { type: 'tenant.backup', tenantId: tenant.id, backupId });
    });
    return c.json(result(tenant, backupId));
  });

  return app;
}

import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { withTransaction } from '../db.ts';
import { badRequest } from '../errors.ts';
import { isUuid, readJson } from '../http.ts';
import { validateBody } from '../openapi.ts';
import { DEFAULT_SIZE } from '../plans.ts';
import { enqueue } from '../queue.ts';
import { Status, statusName } from '../status.ts';
import { checkTenantCap, domainInUse, emailPacksBought, findTenant } from '../tenants.ts';

/** Suspend, resume, backups (contract draft.3, tag TenantLifecycle) and email packs. Mounted at /v1/tenants. */
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

  // Emails bought on top of the plan's monthly ones. `reference` (the shop's order) makes a repeat add nothing.
  app.post('/email-packs', async (c) => {
    const tenant = await liveTenant(c);
    const body = validateBody<{ emails: number; reference: string }>('EmailPackParams', await readJson(c));
    const emailPacks = await withTransaction(pool, async (client) => {
      // A repeat racing the first waits here for it to commit, then adds nothing.
      await client.query(
        `INSERT INTO tenant_email_packs (tenant_id, product_id, emails, reference) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, reference) DO NOTHING`,
        [tenant.id, tenant.product_id, body.emails, body.reference],
      );
      // The store keeps working while its total is sent, so its status doesn't change. A repeat adds nothing but
      // sends the total again, so the shop retrying a pack also repairs a send that failed.
      await enqueue(boss, client, { type: 'tenant.email-packs', tenantId: tenant.id });
      return emailPacksBought(client, tenant.id);
    });
    return c.json({ tenantId: tenant.id, externalId: tenant.external_id, emailPacks });
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

  app.post('/restore', async (c) => {
    const productId = c.get('productId');
    const body = validateBody<{ backupId?: string | null }>('RestoreTenantParams', await readJson(c));
    const tenantId = c.req.query('tenantId') || undefined;
    const externalId = c.req.query('externalId') || undefined;
    if (!tenantId && !externalId) throw badRequest('tenantId or externalId is required');
    const byId = tenantId && isUuid(tenantId);
    const value = (byId ? tenantId : (tenantId ?? externalId))!;

    // Kept backups of the deleted tenant, newest first.
    const { rows: kept } = await pool.query(
      `SELECT * FROM tenant_backups
        WHERE product_id = $1 AND ${byId ? 'tenant_id' : 'external_id'} = $2
          AND tenant_deleted_at IS NOT NULL AND tenant_record IS NOT NULL AND status = $3
        ORDER BY date_created DESC, id`,
      [productId, value, Status.Done],
    );
    const externalIdOf = kept[0]?.external_id ?? value;
    const live = await pool.query(
      `SELECT 1 FROM tenants WHERE product_id = $1 AND (external_id = $2 ${kept[0] ? 'OR id = $3' : ''})`,
      kept[0] ? [productId, externalIdOf, kept[0].tenant_id] : [productId, externalIdOf],
    );
    if (live.rowCount) throw badRequest(`Tenant ${externalIdOf} is not deleted`);
    const backup = body.backupId ? kept.find((b) => b.id === body.backupId) : kept[0];
    if (!backup) {
      throw badRequest(body.backupId ? `Backup ${body.backupId} is not a Done backup of tenant ${externalIdOf}` : `Tenant ${externalIdOf} has no backup to restore`);
    }

    const record = backup.tenant_record;
    for (const d of record.domains) {
      if (await domainInUse(pool, d.domainName)) throw badRequest(`Domain ${d.domainName} is now used by another store`);
    }
    // Back on its own version if that still exists, else on production.
    const { rows: versions } = await pool.query(
      `SELECT id FROM versions WHERE product_id = $1 AND status = $2 AND (id = $3 OR is_production) ORDER BY (id = $3) DESC LIMIT 1`,
      [productId, Status.Done, record.versionId],
    );
    if (!versions[0]) throw badRequest('There is no version to restore the tenant on');

    await withTransaction(pool, async (client) => {
      await checkTenantCap(client, productId);
      await client.query(
        `INSERT INTO tenants (id, product_id, external_id, name, version_id, snapshot_id, snapshot_name, snapshot_group_name, wp_options, php_constants, status, size, own_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          backup.tenant_id,
          productId,
          backup.external_id,
          record.name,
          versions[0].id,
          record.snapshotId,
          record.snapshotName,
          record.snapshotGroupName,
          backup.wp_options ?? {},
          backup.php_constants ?? {},
          Status.Pending,
          // Backups kept from before sizes have none: those stores were small.
          record.size ?? DEFAULT_SIZE,
          // A site moved in keeps its own plugins and themes after a restore too.
          record.ownCode === true,
        ],
      );
      for (const d of record.domains) {
        await client.query('INSERT INTO tenant_domains (tenant_id, domain_name, is_main, is_base) VALUES ($1, $2, $3, $4)', [
          backup.tenant_id,
          d.domainName,
          d.isMain,
          d.isBase,
        ]);
      }
      // The tenant exists again: its backups no longer count down to deletion.
      await client.query('UPDATE tenant_backups SET tenant_deleted_at = NULL WHERE tenant_id = $1', [backup.tenant_id]);
      await enqueue(boss, client, { type: 'tenant.restore', tenantId: backup.tenant_id, backupId: backup.id });
    });
    return c.json({ tenantId: backup.tenant_id, externalId: backup.external_id, backupId: backup.id });
  });

  return app;
}

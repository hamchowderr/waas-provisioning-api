import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { isUniqueViolation, withTransaction } from '../db.ts';
import { badRequest } from '../errors.ts';
import { compact, isUuid, readJson } from '../http.ts';
import { validateBody } from '../openapi.ts';
import type { PhpConstant } from '../provisioner/provisioner.ts';
import { enqueue } from '../queue.ts';
import { Status, statusName } from '../status.ts';
import { domainInUse, encodePhpConstants, findTenant, normalizeDomain, TENANT_SELECT, toTenant } from '../tenants.ts';

interface CreateTenantParams {
  name: string;
  versionId?: string;
  snapshotId?: string;
  groupName?: string;
  externalId?: string;
  customDomainName?: string;
  wordPressUserName?: string;
  wordPressUserRole?: string;
  wordPressUserEmail?: string;
  wordPressUserPassword?: string;
  tenantName?: string;
  tenantUserRole?: string;
  tenantEmail?: string;
  tenantPassword?: string;
  uploadCustomSnapshot?: boolean;
  wpOptions?: Record<string, string> | null;
  phpConstants?: Record<string, PhpConstant> | null;
}

interface UpdateTenantParams {
  wpOptions?: Record<string, string> | null;
  phpConstants?: Record<string, PhpConstant> | null;
}

const EXTERNAL_ID = /^[A-Za-z0-9-]+$/;

export function tenantRoutes({ config, pool, boss, secrets }: Deps) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const tenantId = c.req.query('tenantId') || undefined;
    const externalId = c.req.query('externalId') || undefined;
    // A tenantId that isn't a UUID is an external ID (storefront plugin 2.2.7).
    const byId = tenantId && isUuid(tenantId) ? tenantId : null;
    const byExternal = tenantId && !byId ? tenantId : (externalId ?? null);
    const { rows } = await pool.query(
      `${TENANT_SELECT} WHERE t.product_id = $1 AND ($2::uuid IS NULL OR t.id = $2) AND ($3::text IS NULL OR t.external_id = $3)
        ORDER BY t.date_created`,
      [c.get('productId'), byId, byExternal],
    );
    return c.json(rows.map(toTenant));
  });

  app.post('/', async (c) => {
    const productId = c.get('productId');
    const body = validateBody<CreateTenantParams>('CreateTenantParams', await readJson(c));
    if (!body.name.trim()) throw badRequest('name is required');
    if (body.uploadCustomSnapshot) throw badRequest('uploadCustomSnapshot is not supported yet');

    const id = randomUUID();
    // The storefront plugin never sends externalId; the tenant's id is a valid generated one.
    const externalId = body.externalId?.trim() || id;
    if (!EXTERNAL_ID.test(externalId)) throw badRequest('externalId can only contain letters, digits and -');
    const taken = await pool.query('SELECT 1 FROM tenants WHERE product_id = $1 AND external_id = $2', [productId, externalId]);
    if (taken.rowCount) throw badRequest(`externalId ${externalId} is already in use`);

    // Version: the one asked for, else production.
    const { rows: versions } = body.versionId
      ? await pool.query('SELECT * FROM versions WHERE product_id = $1 AND id = $2', [productId, body.versionId])
      : await pool.query('SELECT * FROM versions WHERE product_id = $1 AND is_production', [productId]);
    const version = versions[0];
    if (!version) throw badRequest(body.versionId ? `Version ${body.versionId} not found` : 'There is no production version');
    if (version.status !== Status.Done) throw badRequest(`Version ${version.id} is ${statusName(version.status)}, not Done`);

    // Snapshot: the one asked for, else the latest in groupName (on this version first), else the latest on this version.
    const { rows: snapshots } = body.snapshotId
      ? await pool.query('SELECT * FROM snapshots WHERE product_id = $1 AND id = $2 AND status = $3', [productId, body.snapshotId, Status.Done])
      : body.groupName
        ? await pool.query(
            `SELECT * FROM snapshots WHERE product_id = $1 AND group_name = $2 AND status = $3
              ORDER BY (version_id = $4) DESC, date_created DESC LIMIT 1`,
            [productId, body.groupName, Status.Done, version.id],
          )
        : await pool.query('SELECT * FROM snapshots WHERE version_id = $1 AND status = $2 ORDER BY date_created DESC LIMIT 1', [version.id, Status.Done]);
    const snapshot = snapshots[0];
    if (!snapshot) {
      throw badRequest(
        body.snapshotId ? `Snapshot ${body.snapshotId} not found or not ready` : body.groupName ? `No snapshot in group ${body.groupName}` : `Version ${version.id} has no snapshot`,
      );
    }

    const baseDomain = `t-${id.slice(0, 8)}.${config.storesDomain}`;
    const customDomain = body.customDomainName?.trim() ? normalizeDomain(body.customDomainName) : undefined;
    if (customDomain) {
      if (await domainInUse(pool, customDomain)) throw badRequest(`Domain ${customDomain} is already in use`);
    }

    const userName = body.wordPressUserName ?? body.tenantName;
    const userEmail = body.wordPressUserEmail ?? body.tenantEmail;
    const userRole = body.wordPressUserRole ?? body.tenantUserRole;
    const password = body.wordPressUserPassword ?? body.tenantPassword;
    if ((userName || userEmail) && !(userName && userEmail)) throw badRequest('wordPressUserName and wordPressUserEmail go together');

    // The checks above give the usual answer; these constraints settle two requests racing past them.
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO tenants (id, product_id, external_id, name, version_id, snapshot_id, snapshot_name, snapshot_group_name, wp_options, php_constants, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          productId,
          externalId,
          body.name,
          version.id,
          snapshot.id,
          snapshot.name,
          snapshot.group_name,
          body.wpOptions ?? {},
          encodePhpConstants(secrets, body.phpConstants ?? {}),
          Status.Pending,
        ],
      );
      await client.query('INSERT INTO tenant_domains (tenant_id, domain_name, is_base, is_main) VALUES ($1, $2, true, $3)', [id, baseDomain, !customDomain]);
      if (customDomain) {
        await client.query('INSERT INTO tenant_domains (tenant_id, domain_name, is_main) VALUES ($1, $2, true)', [id, customDomain]);
      }
      await enqueue(boss, client, {
        type: 'tenant.create',
        tenantId: id,
        user:
          userName && userEmail
            ? { name: userName, email: userEmail, role: userRole || 'administrator', encryptedPassword: password ? secrets.encrypt(password) : undefined }
            : undefined,
      });
    }).catch((err) => {
      if (isUniqueViolation(err, 'tenants_product_id_external_id_key')) throw badRequest(`externalId ${externalId} is already in use`);
      if (isUniqueViolation(err, 'tenant_domains_domain_name_key')) throw badRequest(`Domain ${customDomain} is already in use`);
      throw err;
    });

    // customDomain is left out, not null or "", when there is none.
    return c.json(compact({ id, externalId, baseDomain, customDomain }));
  });

  app.put('/', async (c) => {
    const tenant = await findTenant(pool, c);
    const body = validateBody<UpdateTenantParams>('UpdateTenantParams', await readJson(c));
    if (tenant.status === Status.Removing) throw badRequest(`Tenant ${tenant.external_id} is being removed`);
    if (tenant.status === Status.Failed) throw badRequest(`Tenant ${tenant.external_id} failed and cannot be updated`);
    const wpOptions = body.wpOptions ?? {};
    const phpConstants = body.phpConstants ?? {};
    if (Object.keys(wpOptions).length || Object.keys(phpConstants).length) {
      await withTransaction(pool, async (client) => {
        await client.query(
          `UPDATE tenants SET wp_options = wp_options || $2, php_constants = php_constants || $3, status = $4, date_changed = now() WHERE id = $1`,
          [tenant.id, wpOptions, encodePhpConstants(secrets, phpConstants), Status.Pending],
        );
        await enqueue(boss, client, { type: 'tenant.update', tenantId: tenant.id, wpOptions, phpConstantNames: Object.keys(phpConstants) });
      });
    }
    return c.json({ tenantId: tenant.id, externalId: tenant.external_id });
  });

  app.delete('/', async (c) => {
    const tenant = await findTenant(pool, c);
    if (tenant.status !== Status.Removing) {
      await withTransaction(pool, async (client) => {
        await client.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1', [tenant.id, Status.Removing]);
        await enqueue(boss, client, { type: 'tenant.delete', tenantId: tenant.id });
      });
    }
    return c.body(null, 200);
  });

  app.post('/version', async (c) => {
    const tenant = await findTenant(pool, c);
    const body = validateBody<{ targetVersionId: string }>('MoveVersionParams', await readJson(c));
    const { rows } = await pool.query('SELECT * FROM versions WHERE product_id = $1 AND id = $2', [c.get('productId'), body.targetVersionId]);
    const target = rows[0];
    if (!target) throw badRequest(`Version ${body.targetVersionId} not found`);
    if (target.status !== Status.Done) throw badRequest(`Version ${target.id} is ${statusName(target.status)}, not Done`);
    if (tenant.status === Status.Removing || tenant.status === Status.Failed) {
      throw badRequest(`Tenant ${tenant.external_id} is ${statusName(tenant.status)}`);
    }
    await withTransaction(pool, async (client) => {
      await client.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1', [tenant.id, Status.Pending]);
      await enqueue(boss, client, { type: 'tenant.move', tenantId: tenant.id, targetVersionId: target.id });
    });
    return c.json({ targetVersionId: target.id, tenantId: tenant.id, externalId: tenant.external_id });
  });

  return app;
}

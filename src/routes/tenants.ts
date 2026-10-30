import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { isUniqueViolation, withTransaction } from '../db.ts';
import { badRequest, conflict, HttpError } from '../errors.ts';
import { compact, isUuid, readJson } from '../http.ts';
import { validateBody } from '../openapi.ts';
import { DEFAULT_SIZE, type Size } from '../plans.ts';
import type { PhpConstant } from '../provisioner/provisioner.ts';
import { createImport, importCode, importDetail, renewImport } from '../imports.ts';
import { publicBase } from '../oauth.ts';
import { enqueue } from '../queue.ts';
import { Status, statusName } from '../status.ts';
import { checkTenantCap, deleteTenant, dnsSafeLabel, domainInUse, encodePhpConstants, findTenant, normalizeDomain, TENANT_SELECT, toTenant } from '../tenants.ts';

export interface CreateTenantParams {
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
  asZip?: boolean;
  wpOptions?: Record<string, string> | null;
  phpConstants?: Record<string, PhpConstant> | null;
  size?: Size;
  /** Email the owner that their website is ready, with a link to set their password. Off unless asked for. */
  notifyOwner?: boolean;
}

interface UpdateTenantParams {
  wpOptions?: Record<string, string> | null;
  phpConstants?: Record<string, PhpConstant> | null;
  size?: Size;
}

const EXTERNAL_ID = /^[A-Za-z0-9-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function tenantRoutes({ config, pool, boss, secrets, provisioner }: Deps) {
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
    const body = validateBody<CreateTenantParams>('CreateTenantParams', await readJson(c));
    return c.json(await createTenant({ config, pool, boss, secrets, provisioner }, c.get('productId'), body, publicBase(c, config.publicUrl)));
  });

  app.put('/', async (c) => {
    const tenant = await findTenant(pool, c);
    const body = validateBody<UpdateTenantParams>('UpdateTenantParams', await readJson(c));
    if (tenant.status === Status.Removing) throw badRequest(`Tenant ${tenant.external_id} is being removed`);
    if (tenant.status === Status.Failed) throw badRequest(`Tenant ${tenant.external_id} failed and cannot be updated`);
    const wpOptions = body.wpOptions ?? {};
    const phpConstants = body.phpConstants ?? {};
    // The size it already has is no change: no job, no restart.
    const size = body.size && body.size !== tenant.size ? body.size : undefined;
    if (Object.keys(wpOptions).length || Object.keys(phpConstants).length || size) {
      await withTransaction(pool, async (client) => {
        await client.query(
          `UPDATE tenants SET wp_options = wp_options || $2, php_constants = php_constants || $3, status = $4, size = COALESCE($5, size), date_changed = now()
            WHERE id = $1`,
          [tenant.id, wpOptions, encodePhpConstants(secrets, phpConstants), Status.Pending, size ?? null],
        );
        await enqueue(boss, client, { type: 'tenant.update', tenantId: tenant.id, wpOptions, phpConstantNames: Object.keys(phpConstants), ...(size && { size }) });
      });
    }
    return c.json({ tenantId: tenant.id, externalId: tenant.external_id });
  });

  app.delete('/', async (c) => {
    await deleteTenant(pool, boss, await findTenant(pool, c, { allowWaiting: true }));
    return c.body(null, 200);
  });

  // A new import code for a store waiting for its site (src/imports.ts). The one given before stops working.
  app.post('/import-code', async (c) => {
    const tenant = await findTenant(pool, c, { allowWaiting: true });
    const token = await renewImport(pool, tenant.id);
    if (!token) throw badRequest(`Tenant ${tenant.external_id} is not waiting for a site to be moved in`);
    return c.json({ tenantId: tenant.id, externalId: tenant.external_id, importCode: importCode(publicBase(c, config.publicUrl), token) });
  });

  // How a store's move in went (src/imports.ts), as the dashboard sees it: waiting, moving, done or failed, with
  // why it failed, what to check, and what's on the moved site (src/sitereport.ts).
  app.get('/import', async (c) => {
    const tenant = await findTenant(pool, c, { allowWaiting: true });
    const detail = await importDetail(pool, tenant.id);
    if (!detail) throw new HttpError(404, `Tenant ${tenant.external_id} was not moved in from another host`);
    const status = !detail.startedAt ? 'waiting' : tenant.status === Status.Done ? 'done' : tenant.status === Status.Failed ? 'failed' : 'moving';
    return c.json({
      tenantId: tenant.id,
      externalId: tenant.external_id,
      status,
      expiresAt: detail.expiresAt,
      startedAt: detail.startedAt,
      onHold: tenant.on_hold === true,
      ...(detail.reason && { reason: detail.reason }),
      warnings: detail.warnings,
      ...(detail.siteReport && { siteReport: detail.siteReport }),
    });
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

/**
 * The options a new store starts with: the ones asked for, plus its name as the site title and the owner's email as
 * its administration address when the call doesn't set them. The store template keeps a placeholder address
 * (admin@example.invalid) until one is set, and only a store with a real one gets its starter pages and opens on its
 * home page (templates/anypress-store/mu-plugins/anypress-patterns.php).
 */
function storeOptions(name: string, email: string | undefined, wpOptions: Record<string, string> | null | undefined): Record<string, string> {
  return {
    blogname: name.trim(),
    ...(email?.trim() ? { admin_email: email.trim().toLowerCase() } : {}),
    ...(wpOptions ?? {}),
  };
}

/**
 * Creates a store for a product: what POST /v1/tenants does, also used for the platform's own stores (hosted
 * storefronts, src/routes/admin.ts). Answers { id, externalId, baseDomain, customDomain? }.
 *
 * With uploadCustomSnapshot the store is a site moved in from another host (src/imports.ts): it is not built
 * yet, waits for its site and keeps the site's own plugins and themes. The answer adds the import code for the
 * AnyPress Export plugin and an upload link; `apiUrl` is this API's address the code points the plugin to.
 */
export async function createTenant(
  { config, pool, boss, secrets, provisioner }: Pick<Deps, 'config' | 'pool' | 'boss' | 'secrets'> & Partial<Pick<Deps, 'provisioner'>>,
  productId: string,
  body: CreateTenantParams,
  apiUrl?: string,
) {
  if (!body.name.trim()) throw badRequest('name is required');
  const imported = body.uploadCustomSnapshot === true;
  if (body.asZip && !imported) throw badRequest('asZip can only be used with uploadCustomSnapshot');
  if (imported && (body.snapshotId || body.groupName)) throw badRequest('Send either a snapshotId or groupName, or uploadCustomSnapshot: true');
  if (imported && (!apiUrl || !provisioner)) throw badRequest('uploadCustomSnapshot is not available here');

  const id = randomUUID();
  // The storefront plugin never sends externalId; the tenant's id is a valid generated one.
  const externalId = body.externalId?.trim() || id;
  if (!EXTERNAL_ID.test(externalId)) throw badRequest('externalId can only contain letters, digits and -');
  // A repeat of a create that already went through (a retry whose answer was lost) gets that store back.
  const existing = await existingTenant(productId, externalId, body);
  if (existing) return existing;

  // Version: the one asked for, else production.
  const { rows: versions } = body.versionId
    ? await pool.query('SELECT * FROM versions WHERE product_id = $1 AND id = $2', [productId, body.versionId])
    : await pool.query('SELECT * FROM versions WHERE product_id = $1 AND is_production', [productId]);
  const version = versions[0];
  if (!version) throw badRequest(body.versionId ? `Version ${body.versionId} not found` : 'There is no production version');
  if (version.status !== Status.Done) throw badRequest(`Version ${version.id} is ${statusName(version.status)}, not Done`);

  // Snapshot: the one asked for, else the latest in groupName (on this version first), else the latest on this version.
  // A site moved in has none.
  const { rows: snapshots } = imported
    ? { rows: [{ id: null, name: 'Moved in', group_name: null }] }
    : body.snapshotId
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

  const baseDomain = `${dnsSafeLabel(`t-${id.slice(0, 8)}`, 's')}.${config.storesDomain}`;
  const customDomain = body.customDomainName?.trim() ? normalizeDomain(body.customDomainName) : undefined;
  if (customDomain) {
    if (await domainInUse(pool, customDomain, config.platformDomain, config.brandDomain)) throw badRequest(`Domain ${customDomain} is already in use`);
  }

  const userName = body.wordPressUserName ?? body.tenantName;
  const userEmail = body.wordPressUserEmail ?? body.tenantEmail;
  const userRole = body.wordPressUserRole ?? body.tenantUserRole;
  const password = body.wordPressUserPassword ?? body.tenantPassword;
  // Every new store has an owner who can sign in; their email is also the store's own address, which its starter pages
  // wait for. A site moved in keeps its own users.
  if (!imported && !(userName?.trim() && userEmail?.trim())) throw badRequest("wordPressUserName and wordPressUserEmail are required: the store owner's login");
  if ((userName || userEmail) && !(userName && userEmail)) throw badRequest('wordPressUserName and wordPressUserEmail go together');
  if (userEmail && !EMAIL.test(userEmail.trim())) throw badRequest('wordPressUserEmail must be an email address');

  // The checks above give the usual answer; these constraints settle two requests racing past them.
  let token: string | undefined;
  const raced = await withTransaction(pool, async (client) => {
    await checkTenantCap(client, productId);
    await client.query(
      `INSERT INTO tenants (id, product_id, external_id, name, version_id, snapshot_id, snapshot_name, snapshot_group_name, wp_options, php_constants, status, size, own_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        productId,
        externalId,
        body.name,
        version.id,
        snapshot.id,
        snapshot.name,
        snapshot.group_name,
        // A site moved in keeps its own options: none from the create call are written over them, now or on a rollback.
        imported ? {} : storeOptions(body.name, userEmail, body.wpOptions),
        encodePhpConstants(secrets, body.phpConstants ?? {}),
        Status.Pending,
        body.size ?? DEFAULT_SIZE,
        imported,
      ],
    );
    await client.query('INSERT INTO tenant_domains (tenant_id, domain_name, is_base, is_main) VALUES ($1, $2, true, $3)', [id, baseDomain, !customDomain]);
    if (customDomain) {
      await client.query('INSERT INTO tenant_domains (tenant_id, domain_name, is_main) VALUES ($1, $2, true)', [id, customDomain]);
    }
    // A site moved in is built once its archive is uploaded and the move started (src/imports.ts).
    if (imported) {
      token = await createImport(client, id);
      return;
    }
    await enqueue(boss, client, {
      type: 'tenant.create',
      tenantId: id,
      user:
        userName && userEmail
          ? { name: userName, email: userEmail, role: userRole || 'administrator', encryptedPassword: password ? secrets.encrypt(password) : undefined }
          : undefined,
      ...(body.notifyOwner === true && { notifyOwner: true }),
    });
  }).then(
    () => null,
    async (err) => {
      // Two identical creates raced past the check above: the loser answers with the winner's store.
      if (isUniqueViolation(err, 'tenants_product_id_external_id_key')) {
        const winner = await existingTenant(productId, externalId, body);
        if (winner) return winner;
        throw conflict(`externalId ${externalId} is already in use`);
      }
      if (isUniqueViolation(err, 'tenant_domains_domain_name_key')) throw badRequest(`Domain ${customDomain} is already in use`);
      throw err;
    },
  );
  if (raced) return raced;

  // customDomain is left out, not null or "", when there is none.
  if (!token) return compact({ id, externalId, baseDomain, customDomain });
  const uploadUrl = await provisioner!.createImportUpload({ storeId: id, expiresInSeconds: 12 * 3600 });
  return compact({ id, externalId, baseDomain, customDomain, uploadUrl, importCode: importCode(apiUrl!, token) });

  /**
   * The store already created with this externalId, as POST answered for it, when the request asks for that same
   * store (same name, and the same domain, version, snapshot, group and size where they are given). Null when no store
   * has the externalId; 409 when one has it but the request asks for something else, or it is being removed.
   */
  async function existingTenant(productId: string, externalId: string, body: CreateTenantParams) {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.status, t.version_id, t.snapshot_id, t.snapshot_group_name, t.size,
         (SELECT d.domain_name FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_base) AS base_domain,
         COALESCE((SELECT array_agg(d.domain_name) FROM tenant_domains d WHERE d.tenant_id = t.id), '{}') AS domains
       FROM tenants t WHERE t.product_id = $1 AND t.external_id = $2`,
      [productId, externalId],
    );
    const t = rows[0];
    if (!t) return null;
    const customDomain = body.customDomainName?.trim() ? normalizeDomain(body.customDomainName) : undefined;
    const same =
      t.name === body.name &&
      (!customDomain || t.domains.includes(customDomain)) &&
      (!body.versionId || t.version_id === body.versionId) &&
      (!body.snapshotId || t.snapshot_id === body.snapshotId) &&
      (!body.groupName || t.snapshot_group_name === body.groupName) &&
      (!body.size || t.size === body.size);
    if (!same) throw conflict(`externalId ${externalId} is already in use by another store`);
    if (t.status === Status.Removing) throw conflict(`externalId ${externalId} belongs to a store that is being removed`);
    return compact({ id: t.id, externalId, baseDomain: t.base_domain, customDomain });
  }
}

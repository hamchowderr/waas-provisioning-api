import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { PgBoss } from 'pg-boss';
import type { AppEnv } from './app.ts';
import { withTransaction, type Client, type Pool } from './db.ts';
import { badRequest, conflict } from './errors.ts';
import { compact, isUuid } from './http.ts';
import type { PhpConstant } from './provisioner/provisioner.ts';
import { enqueue } from './queue.ts';
import type { Secrets } from './secrets.ts';
import { Status, statusName } from './status.ts';

/** How phpConstants are kept in tenants.php_constants: private values encrypted. */
export type StoredPhpConstants = Record<string, { value: string; isPrivate: boolean }>;

export function encodePhpConstants(secrets: Secrets, constants: Record<string, PhpConstant>): StoredPhpConstants {
  return Object.fromEntries(
    Object.entries(constants).map(([name, c]) => {
      const isPrivate = c.isPrivate === true;
      const value = c.value ?? '';
      return [name, { value: isPrivate ? secrets.encrypt(value) : value, isPrivate }];
    }),
  );
}

export function decodePhpConstants(secrets: Secrets, stored: StoredPhpConstants, names?: string[]): Record<string, PhpConstant> {
  return Object.fromEntries(
    Object.entries(stored)
      .filter(([name]) => !names || names.includes(name))
      .map(([name, c]) => [name, { value: c.isPrivate ? secrets.decrypt(c.value) : c.value, isPrivate: c.isPrivate }]),
  );
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * A bare hostname, lowercased, without a trailing dot. Throws 400 for anything else (a scheme,
 * path, port or space). The storefront plugin adds https:// itself.
 */
export function normalizeDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME.test(domain)) throw badRequest(`${input} is not a valid domain name (send a bare hostname)`);
  return domain;
}

/**
 * A generated DNS label (a store's t-<id8>, a version's slug) that never ends in "-<digits>".
 * sslip.io, where stores and versions live for now, reads an address out of such a name: it takes
 * the trailing digits together with the IP that follows, so v1-0-0.191.101.15.236.sslip.io resolves
 * to 0.191.101.15 and the site is unreachable (and gets no certificate). Only labels that would end
 * in -<digits> get "-<suffix>"; every other label, and so every existing domain, stays as it was.
 */
export function dnsSafeLabel(label: string, suffix: string): string {
  return /(^|-)\d+$/.test(label) ? `${label}-${suffix}` : label;
}

/**
 * Refuses a new tenant when the product is at its max_tenants, or its reseller at its own across all
 * its storefronts (NULL: no limit). Call inside the transaction that inserts the tenant: the product
 * (and reseller) row stays locked until it commits, so two requests can't both take the last place.
 */
export async function checkTenantCap(client: Client, productId: string): Promise<void> {
  const { rows } = await client.query<{ max_tenants: number | null; reseller_id: string | null }>(
    'SELECT max_tenants, reseller_id FROM products WHERE id = $1 FOR UPDATE',
    [productId],
  );
  const max = rows[0]?.max_tenants;
  if (max !== null && max !== undefined) {
    const { rows: count } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM tenants WHERE product_id = $1', [productId]);
    if (count[0]!.n >= max) {
      throw badRequest(`This storefront has reached its limit of ${max} store${max === 1 ? '' : 's'}; delete one or ask for a higher limit`);
    }
  }
  // A reseller's limit counts the stores of all its storefronts; its row is locked the same way.
  const resellerId = rows[0]?.reseller_id;
  if (!resellerId) return;
  const { rows: reseller } = await client.query<{ max_tenants: number | null }>('SELECT max_tenants FROM resellers WHERE id = $1 FOR UPDATE', [resellerId]);
  const total = reseller[0]?.max_tenants;
  if (total === null || total === undefined) return;
  const { rows: count } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM tenants t JOIN products p ON p.id = t.product_id WHERE p.reseller_id = $1',
    [resellerId],
  );
  if (count[0]!.n >= total) {
    throw badRequest(`This account has reached its limit of ${total} store${total === 1 ? '' : 's'}; delete one or ask for a higher limit`);
  }
}

/**
 * Names under the platform domain that stores never get: the platform's own sites and services,
 * now or later. A wildcard DNS record sends every other name to the store server.
 */
export const RESERVED_LABELS = new Set([
  'about', 'account', 'accounts', 'admin', 'api', 'app', 'assets', 'auth', 'billing', 'blog', 'cdn', 'dashboard',
  'dev', 'docs', 'email', 'ftp', 'help', 'imap', 'login', 'mail', 'mx', 'ns1', 'ns2', 'pop', 'portal', 'shop', 'smtp',
  'staging', 'static', 'status', 'store', 'stores', 'support', 'test', 'versions', 'webmail', 'www',
]);

/**
 * Whether a domain is the platform domain itself or a reserved name directly under it, or the brand
 * domain or any name under it.
 */
export function isReservedDomain(domain: string, platformDomain: string | undefined, brandDomain?: string): boolean {
  if (brandDomain && (domain === brandDomain || domain.endsWith(`.${brandDomain}`))) return true;
  if (!platformDomain) return false;
  if (domain === platformDomain) return true;
  if (!domain.endsWith(`.${platformDomain}`)) return false;
  const label = domain.slice(0, -platformDomain.length - 1);
  return RESERVED_LABELS.has(label);
}

/** Whether any store, version or seller's dashboard already answers on this domain, or the platform keeps it for itself. */
export async function domainInUse(pool: Pool, domain: string, platformDomain?: string, brandDomain?: string): Promise<boolean> {
  if (isReservedDomain(domain, platformDomain, brandDomain)) return true;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM tenant_domains WHERE domain_name = $1 UNION ALL SELECT 1 FROM versions WHERE domain = $1
     UNION ALL SELECT 1 FROM dashboard_domains WHERE domain = $1`,
    [domain],
  );
  return (rowCount ?? 0) > 0;
}

export const TENANT_SELECT = `
  SELECT t.*, v.name AS version_name,
    (SELECT d.domain_name FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_main) AS main_domain,
    COALESCE((SELECT array_agg(d.domain_name ORDER BY d.date_created) FROM tenant_domains d
               WHERE d.tenant_id = t.id AND NOT d.is_main), '{}') AS redirect_domains,
    EXISTS (SELECT 1 FROM tenant_imports i WHERE i.tenant_id = t.id AND i.started_at IS NULL) AS waiting_for_site
  FROM tenants t JOIN versions v ON v.id = t.version_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toTenant(row: any) {
  const tenant = compact({
    tenantId: row.id,
    id: row.id,
    externalId: row.external_id,
    name: row.name,
    versionId: row.version_id,
    versionName: row.version_name,
    basedOnSnapshotId: row.snapshot_id,
    snapshotName: row.snapshot_name,
    snapshotGroupName: row.snapshot_group_name,
    dateCreated: row.date_created.toISOString(),
    dateChanged: row.date_changed.toISOString(),
    domainName: row.main_domain,
    redirectDomains: row.redirect_domains,
    statusCode: row.status,
    statusName: statusName(row.status),
    size: row.size,
    // A site moved in from another host (src/imports.ts), and whether it still waits for its upload.
    keepsOwnCode: row.own_code || undefined,
    waitingForSite: row.waiting_for_site || undefined,
  });
  return { ...tenant, isSuspended: row.is_suspended, dateSuspended: row.date_suspended ? row.date_suspended.toISOString() : null };
}

/** The emails of every pack bought for the tenant. */
export async function emailPacksBought(db: Pool | Client, tenantId: string): Promise<number> {
  const { rows } = await db.query('SELECT COALESCE(SUM(emails), 0)::bigint AS total FROM tenant_email_packs WHERE tenant_id = $1', [tenantId]);
  return Number(rows[0].total);
}

/**
 * The tenant named by ?tenantId= or ?externalId=. A tenantId that isn't a UUID is looked up as an
 * external ID: release 2.2.7 of the storefront plugin sends the external ID as tenantId.
 */
export async function findTenant(pool: Pool, c: Context<AppEnv>, { allowWaiting = false } = {}) {
  const tenantId = c.req.query('tenantId') || undefined;
  const externalId = c.req.query('externalId') || undefined;
  let where: string;
  let value: string;
  if (tenantId && isUuid(tenantId)) [where, value] = ['t.id = $2', tenantId];
  else if (tenantId || externalId) [where, value] = ['t.external_id = $2', (tenantId ?? externalId)!];
  else throw badRequest('tenantId or externalId is required');
  const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.product_id = $1 AND ${where}`, [c.get('productId'), value]);
  if (!rows[0]) throw badRequest(`Tenant ${value} not found`);
  // A store waiting for its site to be moved in doesn't run yet: nothing can be changed on it but deleting it.
  if (rows[0].waiting_for_site && c.req.method !== 'GET' && !allowWaiting) {
    throw conflict(`Tenant ${rows[0].external_id} is waiting for its site to be moved in`);
  }
  return rows[0];
}

// Suspend, resume and delete, shared by the storefront API (/v1/tenants) and the dashboard (/admin/tenants/:id).
// Each takes the tenant row and leaves the checks of who may and in what state to the caller.
interface TenantRef {
  id: string;
  product_id: string;
  external_id: string;
  status: number;
  is_suspended: boolean;
}

/** Takes the store offline. Backs it up first unless takeBackup is false; a suspended store is left as it is. */
export async function suspendTenant(pool: Pool, boss: PgBoss, tenant: TenantRef, takeBackup = true): Promise<string | null> {
  // Idempotent: no second suspension and no second backup.
  if (tenant.is_suspended) return null;
  const backupId = takeBackup ? randomUUID() : null;
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
  return backupId;
}

/** Brings a suspended store back online; one that isn't suspended is left as it is. */
export async function resumeTenant(pool: Pool, boss: PgBoss, tenant: TenantRef): Promise<void> {
  if (!tenant.is_suspended) return;
  await withTransaction(pool, async (client) => {
    await client.query(
      'UPDATE tenants SET is_suspended = false, date_suspended = NULL, status = $2, date_changed = now() WHERE id = $1',
      [tenant.id, Status.Pending],
    );
    await enqueue(boss, client, { type: 'tenant.resume', tenantId: tenant.id });
  });
}

/** Removes the store; its backups are kept for the retention period. A store already being removed is left as it is. */
export async function deleteTenant(pool: Pool, boss: PgBoss, tenant: TenantRef): Promise<void> {
  if (tenant.status === Status.Removing) return;
  await withTransaction(pool, async (client) => {
    await client.query('UPDATE tenants SET status = $2, date_changed = now() WHERE id = $1', [tenant.id, Status.Removing]);
    await enqueue(boss, client, { type: 'tenant.delete', tenantId: tenant.id });
  });
}

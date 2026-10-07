import type { Context } from 'hono';
import type { AppEnv } from './app.ts';
import type { Pool } from './db.ts';
import { badRequest } from './errors.ts';
import { compact, isUuid } from './http.ts';
import type { PhpConstant } from './provisioner/provisioner.ts';
import type { Secrets } from './secrets.ts';
import { statusName } from './status.ts';

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

/** Whether any store or version already answers on this domain. */
export async function domainInUse(pool: Pool, domain: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM tenant_domains WHERE domain_name = $1 UNION ALL SELECT 1 FROM versions WHERE domain = $1',
    [domain],
  );
  return (rowCount ?? 0) > 0;
}

export const TENANT_SELECT = `
  SELECT t.*, v.name AS version_name,
    (SELECT d.domain_name FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_main) AS main_domain,
    COALESCE((SELECT array_agg(d.domain_name ORDER BY d.date_created) FROM tenant_domains d
               WHERE d.tenant_id = t.id AND NOT d.is_main), '{}') AS redirect_domains
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
  });
  return { ...tenant, isSuspended: row.is_suspended, dateSuspended: row.date_suspended ? row.date_suspended.toISOString() : null };
}

/**
 * The tenant named by ?tenantId= or ?externalId=. A tenantId that isn't a UUID is looked up as an
 * external ID: release 2.2.7 of the storefront plugin sends the external ID as tenantId.
 */
export async function findTenant(pool: Pool, c: Context<AppEnv>) {
  const tenantId = c.req.query('tenantId') || undefined;
  const externalId = c.req.query('externalId') || undefined;
  let where: string;
  let value: string;
  if (tenantId && isUuid(tenantId)) [where, value] = ['t.id = $2', tenantId];
  else if (tenantId || externalId) [where, value] = ['t.external_id = $2', (tenantId ?? externalId)!];
  else throw badRequest('tenantId or externalId is required');
  const { rows } = await pool.query(`${TENANT_SELECT} WHERE t.product_id = $1 AND ${where}`, [c.get('productId'), value]);
  if (!rows[0]) throw badRequest(`Tenant ${value} not found`);
  return rows[0];
}

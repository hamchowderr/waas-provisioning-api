import { Hono } from 'hono';
import { createInvitation, invitationUrl } from './accounts.ts';
import type { AppEnv, Deps } from './app.ts';
import { INVITATION_DAYS } from './auth.ts';
import { sendInvitation } from './authmail.ts';
import { badRequest, HttpError } from './errors.ts';
import { isUuid, readJson } from './http.ts';
import { DEFAULT_SIZE, SIZES, type Size } from './plans.ts';
import type { JobData, JobHandlers } from './queue.ts';
import { createTenant } from './routes/tenants.ts';
import { versionService } from './routes/versions.ts';
import { Status } from './status.ts';

/**
 * Clients (docs/clients.md): the platform admin's one-step setup for someone they give a site to,
 * such as a client on a retainer. POST /admin/clients makes the client's own storefront, started from
 * another storefront's production version and template (by default the one with the most stores).
 * Once that version has built, the client's site is made and the client is emailed an invitation to
 * the storefront as its owner. Nothing else is needed: no API keys, no store page, no Team page.
 */

type ClientDeps = Pick<Deps, 'config' | 'pool' | 'boss' | 'secrets' | 'provisioner'>;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** The client's one site, so a second attempt to make it finds the first (createTenant's repeat check). */
const SITE_EXTERNAL_ID = 'client-site';

/** What the Clients page shows for each client. */
export type ClientStatus = 'setting_up' | 'invited' | 'active' | 'needs_attention';

/**
 * Makes the site of every client whose storefront's version has built and who has none yet, then
 * invites the client. Safe to call at any time and more than once: after a version job, and when the
 * Clients page is listed. A site that can't be made is recorded as site_error, not thrown.
 */
export async function makeWaitingSites(deps: ClientDeps, productId?: string) {
  const { pool } = deps;
  const { rows } = await pool.query(
    `SELECT c.product_id, c.site_name, c.site_size FROM clients c
       JOIN versions v ON v.product_id = c.product_id AND v.is_production AND v.status = $2
      WHERE c.tenant_id IS NULL AND c.site_error IS NULL AND ($1::uuid IS NULL OR c.product_id = $1)`,
    [productId ?? null, Status.Done],
  );
  for (const row of rows) {
    try {
      const site = (await createTenant(deps, row.product_id, {
        name: row.site_name,
        externalId: SITE_EXTERNAL_ID,
        size: row.site_size as Size,
      } as Parameters<typeof createTenant>[2])) as { id: string };
      await pool.query('UPDATE clients SET tenant_id = $2 WHERE product_id = $1', [row.product_id, site.id]);
    } catch (err) {
      await pool.query('UPDATE clients SET site_error = $2 WHERE product_id = $1', [row.product_id, (err as Error).message]);
      continue;
    }
    await invite(deps, row.product_id);
  }
}

/** Invites the client as their storefront's owner and emails them, once. */
async function invite(deps: ClientDeps, productId: string) {
  const { pool, config } = deps;
  const claimed = await pool.query(
    `UPDATE clients c SET invited_at = now() FROM products p
      WHERE c.product_id = $1 AND p.id = c.product_id AND c.invited_at IS NULL RETURNING c.email, p.name`,
    [productId],
  );
  const client = claimed.rows[0];
  if (!client || !config.auth) return;
  try {
    const { organization, invitation } = await createInvitation(deps, { id: productId, name: client.name }, client.email, 'owner', null);
    await sendInvitation(config.auth.mail!, client.email, {
      url: invitationUrl(deps, invitation.id)!,
      organization: organization.name,
      inviter: null,
      days: INVITATION_DAYS,
    });
    await pool.query('UPDATE clients SET invite_emailed = true WHERE product_id = $1', [productId]);
  } catch (err) {
    // The client still shows as invited; the storefront's Team page can send it again.
    console.error(`Client ${productId} invitation: ${(err as Error).message}`);
  }
}

/** After a version has built, makes the site of the client waiting for it. */
export function withClientSites<H extends JobHandlers>(handlers: H, deps: ClientDeps): H {
  return {
    ...handlers,
    async run(data: JobData) {
      await handlers.run(data);
      if (data.type !== 'version.create') return;
      try {
        const { rows } = await deps.pool.query('SELECT product_id FROM versions WHERE id = $1', [data.versionId]);
        if (rows[0]) await makeWaitingSites(deps, rows[0].product_id);
      } catch (err) {
        console.error(`clients: site after version ${data.versionId} not made: ${(err as Error).message}`);
      }
    },
  };
}

export function adminClientRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { pool } = deps;
  const versions = versionService(deps);

  async function list(productId?: string) {
    const { rows } = await pool.query(
      `SELECT c.*, p.name, v.status AS version_status, t.status AS site_status, d.domain_name,
              EXISTS (SELECT 1 FROM auth.organization o JOIN auth.member m ON m."organizationId" = o.id
                        JOIN auth."user" u ON u.id = m."userId"
                       WHERE o."productId" = c.product_id AND lower(u.email) = c.email) AS joined
         FROM clients c JOIN products p ON p.id = c.product_id
         LEFT JOIN versions v ON v.product_id = c.product_id AND v.is_production
         LEFT JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN tenant_domains d ON d.tenant_id = c.tenant_id AND d.is_main
        WHERE $1::uuid IS NULL OR c.product_id = $1
        ORDER BY c.date_created DESC, c.product_id`,
      [productId ?? null],
    );
    return rows.map(toClient);
  }

  app.get('/', async (c) => {
    await makeWaitingSites(deps);
    return c.json(await list());
  });

  // Adds a client: { name, email, size?, startFrom? }. Answers 201 with the client, Setting up.
  app.post('/', async (c) => {
    const body = ((await readJson(c)) ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) throw badRequest('name is required, at most 100 characters');
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) throw badRequest('email must be an email address');
    const size = body.size ?? DEFAULT_SIZE;
    if (typeof size !== 'string' || !(size in SIZES)) throw badRequest(`size must be one of ${Object.keys(SIZES).join(', ')}`);
    const startFrom = body.startFrom ?? (await busiestStorefront());
    if (typeof startFrom !== 'string' || !isUuid(startFrom)) throw badRequest('startFrom must be a storefront id');
    const source = await versions.productionSource(startFrom);

    // One site per client: the platform admin can raise it on the storefront if they want more.
    const { rows } = await pool.query<{ id: string }>('INSERT INTO products (name, max_tenants) VALUES ($1, 1) RETURNING id', [name]);
    const productId = rows[0]!.id;
    try {
      await pool.query('INSERT INTO clients (product_id, email, site_name, site_size) VALUES ($1, $2, $3, $4)', [productId, email, name, size]);
      await versions.copyProduction(productId, source);
    } catch (err) {
      await pool.query('DELETE FROM products WHERE id = $1', [productId]);
      throw err;
    }
    return c.json((await list(productId))[0], 201);
  });

  /** The storefront with the most stores that has a ready version and template: usually the shop. */
  async function busiestStorefront(): Promise<string> {
    const { rows } = await pool.query(
      `SELECT p.id FROM products p
        WHERE EXISTS (SELECT 1 FROM versions v JOIN snapshots s ON s.version_id = v.id AND s.status = $1
                       WHERE v.product_id = p.id AND v.is_production AND v.status = $1)
        ORDER BY (SELECT count(*) FROM tenants t WHERE t.product_id = p.id) DESC, p.created_at LIMIT 1`,
      [Status.Done],
    );
    if (!rows[0]) throw new HttpError(400, 'No storefront has a ready version and template to start from');
    return rows[0].id;
  }

  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toClient(row: any) {
  const status: ClientStatus =
    row.site_error || row.version_status === Status.Failed || row.site_status === Status.Failed
      ? 'needs_attention'
      : !row.tenant_id || row.site_status !== Status.Done
        ? 'setting_up'
        : row.joined
          ? 'active'
          : 'invited';
  return {
    productId: row.product_id,
    name: row.name,
    email: row.email,
    size: row.site_size,
    status,
    tenantId: row.tenant_id ?? null,
    siteDomain: row.domain_name ?? null,
    problem: row.site_error ?? (status === 'needs_attention' ? 'The site could not be built' : null),
    invitationEmailed: row.invite_emailed,
    dateCreated: new Date(row.date_created).toISOString(),
  };
}

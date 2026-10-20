import { Hono, type Context } from 'hono';
import { createInvitation, invitationUrl } from './accounts.ts';
import type { AppEnv, Deps } from './app.ts';
import { INVITATION_DAYS } from './auth.ts';
import {
  sendApplicationApproved,
  sendApplicationDeclined,
  sendApplicationNotice,
  sendApplicationReceived,
  type AuthMail,
} from './authmail.ts';
import { badRequest, conflict, HttpError } from './errors.ts';
import { isUuid, readJson } from './http.ts';
import { publicBase } from './oauth.ts';
import { createStorefront } from './storefronts.ts';
import { domainInUse } from './tenants.ts';

/**
 * Applications to sell websites (docs/accounts.md). Anyone may apply with POST /applications (the
 * marketing site's form); nothing is made until the platform admin approves it on the dashboard.
 * Approving makes the seller's product with a store limit, invites the applicant as its owner (they
 * sign in to the dashboard from the email), and builds its ready-made storefront when they asked
 * for one. Declining only emails them.
 */

export const EXPECTED_SITES = ['1-2', '3-9', '10-24', '25+'] as const;
/** The store limit a newly approved seller starts with; the admin raises it on the dashboard. */
export const DEFAULT_SELLER_STORES = 3;
/** Applications accepted from everyone together per hour, so a flood can't bury real ones. */
export const APPLICATIONS_PER_HOUR = 20;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type Status = 'pending' | 'approved' | 'declined';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toApplication(row: any) {
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    business: row.business as string,
    website: (row.website as string | null) ?? null,
    clients: row.clients as string,
    expectedSites: row.expected_sites as string,
    wantsStorefront: row.wants_storefront as boolean,
    storefrontSubdomain: (row.storefront_subdomain as string | null) ?? null,
    status: row.status as Status,
    productId: (row.product_id as string | null) ?? null,
    dateDecided: row.decided_at ? (row.decided_at as Date).toISOString() : null,
    dateCreated: (row.created_at as Date).toISOString(),
  };
}

function text(value: unknown, name: string, max: number, required = true): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  if (s.length > max) throw badRequest(`${name} must be at most ${max} characters`);
  return s;
}

function parseWebsite(value: unknown): string | null {
  const s = text(value, 'website', 300, false);
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes('.')) throw new Error();
    return url.toString();
  } catch {
    throw badRequest('website must be a web address');
  }
}

/** Emails without failing the request: the application or decision stands either way. */
async function tryMail(what: string, send: (mail: AuthMail) => Promise<void>, mail: AuthMail | undefined): Promise<boolean> {
  if (!mail) return false;
  try {
    await send(mail);
    return true;
  } catch (err) {
    console.error(`${what}: ${(err as Error).message}`);
    return false;
  }
}

/** POST /applications: the public form. No sign-in. */
export function publicApplicationRoutes(deps: Deps) {
  const { config, pool } = deps;
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const body = ((await readJson(c)) ?? {}) as Record<string, unknown>;
    const name = text(body.name, 'name', 100)!;
    const email = text(body.email, 'email', 254)!.toLowerCase();
    if (!EMAIL.test(email)) throw badRequest('email must be an email address');
    const business = text(body.business, 'business', 100)!;
    const website = parseWebsite(body.website);
    const clients = text(body.clients, 'clients', 1000)!;
    const expectedSites = body.expectedSites;
    if (typeof expectedSites !== 'string' || !(EXPECTED_SITES as readonly string[]).includes(expectedSites)) {
      throw badRequest(`expectedSites must be one of ${EXPECTED_SITES.join(', ')}`);
    }
    if (typeof body.wantsStorefront !== 'boolean') throw badRequest('wantsStorefront must be true or false');
    const wantsStorefront = body.wantsStorefront;
    let subdomain: string | null = null;
    if (wantsStorefront && body.storefrontSubdomain !== undefined && body.storefrontSubdomain !== null && body.storefrontSubdomain !== '') {
      subdomain = typeof body.storefrontSubdomain === 'string' ? body.storefrontSubdomain.trim().toLowerCase() : '';
      if (!LABEL.test(subdomain)) throw badRequest('storefrontSubdomain can only contain letters, digits and - (at most 63)');
      const domainBase = config.platformDomain ?? config.storesDomain;
      if (await domainInUse(pool, `${subdomain}.${domainBase}`, config.platformDomain, config.brandDomain)) {
        throw badRequest(`${subdomain}.${domainBase} is taken. Choose another address.`);
      }
    }

    const recent = await pool.query(`SELECT count(*)::int AS n FROM seller_applications WHERE created_at > now() - interval '1 hour'`);
    if (recent.rows[0].n >= APPLICATIONS_PER_HOUR) throw new HttpError(429, 'Too many applications right now. Please try again later.');

    let row;
    try {
      ({ rows: [row] } = await pool.query(
        `INSERT INTO seller_applications (name, email, business, website, clients, expected_sites, wants_storefront, storefront_subdomain)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [name, email, business, website, clients, expectedSites, wantsStorefront, subdomain],
      ));
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'seller_applications_pending_email_idx') {
        throw conflict('An application from this email address is already waiting for review');
      }
      throw err;
    }
    const application = toApplication(row);

    const mail = config.auth?.mail;
    await tryMail(`Application ${application.id} receipt`, (m) => sendApplicationReceived(m, email, { name, business }), mail);
    const reviewUrl = config.auth ? `${config.auth.url}/applications/${application.id}` : null;
    for (const to of config.applicationNotify ?? []) {
      await tryMail(
        `Application ${application.id} notice`,
        (m) => sendApplicationNotice(m, to, { name, business, email, url: reviewUrl ?? application.id }),
        mail,
      );
    }
    return c.json({ id: application.id, status: application.status }, 201);
  });

  return app;
}

/** /admin/applications: the platform admin's review. Mounted inside the admin routes, admin only. */
export function adminApplicationRoutes(deps: Deps) {
  const { config, pool } = deps;
  const app = new Hono<AppEnv>();

  async function find(c: Context): Promise<ReturnType<typeof toApplication>> {
    const id = c.req.param('id')!;
    const { rows } = isUuid(id) ? await pool.query('SELECT * FROM seller_applications WHERE id = $1', [id]) : { rows: [] };
    if (!rows[0]) throw new HttpError(404, `Application ${id} not found`);
    return toApplication(rows[0]);
  }

  /** Marks a pending application decided; 409 when someone already decided it. */
  async function claim(id: string, status: Status) {
    const { rows } = await pool.query(
      `UPDATE seller_applications SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, status],
    );
    if (!rows[0]) throw conflict('This application was already decided');
    return toApplication(rows[0]);
  }

  // Newest first. status: pending, approved or declined; all of them without it.
  app.get('/', async (c) => {
    const status = c.req.query('status');
    if (status && !['pending', 'approved', 'declined'].includes(status)) throw badRequest('status must be pending, approved or declined');
    const { rows } = await pool.query(
      'SELECT * FROM seller_applications WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC, id LIMIT 200',
      [status || null],
    );
    return c.json(rows.map(toApplication));
  });

  app.get('/:id', async (c) => c.json(await find(c)));

  // Approves: a product named after the business with maxTenants stores (3 unless given), the
  // applicant invited as its owner and emailed, and their ready-made storefront when `storefront`
  // (default: what they asked for). A storefront that can't be built leaves the approval standing
  // and answers storefrontError, so the admin can build it from the product's keys page.
  app.post('/:id/approve', async (c) => {
    const pending = await find(c);
    if (pending.status !== 'pending') throw conflict('This application was already decided');
    if (!deps.auth) throw new HttpError(503, 'Sign-in is off: set AUTH_URL and AUTH_SECRET');
    const body = ((await readJson(c)) ?? {}) as { maxTenants?: unknown; storefront?: unknown };
    const max = body.maxTenants ?? DEFAULT_SELLER_STORES;
    if (max !== null && !(typeof max === 'number' && Number.isInteger(max) && max >= 0 && max <= 100000)) {
      throw badRequest('maxTenants must be a whole number, 0 or more, or null for no limit');
    }
    if (body.storefront !== undefined && typeof body.storefront !== 'boolean') throw badRequest('storefront must be true or false');
    const wantStorefront = body.storefront ?? pending.wantsStorefront;

    const application = await claim(pending.id, 'approved');
    let product: { id: string; name: string };
    let invitation: { id: string; expiresAt: Date };
    try {
      const { rows } = await pool.query<{ id: string; name: string }>(
        'INSERT INTO products (name, max_tenants) VALUES ($1, $2) RETURNING id, name',
        [application.business, max],
      );
      product = rows[0]!;
      try {
        ({ invitation } = await createInvitation(deps, product, application.email, 'owner', null));
      } catch (err) {
        await pool.query('DELETE FROM products WHERE id = $1', [product.id]);
        throw err;
      }
    } catch (err) {
      await pool.query(`UPDATE seller_applications SET status = 'pending', decided_at = NULL WHERE id = $1`, [application.id]);
      throw err;
    }
    await pool.query('UPDATE seller_applications SET product_id = $2 WHERE id = $1', [application.id, product.id]);

    let storefront = null;
    let storefrontError: string | null = null;
    if (wantStorefront) {
      try {
        storefront = await createStorefront(
          deps,
          product.id,
          { name: application.business, email: application.email, subdomain: application.storefrontSubdomain ?? undefined },
          publicBase(c, config.publicUrl),
        );
      } catch (err) {
        storefrontError = (err as Error).message;
      }
    }

    const url = invitationUrl(deps, invitation.id)!;
    const emailed = await tryMail(
      `Application ${application.id} approval`,
      (m) =>
        sendApplicationApproved(m, application.email, {
          name: application.name,
          business: application.business,
          url,
          days: INVITATION_DAYS,
          storefront: storefront?.domainName ?? null,
        }),
      config.auth?.mail,
    );
    return c.json({
      application: { ...application, productId: product.id },
      productId: product.id,
      invitation: { id: invitation.id, acceptUrl: url, expiresAt: invitation.expiresAt.toISOString(), emailed },
      storefront,
      storefrontError,
    });
  });

  // Declines and emails the applicant (when sign-in email is set up).
  app.post('/:id/decline', async (c) => {
    const pending = await find(c);
    const application = await claim(pending.id, 'declined');
    const emailed = await tryMail(
      `Application ${application.id} decline`,
      (m) => sendApplicationDeclined(m, application.email, { name: application.name, business: application.business }),
      config.auth?.mail,
    );
    return c.json({ application, emailed });
  });

  return app;
}

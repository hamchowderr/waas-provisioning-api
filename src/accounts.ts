import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppEnv, Deps } from './app.ts';
import { INVITATION_DAYS, ORG_ROLES, type OrgRole } from './auth.ts';
import { sendInvitation } from './authmail.ts';
import { withTransaction } from './db.ts';
import { badRequest, conflict, HttpError } from './errors.ts';
import { isUuid, readJson, scopedProduct } from './http.ts';
import { adminRoutes } from './routes/admin.ts';

/**
 * Customer accounts (docs/accounts.md): people who sign in (src/auth.ts) and belong to a product's
 * organization. A signed-in person reaches /v1 as that product, the way its API key does, and
 * /account: the admin API's routes narrowed to that product, for the dashboard. Owners and admins
 * may make changes; members may only look.
 */

export interface Membership {
  organizationId: string;
  organizationName: string;
  productId: string;
  productName: string;
  role: OrgRole;
}

export interface SessionCaller {
  /** githubLogin: set when they signed up with GitHub. */
  user: { id: string; name: string; email: string; emailVerified: boolean; image: string | null; githubLogin: string | null };
  memberships: Membership[];
  /** The organization the session acts for: the one picked in the session, or the only one. */
  active: Membership | null;
}

/** Marks a request whose session cookie the dashboard's server passes on (not a browser's). */
export const SESSION_HEADER = 'X-Session-Auth';

const READ_METHODS = new Set(['GET', 'HEAD']);

/** Owners and admins may make changes. Better Auth keeps several roles as a comma-separated list. */
const canChange = (role: string) => role.split(',').some((r) => r.trim() === 'owner' || r.trim() === 'admin');

/** The signed-in person behind a request's session cookie, or null when there is none. */
export async function sessionCaller(deps: Deps, headers: Headers): Promise<SessionCaller | null> {
  if (!deps.auth) return null;
  const session = await deps.auth.api.getSession({ headers });
  if (!session) return null;
  const { rows } = await deps.pool.query(
    `SELECT o.id, o.name, o."productId" AS product_id, p.name AS product_name, m.role
       FROM auth.member m JOIN auth.organization o ON o.id = m."organizationId" JOIN products p ON p.id = o."productId"
      WHERE m."userId" = $1 ORDER BY o.name, o.id`,
    [session.user.id],
  );
  const memberships: Membership[] = rows.map((r) => ({
    organizationId: r.id,
    organizationName: r.name,
    productId: r.product_id,
    productName: r.product_name,
    role: r.role,
  }));
  const activeId = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
  const active = memberships.find((m) => m.organizationId === activeId) ?? (memberships.length === 1 ? memberships[0]! : null);
  const { id, name, email, emailVerified, image } = session.user;
  const githubLogin = (session.user as { githubLogin?: string | null }).githubLogin ?? null;
  return { user: { id, name, email, emailVerified: emailVerified === true, image: image ?? null, githubLogin }, memberships, active };
}

const forbidden = (c: Context, message: string) => c.json({ statusCode: 403, message }, 403);

/**
 * Signs a request in with its session when it carries X-Session-Auth: 1, as the session's active
 * organization's product. Otherwise it passes the request on untouched, to the API key check.
 * Any failure is 403, like a wrong API key.
 */
export function sessionAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.env?.internalAuth || c.req.header(SESSION_HEADER) !== '1') return next();
    if (!deps.auth) return forbidden(c, 'Sign-in is off on this server');
    const caller = await sessionCaller(deps, c.req.raw.headers);
    if (!caller) return forbidden(c, 'Sign in first');
    if (!caller.active) return forbidden(c, caller.memberships.length ? 'Choose an organization first' : 'Your account is not part of an organization yet');
    if (!canChange(caller.active.role) && !READ_METHODS.has(c.req.method)) return forbidden(c, 'Members can only look. Ask an owner or admin to make this change.');
    c.set('productId', caller.active.productId);
    c.set('userId', caller.user.id);
    c.set('sessionCaller', caller);
    return next();
  };
}

/** GET /account, then the admin API's routes for the signed-in customer's product. Session only. */
export function accountRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  // Who is signed in and which organizations they belong to, before one is picked too.
  app.get('/', async (c) => {
    if (!deps.auth) return forbidden(c, 'Sign-in is off on this server');
    const caller = await sessionCaller(deps, c.req.raw.headers);
    if (!caller) return forbidden(c, 'Sign in first');
    return c.json(caller);
  });

  // Overview, stores, backups, jobs, request log, versions, templates, API keys and webhooks.
  app.route('/', adminRoutes(deps, { session: true }));

  return app;
}

// --- Organizations and invitations (/admin/products/:productId/..., and /account for its own) --

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (d: any) => (d ? new Date(d).toISOString() : null);

function parseRole(value: unknown, fallback: OrgRole = 'owner'): OrgRole {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !(ORG_ROLES as readonly string[]).includes(value)) throw badRequest(`role must be one of ${ORG_ROLES.join(', ')}`);
  return value as OrgRole;
}

function parseEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw badRequest('email must be an email address');
  return email;
}

/** The highest of a member's roles (Better Auth keeps several as a comma-separated list). */
function topRole(role: string): OrgRole {
  const roles = role.split(',').map((r) => r.trim());
  return roles.includes('owner') ? 'owner' : roles.includes('admin') ? 'admin' : 'member';
}

/**
 * Who may change what on a team, for a signed-in customer. The platform admin (admin token) may do
 * anything. Members only look (sessionAuth refuses their changes before they get here). Admins invite
 * and remove members and admins; only owners touch owners. Nobody removes themselves or changes their
 * own role, and the last owner stays, so a team can't lock itself out.
 */
function teamRules(c: Context) {
  const caller = c.get('sessionCaller') as SessionCaller | undefined;
  const actor = caller?.active ? topRole(caller.active.role) : null;
  const deny = (message: string) => new HttpError(403, message);
  return {
    caller,
    /** Throws unless the caller may invite, cancel an invitation for, or move someone to `role`. */
    mayGrant(role: string) {
      if (actor === 'admin' && topRole(role) === 'owner') throw deny('Only an owner can invite or change owners.');
    },
    /** Throws unless the caller may remove or change the role of this member. */
    mayChange(member: { userId: string; role: string }, owners: number) {
      if (!actor) return;
      if (caller!.user.id === member.userId) throw deny("You can't remove yourself or change your own role. Ask another owner.");
      const role = topRole(member.role);
      if (role === 'owner' && actor !== 'owner') throw deny('Only an owner can remove or change owners.');
      if (role === 'owner' && owners <= 1) throw deny('A team needs at least one owner.');
    },
  };
}

/**
 * Organizations for products: each product gets one, its first people are invited by the platform
 * admin, and then its owners and admins invite the rest. Invitations are emailed through toSend when
 * sign-in email is set up. Mounted inside /admin (admin token, every product) and /account (a
 * signed-in customer, their own product only, with teamRules).
 */
export function adminAccountRoutes(deps: Deps) {
  const { pool } = deps;
  const app = new Hono<AppEnv>();

  async function product(c: Context): Promise<{ id: string; name: string }> {
    const id = c.req.param('productId')!;
    const scope = scopedProduct(c);
    const { rows } = isUuid(id) && (!scope || scope === id) ? await pool.query('SELECT id, name FROM products WHERE id = $1', [id]) : { rows: [] };
    if (!rows[0]) throw new HttpError(404, `Product ${id} not found`);
    return rows[0];
  }

  /** A member of the product's organization, with how many owners it has. */
  async function findMember(productId: string, id: string) {
    const { rows } = isUuid(id)
      ? await pool.query(
          `SELECT m.id, m."userId" AS user_id, m.role,
                  (SELECT count(*)::int FROM auth.member o2 WHERE o2."organizationId" = m."organizationId" AND o2.role ~ '(^|,)\\s*owner\\s*(,|$)') AS owners
             FROM auth.member m JOIN auth.organization o ON o.id = m."organizationId" WHERE m.id = $1 AND o."productId" = $2`,
          [id, productId],
        )
      : { rows: [] };
    if (!rows[0]) throw new HttpError(404, `Member ${id} not found`);
    return { id: rows[0].id as string, userId: rows[0].user_id as string, role: rows[0].role as string, owners: rows[0].owners as number };
  }

  async function findOrganization(productId: string) {
    const { rows } = await pool.query('SELECT id, name, "createdAt" FROM auth.organization WHERE "productId" = $1', [productId]);
    return rows[0] as { id: string; name: string; createdAt: Date } | undefined;
  }

  /** The product's organization, made on first use with the product's name. */
  async function ensureOrganization(p: { id: string; name: string }, name?: string) {
    // The slug only needs to be unique; the product id is.
    const { rows } = await pool.query(
      `INSERT INTO auth.organization (name, slug, "createdAt", "productId") VALUES ($1, $2::text, now(), $2::uuid)
       ON CONFLICT ("productId") DO NOTHING RETURNING id, name, "createdAt"`,
      [name ?? p.name, p.id],
    );
    return { organization: rows[0] ?? (await findOrganization(p.id))!, created: rows.length > 0 };
  }

  const acceptUrl = (invitationId: string) => (deps.config.auth ? `${deps.config.auth.url}/invite/${invitationId}` : null);

  async function view(productId: string) {
    const organization = await findOrganization(productId);
    if (!organization) return { organization: null, members: [], invitations: [] };
    const [members, invitations] = await Promise.all([
      pool.query(
        `SELECT m.id, m.role, m."createdAt", u.id AS user_id, u.name, u.email FROM auth.member m JOIN auth."user" u ON u.id = m."userId"
          WHERE m."organizationId" = $1 ORDER BY m."createdAt", m.id`,
        [organization.id],
      ),
      pool.query(
        `SELECT id, email, role, status, "expiresAt", "createdAt" FROM auth.invitation
          WHERE "organizationId" = $1 AND status = 'pending' AND "expiresAt" > now() ORDER BY "createdAt" DESC, id`,
        [organization.id],
      ),
    ]);
    return {
      organization: { id: organization.id, name: organization.name, productId, dateCreated: iso(organization.createdAt) },
      members: members.rows.map((m) => ({ id: m.id, userId: m.user_id, name: m.name, email: m.email, role: m.role, dateCreated: iso(m.createdAt) })),
      invitations: invitations.rows.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: iso(i.expiresAt),
        dateCreated: iso(i.createdAt),
        acceptUrl: acceptUrl(i.id),
      })),
    };
  }

  app.get('/products/:productId/organization', async (c) => c.json(await view((await product(c)).id)));

  // Makes the product's organization, or renames it. name defaults to the product's name.
  app.put('/products/:productId/organization', async (c) => {
    const p = await product(c);
    const body = ((await readJson(c)) ?? {}) as { name?: unknown };
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100)) {
      throw badRequest('name must be 1 to 100 characters');
    }
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    const { organization, created } = await ensureOrganization(p, name);
    if (!created && name) await pool.query('UPDATE auth.organization SET name = $2 WHERE id = $1', [organization.id, name]);
    return c.json(await view(p.id), created ? 201 : 200);
  });

  // Invites someone by email (role owner unless given). They accept at acceptUrl after signing in
  // with that email address. A new invitation for the same address replaces a pending one.
  app.post('/products/:productId/invitations', async (c) => {
    if (!deps.auth) throw new HttpError(503, 'Sign-in is off: set AUTH_URL and AUTH_SECRET');
    const p = await product(c);
    const rules = teamRules(c);
    const body = ((await readJson(c)) ?? {}) as { email?: unknown; role?: unknown };
    const email = parseEmail(body.email);
    // The platform admin usually invites a storefront's first person, its owner; a team adds members.
    const role = parseRole(body.role, rules.caller ? 'member' : 'owner');
    rules.mayGrant(role);
    const { organization } = await ensureOrganization(p);
    const invitation = await withTransaction(pool, async (client) => {
      await client.query('SELECT 1 FROM auth.organization WHERE id = $1 FOR UPDATE', [organization.id]);
      const member = await client.query(
        'SELECT 1 FROM auth.member m JOIN auth."user" u ON u.id = m."userId" WHERE m."organizationId" = $1 AND lower(u.email) = $2',
        [organization.id, email],
      );
      if (member.rowCount) throw conflict(`${email} is already a member`);
      await client.query(
        `UPDATE auth.invitation SET status = 'canceled' WHERE "organizationId" = $1 AND lower(email) = $2 AND status = 'pending'`,
        [organization.id, email],
      );
      const { rows } = await client.query(
        `INSERT INTO auth.invitation ("organizationId", email, role, status, "expiresAt", "inviterId")
         VALUES ($1, $2, $3, 'pending', now() + make_interval(days => $4), $5) RETURNING id, email, role, "expiresAt", "createdAt"`,
        [organization.id, email, role, INVITATION_DAYS, rules.caller?.user.id ?? null],
      );
      return rows[0];
    });
    const url = acceptUrl(invitation.id)!;
    // The invitation stands even if the email fails; the dashboard shows the link to send by hand.
    let emailed = false;
    const mail = deps.config.auth?.mail;
    if (mail) {
      const inviter = rules.caller ? rules.caller.user.name || rules.caller.user.email : null;
      try {
        await sendInvitation(mail, email, { url, organization: organization.name, inviter, days: INVITATION_DAYS });
        emailed = true;
      } catch (err) {
        console.error(`Invitation ${invitation.id}: ${(err as Error).message}`);
      }
    }
    return c.json(
      { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: iso(invitation.expiresAt), dateCreated: iso(invitation.createdAt), acceptUrl: url, emailed },
      201,
    );
  });

  app.delete('/products/:productId/invitations/:id', async (c) => {
    const p = await product(c);
    const id = c.req.param('id');
    const rules = teamRules(c);
    if (rules.caller && isUuid(id)) {
      const { rows } = await pool.query('SELECT role FROM auth.invitation WHERE id = $1', [id]);
      if (rows[0]) rules.mayGrant(rows[0].role ?? 'member');
    }
    const { rowCount } = isUuid(id)
      ? await pool.query(
          `UPDATE auth.invitation i SET status = 'canceled' FROM auth.organization o
            WHERE i.id = $1 AND o.id = i."organizationId" AND o."productId" = $2 AND i.status = 'pending'`,
          [id, p.id],
        )
      : { rowCount: 0 };
    if (!rowCount) throw new HttpError(404, `Pending invitation ${id} not found`);
    return c.json(await view(p.id));
  });

  // Removes someone from the product's organization. Their account stays; it just can't reach this product.
  app.delete('/products/:productId/members/:id', async (c) => {
    const p = await product(c);
    const member = await findMember(p.id, c.req.param('id'));
    teamRules(c).mayChange(member, member.owners);
    await pool.query('DELETE FROM auth.member WHERE id = $1', [member.id]);
    return c.json(await view(p.id));
  });

  // Changes someone's role: owner, admin (may make changes) or member (may only look).
  app.patch('/products/:productId/members/:id', async (c) => {
    const p = await product(c);
    const body = ((await readJson(c)) ?? {}) as { role?: unknown };
    if (body.role === undefined) throw badRequest('role is required');
    const role = parseRole(body.role);
    const member = await findMember(p.id, c.req.param('id'));
    const rules = teamRules(c);
    rules.mayGrant(role);
    // Demoting the last owner would leave the team without one, even for the platform admin.
    if (topRole(member.role) === 'owner' && role !== 'owner' && member.owners <= 1) throw new HttpError(409, 'A team needs at least one owner.');
    rules.mayChange(member, member.owners + (role === 'owner' ? 1 : 0));
    await pool.query('UPDATE auth.member SET role = $2 WHERE id = $1', [member.id, role]);
    return c.json(await view(p.id));
  });

  return app;
}

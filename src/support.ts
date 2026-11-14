// Support tickets (docs/support.md): a store owner, seller or reseller asks for help from an AI app, the
// website assistant or the dashboard, and the API files it with whoever helps them.
//
// - A website owner whose store a reseller sells: the reseller's support address, by email, under the reseller's
//   brand (resellers look after their own clients). Without one, the platform's support desk.
// - Everyone else (owners of the platform's own stores, sellers, resellers): the platform's support desk, which is
//   Fluent Support on the storefront at SUPPORT_DESK_URL, reached through its AnyPress Host (anypress-host/v1/support).
//   The call is signed like a webhook with the secret that storefront's webhook endpoint already holds, so no new
//   secret is needed. When the desk isn't set up or doesn't answer, the ticket goes to the support address by email.
//
// The person is always the one signed in: a store's owner (by the email the store was made with) or a dashboard
// user. API keys alone don't say who is asking, so they can't open tickets.
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { ToSend, ToSendError } from 'tosend';
import type { AppEnv, Deps } from './app.ts';
import type { AuthMail } from './authmail.ts';
import { effectiveBrand } from './branding.ts';
import { badRequest, HttpError } from './errors.ts';
import { readJson } from './http.ts';
import { validateBody } from './openapi.ts';
import { statusName } from './status.ts';
import { TENANT_SELECT, findTenant } from './tenants.ts';
import { sign } from './webhooks.ts';

/** Seconds the desk has to answer. */
const DESK_TIMEOUT_MS = 15_000;
const MAX_TITLE = 200;
const MAX_CONTENT = 20_000;

interface Requester {
  email: string;
  name: string;
  /** A store's owner signed in with their website, or a person signed in to the dashboard. */
  kind: 'website-owner' | 'account';
  /** The store a website owner signed in with. */
  tenantId?: string;
}

interface DeskTicket {
  id: number;
  title: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
  messages?: { from: 'you' | 'support'; content: string; createdAt: string | null }[];
}

/** Where a new ticket went: the desk (with the ticket) or a support address by email. */
type Filed = { sentTo: 'desk'; ticket: DeskTicket } | { sentTo: 'email'; email: string; helper: string };

/** A store's owner email: its admin_email as the create set it (not the template's placeholder), else who was told it's ready. */
function ownerEmail(row: { wp_options?: Record<string, unknown> | null; owner_notified_to?: string | null }): string | null {
  const email = typeof row.wp_options?.admin_email === 'string' ? row.wp_options.admin_email.trim().toLowerCase() : '';
  if (email && !email.endsWith('.invalid')) return email;
  return row.owner_notified_to?.trim().toLowerCase() || null;
}

/** Who is asking, from the signed-in user. Throws when the caller is only an API key, or has no email to answer. */
async function requester(deps: Deps, c: Context<AppEnv>): Promise<Requester> {
  const storeTenantId = c.get('storeTenantId');
  if (storeTenantId) return websiteOwner(deps, storeTenantId);
  const userId = c.get('userId');
  if (!userId) throw badRequest('Support tickets need a signed-in person: connect the AI app by signing in, or use the dashboard');
  const { rows } = await deps.pool.query<{ email: string; name: string | null; storeTenantId: string | null }>(
    'SELECT email, name, "storeTenantId" FROM auth."user" WHERE id = $1',
    [userId],
  );
  const user = rows[0];
  if (!user) throw badRequest('Support tickets need a signed-in person');
  if (user.storeTenantId) return websiteOwner(deps, user.storeTenantId);
  return { email: user.email.toLowerCase(), name: user.name?.trim() || user.email, kind: 'account' };
}

/** A store's owner, by the email the store knows them by. */
async function websiteOwner(deps: Deps, tenantId: string): Promise<Requester> {
  const { rows } = await deps.pool.query('SELECT name, wp_options, owner_notified_to FROM tenants WHERE id = $1', [tenantId]);
  const email = rows[0] ? ownerEmail(rows[0]) : null;
  if (!email) throw badRequest('This website has no owner email on record, so a ticket could not be answered. Ask your website provider to add it');
  return { email, name: `${rows[0].name} owner`, kind: 'website-owner', tenantId };
}

/** The desk's route and signing secret: its storefront's webhook endpoint, which AnyPress Host registered. */
async function desk(deps: Deps): Promise<{ url: string; secret: string } | null> {
  const base = deps.config.support?.deskUrl;
  if (!base) return null;
  const { rows } = await deps.pool.query<{ url: string; secret: string }>(
    `SELECT url, secret FROM webhook_endpoints
      WHERE enabled AND url IN ($1, $2) ORDER BY date_created DESC LIMIT 1`,
    [`${base}/wp-json/anypress-host/v1/webhook`, `${base}/?rest_route=/anypress-host/v1/webhook`],
  );
  const row = rows[0];
  if (!row) return null;
  return { url: row.url.replace(/\/webhook$/, '/support'), secret: deps.secrets.decrypt(row.secret) };
}

type DeskAnswer = { status: number; body: any };

/** One signed call to the desk. Null when there is no desk; throws when it can't be reached. */
async function callDesk(deps: Deps, body: Record<string, unknown>): Promise<DeskAnswer | null> {
  const target = await desk(deps);
  if (!target) return null;
  const text = JSON.stringify(body);
  const id = `sup_${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await (deps.supportFetch ?? fetch)(target.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'AnyPress-Support/1.0',
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': sign(target.secret, id, timestamp, text),
    },
    body: text,
    signal: AbortSignal.timeout(DESK_TIMEOUT_MS),
  });
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    answer = null;
  }
  return { status: response.status, body: answer };
}

/** A desk answer for list, get, reply and close: its body, or the matching error. */
function deskResult(answer: DeskAnswer | null): any {
  if (!answer) throw new HttpError(503, 'The support desk is not set up on this server. Write to the support address instead');
  if (answer.status === 404) throw new HttpError(404, 'No such ticket');
  if (answer.status >= 400 && answer.status < 500 && answer.status !== 401) throw badRequest(answer.body?.message ?? 'The support desk refused that');
  if (answer.status < 200 || answer.status >= 300) throw new HttpError(502, 'The support desk did not answer. Try again in a minute');
  return answer.body;
}

/** What the store looks like, for whoever answers: so nobody has to ask which store or what's on it. */
async function context(deps: Deps, who: Requester, productId: string, tenant: any | null): Promise<string> {
  const { rows } = await deps.pool.query<{ name: string; reseller: string | null }>(
    'SELECT p.name, r.name AS reseller FROM products p LEFT JOIN resellers r ON r.id = p.reseller_id WHERE p.id = $1',
    [productId],
  );
  const lines = [
    `From: ${who.name} <${who.email}> (${who.kind === 'website-owner' ? 'website owner' : 'account'})`,
    `Storefront: ${rows[0]?.name ?? productId}${rows[0]?.reseller ? ` (reseller ${rows[0].reseller})` : ''}`,
  ];
  if (tenant) {
    lines.push(
      `Website: ${tenant.name}${tenant.main_domain ? `, https://${tenant.main_domain}/` : ''}`,
      `Store id: ${tenant.id} (${tenant.external_id}), version ${tenant.version_name}, ${tenant.is_suspended ? 'suspended' : statusName(tenant.status)}`,
    );
  }
  return lines.join('\n');
}

/** A ticket by email: to a reseller under its brand, or to the platform's support address. */
async function emailTicket(mail: AuthMail, to: string, who: Requester, title: string, content: string, about: string, brand: string) {
  const text = `${content}\n\n---\n${about}\n\nReply to this email to answer ${who.name}.`;
  const tosend = new ToSend({ apiKey: mail.key, timeout: 15_000, ...(mail.apiUrl && { baseUrl: mail.apiUrl }) });
  try {
    await tosend.send({
      from: { email: mail.plainFrom ?? mail.from, name: `${brand} support` },
      to: [{ email: to }],
      reply_to: { email: who.email, name: who.name },
      subject: `Support request: ${title}`,
      text,
    });
  } catch (err) {
    if (!(err instanceof ToSendError)) throw err;
    throw new HttpError(502, `The support request could not be emailed (${err.code})`);
  }
}

/** Files a new ticket where `who` gets help (see the top of this file). */
async function openTicket(
  deps: Deps,
  who: Requester,
  productId: string,
  tenant: any | null,
  title: string,
  content: string,
): Promise<Filed> {
  const about = await context(deps, who, productId, tenant);
  const mail = deps.config.auth?.mail;

  // A reseller's own client: the reseller first.
  if (who.kind === 'website-owner') {
    const { rows } = await deps.pool.query<{ reseller_id: string | null; brand_name: string | null; name: string | null }>(
      'SELECT p.reseller_id, r.brand_name, r.name FROM products p LEFT JOIN resellers r ON r.id = p.reseller_id WHERE p.id = $1',
      [productId],
    );
    if (rows[0]?.reseller_id) {
      const brand = await effectiveBrand(deps.pool, '', productId);
      const helper = brand?.name ?? rows[0].brand_name ?? rows[0].name ?? 'Your website provider';
      if (brand?.supportEmail && mail) {
        await emailTicket(mail, brand.supportEmail, who, title, content, about, helper);
        return { sentTo: 'email', email: brand.supportEmail, helper };
      }
    }
  }

  const body = `${content}\n\n---\n${about}`;
  try {
    const answer = await callDesk(deps, { action: 'open', customer: { email: who.email, name: who.name }, title, content: body });
    if (answer && answer.status === 201 && answer.body?.ticket) return { sentTo: 'desk', ticket: answer.body.ticket as DeskTicket };
    if (answer && answer.status >= 400 && answer.status < 500 && answer.status !== 401) {
      throw badRequest(answer.body?.message ?? 'The support desk refused the ticket');
    }
    if (answer) console.error(`support: the desk answered ${answer.status}; emailing the ticket instead`);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(`support: the desk could not be reached (${(error as Error).message}); emailing the ticket instead`);
  }

  // No desk, or it didn't answer: the platform's support address.
  if (!mail?.supportEmail) throw new HttpError(503, 'Support tickets are not set up on this server');
  await emailTicket(mail, mail.supportEmail, who, title, content, about, mail.brand);
  return { sentTo: 'email', email: mail.supportEmail, helper: mail.brand };
}

/** The store a ticket is about: the website owner's own, or the one the query names (optional). */
async function storeFor(deps: Deps, c: Context<AppEnv>, who: Requester): Promise<any | null> {
  if (who.tenantId) {
    const { rows } = await deps.pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [who.tenantId]);
    return rows[0] ?? null;
  }
  if (!c.req.query('tenantId') && !c.req.query('externalId')) return null;
  return findTenant(deps.pool, c, { allowWaiting: true });
}

const ticketId = (c: Context<AppEnv>) => {
  const id = Number(c.req.param('ticketId'));
  if (!Number.isInteger(id) || id <= 0) throw badRequest('ticketId must be a ticket number');
  return id;
};

/** /v1/support (OpenAPI tag Support). */
export function supportRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const customer = (who: Requester) => ({ email: who.email, name: who.name });

  app.get('/tickets', async (c) => {
    const who = await requester(deps, c);
    const answer = await callDesk(deps, { action: 'list', customer: customer(who) }).catch(() => {
      throw new HttpError(502, 'The support desk did not answer. Try again in a minute');
    });
    // No desk: nothing to list (tickets went by email).
    return c.json(answer ? (deskResult(answer).tickets ?? []) : []);
  });

  app.post('/tickets', async (c) => {
    const who = await requester(deps, c);
    const params = validateBody<{ title: string; content: string }>('CreateSupportTicketParams', await readJson(c));
    const title = params.title.trim().slice(0, MAX_TITLE);
    const content = params.content.trim().slice(0, MAX_CONTENT);
    if (!title || !content) throw badRequest('title and content must not be empty');
    const tenant = await storeFor(deps, c, who);
    return c.json(await openTicket(deps, who, c.get('productId'), tenant, title, content), 201);
  });

  const onTicket = (action: 'get' | 'reply' | 'close') => async (c: Context<AppEnv>) => {
    const who = await requester(deps, c);
    const id = ticketId(c);
    const extra: { content?: string } = action === 'reply' ? validateBody<{ content: string }>('SupportReplyParams', await readJson(c)) : {};
    if (extra.content !== undefined && !extra.content.trim()) throw badRequest('content must not be empty');
    const answer = await callDesk(deps, { action, customer: customer(who), ticketId: id, ...extra }).catch(() => {
      throw new HttpError(502, 'The support desk did not answer. Try again in a minute');
    });
    return c.json(deskResult(answer).ticket);
  };
  app.get('/tickets/:ticketId', onTicket('get'));
  app.post('/tickets/:ticketId/replies', onTicket('reply'));
  app.post('/tickets/:ticketId/close', onTicket('close'));

  return app;
}

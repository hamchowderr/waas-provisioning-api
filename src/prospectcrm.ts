// Sending prospect finder results into a seller's CRM (Sales Kit, waas-api-72b.11), so they can act on them there
// instead of downloading a CSV:
//
// - FluentCRM: the storefront's own (ready-made storefronts, src/storefronts.ts). Contacts are written on the store by
//   the storefront.crm-prospects job (Provisioner.addCrmProspects), tagged "Prospect" and "Prospect: <group>", with
//   a note of what the finder found. A new contact is "transactional": no newsletter or campaign reaches someone who
//   never signed up. FluentCRM needs an email, so businesses without one are left out.
// - HighLevel: the seller's own sub-account, through an Inbound Webhook workflow (the Sales Kit snapshot's). The API
//   posts each business to its address; the workflow makes the contact. HighLevel sends any email itself.
//
// Each business goes to each CRM once (prospect_crm); the finder shows which are already there.
import type { Pool } from './db.ts';
import { badRequest, HttpError } from './errors.ts';
import type { Secrets } from './secrets.ts';
import { Status } from './status.ts';

export type CrmTarget = 'fluentcrm' | 'highlevel';
const TARGETS: readonly CrmTarget[] = ['fluentcrm', 'highlevel'];
const NETWORKS = ['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok'] as const;

/** One business as the finder shows it, with what was found on its website. */
export interface CrmProspect {
  id: string;
  name: string;
  type: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  contactPage: string | null;
  address: string | null;
  mapsUrl: string | null;
  rating: number | null;
  reviews: number | null;
  hours: string[];
  socials: { network: (typeof NETWORKS)[number]; url: string }[];
}

/** What the store's FluentCRM is given for one business. */
export interface CrmContact extends CrmProspect {
  email: string;
  tags: string[];
}

export interface CrmSettings {
  fluentcrm: { available: boolean; reason: string | null };
  highlevel: { connected: boolean };
}

export interface CrmAddResult {
  fluentcrm: { queued: number; already: number; noEmail: number; unavailable: string | null };
  highlevel: { sent: number; already: number; failed: number; unavailable: string | null };
}

const MAX_PROSPECTS = 60;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const httpUrl = (v: unknown): string | null => {
  const s = text(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : null;
  } catch {
    return null;
  }
};
const num = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);

/** Reads the dashboard's request: the businesses, the customer group they were found for, and which CRMs. */
export function crmInput(body: unknown): { prospects: CrmProspect[]; group: string | null; targets: CrmTarget[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(b.prospects) ? b.prospects : [];
  if (!list.length) throw badRequest('Choose at least one business to add.');
  if (list.length > MAX_PROSPECTS) throw badRequest(`Add at most ${MAX_PROSPECTS} businesses at a time.`);
  const targets = (Array.isArray(b.targets) ? b.targets : []).filter((t): t is CrmTarget => TARGETS.includes(t as CrmTarget));
  if (!targets.length) throw badRequest('Choose FluentCRM, HighLevel or both.');
  const prospects = list.map((raw): CrmProspect => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const id = text(p.id, 300);
    const name = text(p.name, 200);
    if (!id || !name) throw badRequest('Each business needs its id and name.');
    const email = text(p.email, 254)?.toLowerCase() ?? null;
    return {
      id,
      name,
      type: text(p.type, 100),
      phone: text(p.phone, 40),
      email: email && EMAIL.test(email) ? email : null,
      website: httpUrl(p.website),
      contactPage: httpUrl(p.contactPage),
      address: text(p.address, 300),
      mapsUrl: httpUrl(p.mapsUrl),
      rating: num(p.rating, 5),
      reviews: num(p.reviews, 10_000_000),
      hours: (Array.isArray(p.hours) ? p.hours : []).map((h) => text(h, 100)).filter((h): h is string => Boolean(h)).slice(0, 7),
      socials: (Array.isArray(p.socials) ? p.socials : [])
        .map((s) => (s ?? {}) as Record<string, unknown>)
        .filter((s) => NETWORKS.includes(s.network as (typeof NETWORKS)[number]))
        .map((s) => ({ network: s.network as (typeof NETWORKS)[number], url: httpUrl(s.url) ?? '' }))
        .filter((s) => s.url)
        .slice(0, NETWORKS.length),
    };
  });
  const unique = [...new Map(prospects.map((p) => [p.id, p])).values()];
  return { prospects: unique, group: text(b.group, 80), targets: [...new Set(targets)] };
}

/** The tags a business gets: "Prospect", and "Prospect: <group>" when the seller searched for one. */
function prospectTags(group: string | null): string[] {
  return group ? ['Prospect', `Prospect: ${group}`] : ['Prospect'];
}

/**
 * A HighLevel Inbound Webhook address, as its workflow shows it:
 * https://services.leadconnectorhq.com/hooks/<location>/webhook-trigger/<id>. Only HighLevel's own hosts, so the API
 * never posts to an address a seller picked.
 */
export function highLevelWebhook(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw badRequest('Paste the webhook address from your HighLevel workflow (it starts with https://services.leadconnectorhq.com/hooks/).');
  }
  if (url.protocol !== 'https:' || !['services.leadconnectorhq.com', 'backend.leadconnectorhq.com'].includes(url.hostname) || !url.pathname.startsWith('/hooks/') || url.username || url.password || url.port) {
    throw badRequest('That isn\'t a HighLevel webhook address. Copy it from the "Inbound Webhook" trigger in your HighLevel workflow.');
  }
  return url.href;
}

async function storedWebhook(pool: Pool, secrets: Secrets, productId: string): Promise<string | null> {
  const { rows } = await pool.query<{ highlevel_webhook: string | null }>('SELECT highlevel_webhook FROM prospect_crm_settings WHERE product_id = $1', [productId]);
  return rows[0]?.highlevel_webhook ? secrets.decrypt(rows[0].highlevel_webhook) : null;
}

/** Saves (or, with null, removes) the storefront's HighLevel webhook. */
export async function setHighLevelWebhook(pool: Pool, secrets: Secrets, productId: string, value: unknown): Promise<void> {
  const url = value === null || value === '' ? null : highLevelWebhook(value);
  await pool.query(
    `INSERT INTO prospect_crm_settings (product_id, highlevel_webhook) VALUES ($1, $2)
     ON CONFLICT (product_id) DO UPDATE SET highlevel_webhook = EXCLUDED.highlevel_webhook, date_changed = now()`,
    [productId, url ? secrets.encrypt(url) : null],
  );
}

export type StorefrontLookup = (productId: string) => Promise<{ id: string; statusCode: number } | null>;

/** Why the storefront's FluentCRM can't take prospects, or null when it can. */
export async function fluentCrmUnavailable(storefront: StorefrontLookup, productId: string): Promise<{ tenantId: string | null; reason: string | null }> {
  const store = await storefront(productId);
  if (!store) return { tenantId: null, reason: 'FluentCRM is on ready-made AnyPress storefronts. This storefront runs on its own website.' };
  if (store.statusCode !== Status.Done) return { tenantId: null, reason: "Your storefront is still being set up. Try again when it's ready." };
  return { tenantId: store.id, reason: null };
}

export async function getCrmSettings(pool: Pool, secrets: Secrets, storefront: StorefrontLookup, productId: string): Promise<CrmSettings> {
  const { reason } = await fluentCrmUnavailable(storefront, productId);
  return { fluentcrm: { available: !reason, reason }, highlevel: { connected: Boolean(await storedWebhook(pool, secrets, productId)) } };
}

/** Which CRMs each of these businesses was sent to (or is waiting to go to), for the finder's "In CRM" marks. */
export async function crmMarks(pool: Pool, productId: string, placeIds: string[]): Promise<Record<string, CrmTarget[]>> {
  if (!placeIds.length) return {};
  const { rows } = await pool.query<{ place_id: string; target: CrmTarget }>(
    'SELECT place_id, target FROM prospect_crm WHERE product_id = $1 AND place_id = ANY($2) AND status <> $3 ORDER BY target',
    [productId, placeIds, Status.Failed],
  );
  const marks: Record<string, CrmTarget[]> = {};
  for (const r of rows) (marks[r.place_id] ??= []).push(r.target);
  return marks;
}

/** HighLevel's flat fields for one business, as the snapshot's workflow maps them. */
function highLevelBody(p: CrmProspect, tags: string[]) {
  const social = (n: string) => p.socials.find((s) => s.network === n)?.url ?? '';
  return {
    companyName: p.name,
    name: p.name,
    email: p.email ?? '',
    phone: p.phone ?? '',
    website: p.website ?? '',
    address: p.address ?? '',
    businessType: p.type ?? '',
    rating: p.rating ?? '',
    reviews: p.reviews ?? '',
    googleMaps: p.mapsUrl ?? '',
    contactPage: p.contactPage ?? '',
    facebook: social('facebook'),
    instagram: social('instagram'),
    linkedin: social('linkedin'),
    x: social('x'),
    youtube: social('youtube'),
    tiktok: social('tiktok'),
    hours: p.hours.join('\n'),
    tags: tags.join(','),
    source: 'Prospect finder',
    prospectId: p.id,
  };
}

async function inParallel<T>(items: T[], workers: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

export interface CrmDeps {
  pool: Pool;
  secrets: Secrets;
  storefront: StorefrontLookup;
  /** Queues the storefront.crm-prospects job for the store (inside the caller's transaction is not needed: rows wait). */
  queueFluentCrm: (tenantId: string, productId: string) => Promise<void>;
  fetchFn?: typeof fetch;
}

/** Sends the businesses to the CRMs asked for. HighLevel is posted now; FluentCRM is written by a job. */
export async function addProspectsToCrm(deps: CrmDeps, productId: string, input: ReturnType<typeof crmInput>): Promise<CrmAddResult> {
  const { pool } = deps;
  const tags = prospectTags(input.group);
  const result: CrmAddResult = {
    fluentcrm: { queued: 0, already: 0, noEmail: 0, unavailable: null },
    highlevel: { sent: 0, already: 0, failed: 0, unavailable: null },
  };
  const already = async (target: CrmTarget) =>
    new Set(
      (
        await pool.query<{ place_id: string }>('SELECT place_id FROM prospect_crm WHERE product_id = $1 AND target = $2 AND place_id = ANY($3) AND status <> $4', [
          productId,
          target,
          input.prospects.map((p) => p.id),
          Status.Failed,
        ])
      ).rows.map((r) => r.place_id),
    );

  if (input.targets.includes('fluentcrm')) {
    const { tenantId, reason } = await fluentCrmUnavailable(deps.storefront, productId);
    if (!tenantId) result.fluentcrm.unavailable = reason;
    else {
      const sent = await already('fluentcrm');
      for (const p of input.prospects) {
        if (sent.has(p.id)) result.fluentcrm.already++;
        else if (!p.email) result.fluentcrm.noEmail++;
        else {
          const contact: CrmContact = { ...p, email: p.email, tags };
          await pool.query(
            `INSERT INTO prospect_crm (product_id, place_id, target, status, contact) VALUES ($1, $2, 'fluentcrm', $3, $4)
             ON CONFLICT (product_id, place_id, target) DO UPDATE SET status = EXCLUDED.status, contact = EXCLUDED.contact, error = NULL, date_changed = now()`,
            [productId, p.id, Status.Pending, JSON.stringify(contact)],
          );
          result.fluentcrm.queued++;
        }
      }
      if (result.fluentcrm.queued) await deps.queueFluentCrm(tenantId, productId);
    }
  }

  if (input.targets.includes('highlevel')) {
    const webhook = await storedWebhook(pool, deps.secrets, productId);
    if (!webhook) result.highlevel.unavailable = 'Add your HighLevel webhook first.';
    else {
      const sent = await already('highlevel');
      const todo = input.prospects.filter((p) => !sent.has(p.id));
      result.highlevel.already = input.prospects.length - todo.length;
      const fetchFn = deps.fetchFn ?? fetch;
      await inParallel(todo, 5, async (p) => {
        let error: string | null = null;
        try {
          const res = await fetchFn(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(highLevelBody(p, tags)),
            signal: AbortSignal.timeout(10_000),
            redirect: 'error',
          });
          if (!res.ok) error = `HighLevel answered ${res.status}`;
        } catch (err) {
          error = `HighLevel didn't answer: ${(err as Error).message}`.slice(0, 300);
        }
        await pool.query(
          `INSERT INTO prospect_crm (product_id, place_id, target, status, error) VALUES ($1, $2, 'highlevel', $3, $4)
           ON CONFLICT (product_id, place_id, target) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, date_changed = now()`,
          [productId, p.id, error ? Status.Failed : Status.Done, error],
        );
        if (error) result.highlevel.failed++;
        else result.highlevel.sent++;
      });
      if (result.highlevel.failed) console.error(`Prospects to HighLevel for ${productId}: ${result.highlevel.failed} of ${todo.length} failed`);
    }
  }

  if (result.highlevel.failed && !result.highlevel.sent && !result.fluentcrm.queued) {
    throw new HttpError(502, "HighLevel didn't take them. Check the webhook address in your workflow, then try again.");
  }
  return result;
}

/** What Provisioner.addCrmProspects answers: the businesses (by id) it could not write, with why. */
export interface CrmWriteResult {
  added: number;
  updated: number;
  failed: Record<string, string>;
}

/**
 * The storefront.crm-prospects job: writes the storefront's waiting businesses into its FluentCRM, 50 at a time,
 * and records each. A store that can't be reached throws, so the job tries again and the rows keep waiting.
 */
export async function pushCrmProspects(
  pool: Pool,
  write: (contacts: CrmContact[]) => Promise<CrmWriteResult>,
  productId: string,
): Promise<void> {
  for (;;) {
    const { rows } = await pool.query<{ place_id: string; contact: CrmContact }>(
      `SELECT place_id, contact FROM prospect_crm WHERE product_id = $1 AND target = 'fluentcrm' AND status = $2 ORDER BY date_created, place_id LIMIT 50`,
      [productId, Status.Pending],
    );
    if (!rows.length) return;
    const { failed } = await write(rows.map((r) => r.contact));
    for (const r of rows) {
      const error = failed[r.contact.id] ?? null;
      await pool.query(
        `UPDATE prospect_crm SET status = $4, error = $5, contact = CASE WHEN $5::text IS NULL THEN NULL ELSE contact END, date_changed = now()
          WHERE product_id = $1 AND place_id = $2 AND target = $3`,
        [productId, r.place_id, 'fluentcrm', error ? Status.Failed : Status.Done, error],
      );
    }
    if (Object.keys(failed).length) console.error(`Prospects to FluentCRM for ${productId}: ${Object.keys(failed).length} of ${rows.length} failed`);
  }
}

/** When the job gives up: the waiting businesses are marked failed, so the seller can send them again. */
export async function failCrmProspects(pool: Pool, productId: string, error: unknown) {
  await pool.query(`UPDATE prospect_crm SET status = $3, error = $4, date_changed = now() WHERE product_id = $1 AND target = 'fluentcrm' AND status = $2`, [
    productId,
    Status.Pending,
    Status.Failed,
    (error instanceof Error ? error.message : String(error)).slice(0, 2000),
  ]);
}

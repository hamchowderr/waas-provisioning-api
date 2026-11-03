/**
 * Setup checklists (docs/setup-checklists.md): what each storefront and reseller has set up so far, every step
 * ticked from data the API already holds, so nobody ticks a box by hand. The dashboard shows a seller or reseller
 * their own list, and the platform admin everyone's progress and who is stuck.
 *
 * Two steps (plans on sale, payments on) need the storefront's WaaS Host to report them; until it does they are
 * listed as not reported yet, so they count against the total but say why.
 */
import type { Config } from './config.ts';
import type { Pool } from './db.ts';

export type StepState = 'done' | 'todo' | 'not-reported';

export interface SetupStep {
  key: string;
  label: string;
  state: StepState;
  /** When it was done, when the data says so. */
  doneAt: string | null;
  /** One plain line: what was found, or what to do. */
  detail: string;
}

export interface Checklist {
  steps: SetupStep[];
  done: number;
  total: number;
  /** The newest step done, or when the account was made: what "stuck" counts from. */
  lastProgressAt: string;
  /** No step done for this many days and not finished. */
  stuck: boolean;
  /** The first step to do, for a "next step" column; a step not reported yet only when nothing else is left. */
  next: string | null;
}

export interface StorefrontSetup extends Checklist {
  productId: string;
  name: string;
  resellerId: string | null;
  /** The shop's own address, as its WaaS Host last reported it. */
  shopSite: string | null;
}

export interface ResellerSetup extends Checklist {
  resellerId: string;
  name: string;
  storefronts: { ready: number; total: number };
}

export const STUCK_DAYS = 7;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function step(key: string, label: string, doneAt: Date | string | null | undefined | false, done: string, todo: string): SetupStep {
  const ok = doneAt !== false && doneAt !== null && doneAt !== undefined;
  return { key, label, state: ok ? 'done' : 'todo', doneAt: ok ? iso(doneAt as Date | string) : null, detail: ok ? done : todo };
}

function checklist(steps: SetupStep[], createdAt: Date | string, now = Date.now()): Checklist {
  const doneSteps = steps.filter((s) => s.state === 'done');
  const times = doneSteps.map((s) => (s.doneAt ? Date.parse(s.doneAt) : 0)).filter((t) => t > 0);
  const last = Math.max(Date.parse(new Date(createdAt).toISOString()), ...times);
  const done = doneSteps.length;
  return {
    steps,
    done,
    total: steps.length,
    lastProgressAt: new Date(last).toISOString(),
    stuck: done < steps.length && now - last > STUCK_DAYS * 86_400_000,
    // A step the shop hasn't reported can't be done here yet, so the next step is the first one that can.
    next: (steps.find((s) => s.state === 'todo') ?? steps.find((s) => s.state !== 'done'))?.label ?? null,
  };
}

/** Whether a shop address is the customer's own domain rather than one the platform gave it. */
export function isOwnDomain(site: string | null, config: Pick<Config, 'storesDomain' | 'platformDomain'>): boolean {
  if (!site) return false;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const given = [config.storesDomain, config.platformDomain, 'sslip.io', 'nip.io', 'localhost'].filter(Boolean) as string[];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return !given.some((d) => host === d || host.endsWith(`.${d}`));
}

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/**
 * The checklists of the given storefronts (null: every storefront but the platform's own ready-made storefront
 * product) and resellers (null: every reseller).
 */
export async function loadSetup(
  pool: Pool,
  config: Pick<Config, 'storesDomain' | 'platformDomain' | 'storefrontProductId'>,
  scope: { productIds: string[] | null; resellerIds: string[] | null },
): Promise<{ storefronts: StorefrontSetup[]; resellers: ResellerSetup[] }> {
  const { rows: products } = await pool.query(
    `SELECT p.id, p.name, p.reseller_id, p.created_at FROM products p
      WHERE ($1::uuid[] IS NULL OR p.id = ANY($1) OR p.reseller_id = ANY($2::uuid[]))
        AND ($3::uuid IS NULL OR p.id <> $3)
      ORDER BY p.created_at`,
    [scope.productIds, scope.resellerIds ?? [], config.storefrontProductId ?? null],
  );
  const ids = products.map((p) => p.id as string);
  const resellerIds = scope.resellerIds ?? [...new Set(products.map((p) => p.reseller_id as string | null).filter(Boolean))];

  const [apps, keys, prod, sites, brands, teams, selfBuilt, live] = await Promise.all([
    pool.query(`SELECT product_id, max(decided_at) AS at FROM seller_applications WHERE status = 'approved' AND product_id = ANY($1) GROUP BY product_id`, [ids]),
    pool.query(`SELECT product_id, max(last_used_at) AS at FROM api_keys WHERE product_id = ANY($1) AND last_used_at IS NOT NULL GROUP BY product_id`, [ids]),
    pool.query(`SELECT product_id, date_created AS at, name FROM versions WHERE is_production AND product_id = ANY($1)`, [ids]),
    pool.query(
      `SELECT DISTINCT ON (product_id) product_id, site, first_seen FROM plugin_installs
        WHERE product_id = ANY($1) AND slug LIKE '%waas-host' ORDER BY product_id, last_seen DESC`,
      [ids],
    ),
    pool.query(
      `SELECT b.product_id, b.reseller_id, b.updated_at AS at FROM dashboard_brands b
        WHERE (b.product_id = ANY($1) OR b.reseller_id = ANY($2::uuid[])) AND (b.name IS NOT NULL OR b.logo IS NOT NULL)`,
      [ids, resellerIds],
    ),
    // A team counts once someone besides its first member has joined: the storefront's own team, or its reseller's.
    pool.query(
      `SELECT o."productId" AS product_id, o."resellerId" AS reseller_id, (array_agg(m."createdAt" ORDER BY m."createdAt"))[2] AS at
         FROM auth."organization" o JOIN auth."member" m ON m."organizationId" = o.id
        WHERE o."productId" = ANY($1) OR o."resellerId" = ANY($2::uuid[])
        GROUP BY o.id HAVING count(*) > 1`,
      [ids, resellerIds],
    ),
    // A store made through the storefront's own key (its shop), not by hand in the dashboard.
    pool.query(
      `SELECT product_id, min(at) AS at FROM api_requests
        WHERE source = 'v1' AND method = 'POST' AND path = '/v1/tenants' AND status BETWEEN 200 AND 299
          AND api_key_id IS NOT NULL AND product_id = ANY($1)
        GROUP BY product_id`,
      [ids],
    ),
    pool.query(
      `SELECT product_id, min(date_live) AS at FROM tenants WHERE product_id = ANY($1) AND date_live IS NOT NULL GROUP BY product_id`,
      [ids],
    ),
  ]);
  const by = <T extends { product_id: string }>(rows: T[]) => new Map(rows.map((r) => [r.product_id, r]));
  const appBy = by(apps.rows), keyBy = by(keys.rows), prodBy = by(prod.rows), siteBy = by(sites.rows);
  const selfBy = by(selfBuilt.rows), liveBy = by(live.rows);
  const brandOf = (productId: string, resellerId: string | null) =>
    brands.rows.find((b) => b.product_id === productId) ?? (resellerId ? brands.rows.find((b) => b.reseller_id === resellerId) : undefined);
  const teamOf = (productId: string, resellerId: string | null) =>
    teams.rows.find((t) => t.product_id === productId) ?? (resellerId ? teams.rows.find((t) => t.reseller_id === resellerId) : undefined);

  const storefronts: StorefrontSetup[] = products.map((p) => {
    const site = siteBy.get(p.id)?.site ?? null;
    const own = isOwnDomain(site, config);
    const app = appBy.get(p.id);
    const key = keyBy.get(p.id);
    const production = prodBy.get(p.id);
    const brand = brandOf(p.id, p.reseller_id);
    const team = teamOf(p.id, p.reseller_id);
    const self = selfBy.get(p.id);
    const first = liveBy.get(p.id);
    const steps: SetupStep[] = [
      // A storefront the platform made itself never had an application: nothing to wait for.
      app
        ? step('approved', 'Application approved', app.at ?? p.created_at, `Approved ${day(app.at ?? p.created_at)}`, '')
        : step('approved', 'Application approved', p.created_at, 'Set up by AnyPress', ''),
      step('shop-connected', 'Shop connected', key?.at, key ? `WaaS Host last signed in ${day(key.at)}` : '', 'Install WaaS Host on your shop and add your API key'),
      step('starting-site', 'Starting site picked', production?.at, production ? `New stores start as ${production.name}` : '', 'Pick a production version on Templates'),
      { key: 'plans', label: 'Plans on sale', state: 'not-reported', doneAt: null, detail: 'Checked from your shop once WaaS Host reports it' },
      { key: 'payments', label: 'Payments on', state: 'not-reported', doneAt: null, detail: 'Checked from your shop once WaaS Host reports it' },
      step('own-domain', 'Own domain', own ? (siteBy.get(p.id)?.first_seen ?? null) : null, own ? `Your shop runs on ${new URL(/^https?:/i.test(site!) ? site! : `https://${site}`).hostname}` : '', site ? 'Your shop still runs on a test address' : 'Connect your shop first'),
      step('brand', 'Brand added', brand?.at, 'Name and logo set', 'Add your name, logo and colour on Branding'),
      step('team', 'Team invited', team?.at, 'Someone else has joined your team', 'Invite someone on Team'),
      step('self-building', 'Stores build themselves', self?.at, self ? `Your shop made a store on its own ${day(self.at)}` : '', 'Place a test order on your shop: a store should build on its own'),
      step('first-store', 'First store sold', first?.at, first ? `First store live ${day(first.at)}` : '', 'Ticks when your first customer\'s store is live'),
    ];
    return { productId: p.id, name: p.name, resellerId: p.reseller_id, shopSite: site, ...checklist(steps, p.created_at) };
  });

  const { rows: resellers } = await pool.query(
    `SELECT r.id, r.name, r.billing_email, r.created_at,
            (SELECT min(k.created_at) FROM api_keys k WHERE k.reseller_id = r.id) AS key_at
       FROM resellers r WHERE r.id = ANY($1::uuid[]) ORDER BY r.created_at`,
    [resellerIds],
  );
  const resellerSetups: ResellerSetup[] = resellers.map((r) => {
    const mine = storefronts.filter((s) => s.resellerId === r.id);
    const ready = mine.filter((s) => s.steps.every((st) => st.state === 'done')).length;
    const steps: SetupStep[] = [
      step('billing', 'Billing details', r.billing_email ? r.created_at : null, r.billing_email ? `Invoices go to ${r.billing_email}` : '', 'Add the email your invoices go to'),
      step('partner-key', 'Partner key made', r.key_at, 'For n8n, Zapier or your own code', 'Make a partner key for n8n, Zapier or your own code'),
      step(
        'storefronts-ready',
        'Every storefront set up',
        mine.length > 0 && ready === mine.length ? mine.map((s) => s.lastProgressAt).sort().at(-1)! : null,
        `${ready} of ${mine.length} storefronts ready`,
        `${ready} of ${mine.length} storefronts ready`,
      ),
    ];
    return { resellerId: r.id, name: r.name, storefronts: { ready, total: mine.length }, ...checklist(steps, r.created_at) };
  });

  return { storefronts, resellers: resellerSetups };
}

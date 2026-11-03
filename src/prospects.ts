// The Sales Kit's prospect finder: local businesses of one kind in one place, from Google Places Text Search, for
// a storefront's sellers to contact. Each storefront gets PROSPECT_SEARCHES_PER_MONTH searches a calendar month
// (UTC); a search that fails isn't counted. Off until GOOGLE_PLACES_API_KEY is set.
import type { Pool } from './db.ts';
import { HttpError } from './errors.ts';

export interface ProspectConfig {
  apiKey?: string;
  searchesPerMonth: number;
}

export interface ProspectUsage {
  /** False until the platform has a Google Places key: the finder says it isn't set up yet. */
  available: boolean;
  used: number;
  limit: number;
  /** When the count starts again: the first of next month, UTC. */
  resetsAt: string;
}

export interface Prospect {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviews: number | null;
  mapsUrl: string | null;
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

const FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.googleMapsUri',
  'places.businessStatus',
].join(',');

export function loadProspectConfig(env: NodeJS.ProcessEnv): ProspectConfig {
  const raw = env.PROSPECT_SEARCHES_PER_MONTH?.trim();
  const searchesPerMonth = raw ? Number(raw) : 100;
  if (!Number.isInteger(searchesPerMonth) || searchesPerMonth < 0) throw new Error('PROSPECT_SEARCHES_PER_MONTH must be a whole number');
  return { apiKey: env.GOOGLE_PLACES_API_KEY?.trim() || undefined, searchesPerMonth };
}

export async function prospectUsage(pool: Pool, config: ProspectConfig, productId: string, now = new Date()): Promise<ProspectUsage> {
  const { rows } = await pool.query<{ searches: number }>('SELECT searches FROM prospect_searches WHERE product_id = $1 AND month = $2', [productId, monthStart(now)]);
  return { available: Boolean(config.apiKey), used: rows[0]?.searches ?? 0, limit: config.searchesPerMonth, resetsAt: nextMonth(now) };
}

/** Reads what a seller typed: a kind of business and a place, each 2 to 100 characters. */
export function searchInput(body: unknown): { query: string; location: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const query = clean(b.query);
  const location = clean(b.location);
  if (query.length < 2 || query.length > 100) throw new HttpError(400, 'Say what kind of business to look for, such as "church".');
  if (location.length < 2 || location.length > 100) throw new HttpError(400, 'Say where to look, such as "Columbus, Ohio".');
  return { query, location };
}

/** One Text Search, counted against the storefront's month. Throws 503 when off, 429 when the month is spent. */
export async function searchProspects(
  pool: Pool,
  config: ProspectConfig,
  productId: string,
  input: { query: string; location: string },
  fetchFn: typeof fetch = fetch,
  now = new Date(),
): Promise<{ prospects: Prospect[]; usage: ProspectUsage }> {
  if (!config.apiKey) throw new HttpError(503, "The prospect finder isn't set up yet.");
  const before = await prospectUsage(pool, config, productId, now);
  if (before.used >= before.limit) throw new HttpError(429, `You've used this month's ${before.limit} searches. They start again on the 1st.`);

  let res: Response;
  try {
    res = await fetchFn('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.apiKey, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify({ textQuery: `${input.query} in ${input.location}`, pageSize: 20, languageCode: 'en' }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "Google didn't answer. Try again in a minute.");
  }
  if (!res.ok) throw new HttpError(502, "Google didn't answer. Try again in a minute.");
  const data = (await res.json()) as { places?: Array<Record<string, any>> };
  const prospects: Prospect[] = (data.places ?? [])
    .filter((p) => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .map((p) => ({
      id: String(p.id),
      name: String(p.displayName?.text ?? ''),
      address: p.formattedAddress ?? null,
      phone: p.nationalPhoneNumber ?? null,
      website: p.websiteUri ?? null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviews: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      mapsUrl: p.googleMapsUri ?? null,
    }))
    .filter((p) => p.name);

  await pool.query(
    `INSERT INTO prospect_searches (product_id, month, searches) VALUES ($1, $2, 1)
     ON CONFLICT (product_id, month) DO UPDATE SET searches = prospect_searches.searches + 1`,
    [productId, monthStart(now)],
  );
  return { prospects, usage: await prospectUsage(pool, config, productId, now) };
}

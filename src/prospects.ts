// The Sales Kit's prospect finder: local businesses of one kind in one place, from Google Places Text Search, for
// a storefront's sellers to contact, through Google's official Places SDK. Each storefront gets PROSPECT_SEARCHES_PER_MONTH searches a calendar month
// (UTC); a search that fails isn't counted. Off until GOOGLE_PLACES_API_KEY is set.
import type { PlacesClient } from '@googlemaps/places';
import type { Pool } from './db.ts';
import { HttpError } from './errors.ts';

export interface ProspectConfig {
  apiKey?: string;
  searchesPerMonth: number;
  /** Website reads (Firecrawl) per storefront and month, for the check and branded demo (src/prospectdemos.ts). */
  readsPerMonth: number;
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
  /** Google's name for the kind of business, such as "Church". */
  type: string | null;
  /** Opening hours, one line a day ("Monday: 9:00 AM – 5:00 PM"). */
  hours: string[] | null;
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
  'places.primaryTypeDisplayName',
  'places.regularOpeningHours.weekdayDescriptions',
  'nextPageToken',
].join(',');

export function loadProspectConfig(env: NodeJS.ProcessEnv): ProspectConfig {
  const raw = env.PROSPECT_SEARCHES_PER_MONTH?.trim();
  const searchesPerMonth = raw ? Number(raw) : 100;
  if (!Number.isInteger(searchesPerMonth) || searchesPerMonth < 0) throw new Error('PROSPECT_SEARCHES_PER_MONTH must be a whole number');
  const reads = env.PROSPECT_READS_PER_MONTH?.trim();
  const readsPerMonth = reads ? Number(reads) : 50;
  if (!Number.isInteger(readsPerMonth) || readsPerMonth < 0) throw new Error('PROSPECT_READS_PER_MONTH must be a whole number');
  return { apiKey: env.GOOGLE_PLACES_API_KEY?.trim() || undefined, searchesPerMonth, readsPerMonth };
}

export async function prospectUsage(pool: Pool, config: ProspectConfig, productId: string, now = new Date()): Promise<ProspectUsage> {
  const { rows } = await pool.query<{ searches: number }>('SELECT searches FROM prospect_searches WHERE product_id = $1 AND month = $2', [productId, monthStart(now)]);
  return { available: Boolean(config.apiKey), used: rows[0]?.searches ?? 0, limit: config.searchesPerMonth, resetsAt: nextMonth(now) };
}

/** Reads what a seller typed: a kind of business and a place, each 2 to 100 characters. */
export function searchInput(body: unknown): { query: string; location: string; pageToken?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const query = clean(b.query);
  const location = clean(b.location);
  if (query.length < 2 || query.length > 100) throw new HttpError(400, 'Say what kind of business to look for, such as "church".');
  if (location.length < 2 || location.length > 100) throw new HttpError(400, 'Say where to look, such as "Columbus, Ohio".');
  const pageToken = typeof b.pageToken === 'string' && b.pageToken ? b.pageToken.slice(0, 2000) : undefined;
  return pageToken ? { query, location, pageToken } : { query, location };
}

/** One Text Search, counted against the storefront's month. Throws 503 when off, 429 when the month is spent. */
/** One Text Search request, as Google's Places SDK takes it. */
export interface PlacesTextSearch {
  textQuery: string;
  pageSize: number;
  languageCode: string;
  pageToken?: string;
}

/** What a search answers: the fields asked for in FIELDS. */
export interface PlacesAnswer {
  places?: Array<Record<string, any>> | null;
  nextPageToken?: string | null;
}

/** Runs one Text Search; tests replace it. A failure throws Google's error, with its gRPC `code`. */
export type PlacesSearch = (apiKey: string, request: PlacesTextSearch, fieldMask: string) => Promise<PlacesAnswer>;

const placesClients = new Map<string, PlacesClient>();

/**
 * Google's official Places SDK (@googlemaps/places), over HTTPS with the API key (fallback mode: plain
 * REST calls, no gRPC connection kept open). One client per key, made on first use.
 */
const googlePlacesSearch: PlacesSearch = async (apiKey, request, fieldMask) => {
  let client = placesClients.get(apiKey);
  if (!client) {
    // Loaded on the first search, so the API doesn't carry Google's client library until it's used.
    const { PlacesClient } = await import('@googlemaps/places');
    client = new PlacesClient({ apiKey, fallback: true });
    placesClients.set(apiKey, client);
  }
  const [answer] = await client.searchText(request, { otherArgs: { headers: { 'X-Goog-FieldMask': fieldMask } }, timeout: 15_000 });
  return answer as PlacesAnswer;
};

/** gRPC status names for the codes Google answers a Places search with. */
const GRPC_STATUS: Record<number, string> = {
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  16: 'UNAUTHENTICATED',
};
/** A bad key, billing or a switched-off API: ours to fix, not worth the seller trying again. */
const OUR_PROBLEM = new Set([3, 7, 16]);

/** One Text Search, counted against the storefront's month. Throws 503 when off, 429 when the month is spent. */
export async function searchProspects(
  pool: Pool,
  config: ProspectConfig,
  productId: string,
  input: { query: string; location: string; pageToken?: string },
  search: PlacesSearch = googlePlacesSearch,
  now = new Date(),
): Promise<{ prospects: Prospect[]; nextPageToken: string | null; usage: ProspectUsage }> {
  if (!config.apiKey) throw new HttpError(503, "The prospect finder isn't set up yet.");
  const before = await prospectUsage(pool, config, productId, now);
  if (before.used >= before.limit) throw new HttpError(429, `You've used this month's ${before.limit} searches. They start again on the 1st.`);

  let data: PlacesAnswer;
  try {
    // A next page repeats the first page's request with Google's pageToken; each page counts as a search.
    data = await search(
      config.apiKey,
      { textQuery: `${input.query} in ${input.location}`, pageSize: 20, languageCode: 'en', ...(input.pageToken ? { pageToken: input.pageToken } : {}) },
      FIELDS,
    );
  } catch (err) {
    // Google's own reason (never the key) goes to the log, so a bad key, billing or a switched-off API can be told apart.
    const code = (err as { code?: unknown }).code;
    const status = typeof code === 'number' ? (GRPC_STATUS[code] ?? String(code)) : 'unreachable';
    console.error(`Prospect search: Google Places ${status}: ${(err as Error).message ?? ''}`.trim());
    if (typeof code === 'number' && OUR_PROBLEM.has(code)) {
      throw new HttpError(503, "The prospect finder isn't working right now. We've been told and are fixing it.");
    }
    throw new HttpError(502, "Google didn't answer. Try again in a minute.");
  }
  const prospects: Prospect[] = (data.places ?? [])
    .filter((p) => p.businessStatus !== 'CLOSED_PERMANENTLY' && p.businessStatus !== 3)
    .map((p) => ({
      id: String(p.id),
      name: String(p.displayName?.text ?? ''),
      address: p.formattedAddress ?? null,
      phone: p.nationalPhoneNumber ?? null,
      website: p.websiteUri ?? null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviews: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      mapsUrl: p.googleMapsUri ?? null,
      type: typeof p.primaryTypeDisplayName?.text === 'string' ? p.primaryTypeDisplayName.text : null,
      hours: Array.isArray(p.regularOpeningHours?.weekdayDescriptions) ? p.regularOpeningHours.weekdayDescriptions.map(String) : null,
    }))
    .filter((p) => p.name);

  await pool.query(
    `INSERT INTO prospect_searches (product_id, month, searches) VALUES ($1, $2, 1)
     ON CONFLICT (product_id, month) DO UPDATE SET searches = prospect_searches.searches + 1`,
    [productId, monthStart(now)],
  );
  return { prospects, nextPageToken: data.nextPageToken || null, usage: await prospectUsage(pool, config, productId, now) };
}

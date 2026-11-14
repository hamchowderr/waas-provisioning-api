// The Sales Kit's prospect finder (src/prospects.ts): Google Places searches for a storefront, counted against a
// monthly allowance, off until a key is set. Responses are validated against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAjv } from '../src/openapi.ts';
import { loadProspectConfig, type PlacesAnswer, type PlacesTextSearch } from '../src/prospects.ts';
import { setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');
const valid = (name: string, value: unknown) => {
  const validate = ajv.compile({ $ref: `admin#/components/schemas/${name}` });
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
};

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
const calls: Array<{ apiKey: string; request: PlacesTextSearch; fieldMask: string }> = [];
/** What the fake Places SDK answers, or the error it throws (Google's gRPC code). */
let answer: () => PlacesAnswer;
const googleError = (code: number, message: string) => Object.assign(new Error(message), { code });

const search = (body: unknown) => t.call('POST', `/admin/products/${t.productId}/prospects/search`, { auth: ADMIN, body });
const usage = async () => (await t.call('GET', `/admin/products/${t.productId}/prospects/usage`, { auth: ADMIN })).json() as Promise<any>;

beforeAll(async () => {
  t = await setup();
  t.deps.placesSearch = async (apiKey, request, fieldMask) => {
    calls.push({ apiKey, request, fieldMask });
    return answer();
  };
});
afterAll(async () => t?.close());

describe('the prospect finder', () => {
  it('says it is not set up without a key, and counts nothing', async () => {
    t.deps.config.prospects = { searchesPerMonth: 3, readsPerMonth: 50 };
    const before = await usage();
    valid('ProspectUsage', before);
    expect(before).toMatchObject({ available: false, used: 0, limit: 3 });
    expect((await search({ query: 'church', location: 'Columbus, Ohio' })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('searches Google Places and answers each business, leaving out closed ones', async () => {
    t.deps.config.prospects = { apiKey: 'test-key', searchesPerMonth: 3, readsPerMonth: 50 };
    answer = () => ({
        places: [
          { id: 'a', displayName: { text: 'Grace Church' }, formattedAddress: '1 Main St, Columbus, OH', nationalPhoneNumber: '(614) 555-0100', rating: 4.8, userRatingCount: 120, googleMapsUri: 'https://maps.google.com/?cid=1', primaryTypeDisplayName: { text: 'Church' }, regularOpeningHours: { weekdayDescriptions: ['Sunday: 9:00 AM – 1:00 PM'] } },
          { id: 'b', displayName: { text: 'Hope Chapel' }, websiteUri: 'https://hope.example', businessStatus: 'OPERATIONAL' },
          { id: 'c', displayName: { text: 'Old Mission' }, businessStatus: 'CLOSED_PERMANENTLY' },
        ],
        nextPageToken: 'page-2',
      });
    const res = await search({ query: '  church ', location: 'Columbus,   Ohio' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    for (const p of body.prospects) valid('Prospect', p);
    valid('ProspectUsage', body.usage);
    expect(body.prospects.map((p: any) => p.name)).toEqual(['Grace Church', 'Hope Chapel']);
    expect(body.prospects[0]).toMatchObject({ website: null, phone: '(614) 555-0100', rating: 4.8, reviews: 120, type: 'Church', hours: ['Sunday: 9:00 AM – 1:00 PM'] });
    expect(body.prospects[1]).toMatchObject({ type: null, hours: null });
    expect(body.nextPageToken).toBe('page-2');
    expect(body.usage).toMatchObject({ available: true, used: 1, limit: 3 });
    const sent = calls.at(-1)!;
    expect(sent.apiKey).toBe('test-key');
    expect(sent.request).toMatchObject({ textQuery: 'church in Columbus, Ohio', pageSize: 20 });
    expect(sent.request.pageToken).toBeUndefined();
    expect(sent.fieldMask).toContain('nextPageToken');

    // The next page sends Google's token and counts as another search.
    answer = () => ({ places: [{ id: 'd', displayName: { text: 'New Life' } }] });
    const next = (await (await search({ query: 'church', location: 'Columbus, Ohio', pageToken: 'page-2' })).json()) as any;
    expect(calls.at(-1)!.request).toMatchObject({ textQuery: 'church in Columbus, Ohio', pageToken: 'page-2' });
    expect(next.nextPageToken).toBeNull();
    expect(next.usage.used).toBe(2);
  });

  it("doesn't count a search Google fails", async () => {
    answer = () => {
      throw googleError(8, 'Quota exceeded');
    };
    expect((await search({ query: 'church', location: 'Dayton' })).status).toBe(502);
    expect((await usage()).used).toBe(2);
  });

  it("says the finder isn't working when Google refuses the key, and logs Google's reason", async () => {
    answer = () => {
      throw googleError(7, 'Places API (New) has not been used in project 1 before or it is disabled.');
    };
    const logged: string[] = [];
    const original = console.error;
    console.error = (msg: unknown) => void logged.push(String(msg));
    try {
      expect((await search({ query: 'church', location: 'Dayton' })).status).toBe(503);
    } finally {
      console.error = original;
    }
    expect(logged.join('\n')).toContain('PERMISSION_DENIED: Places API (New) has not been used');
    expect(logged.join('\n')).not.toContain('test-key');
  });

  it('refuses a search once the month is used up', async () => {
    answer = () => ({ places: [] });
    expect((await search({ query: 'church', location: 'Dayton' })).status).toBe(200);
    const spent = await search({ query: 'church', location: 'Dayton' });
    expect(spent.status).toBe(429);
    expect((await usage()).used).toBe(3);
  });

  it('asks for a kind of business and a place', async () => {
    expect((await search({ query: 'c', location: 'Dayton' })).status).toBe(400);
    expect((await search({ query: 'church' })).status).toBe(400);
  });

  it('reads the allowance from the environment', () => {
    expect(loadProspectConfig({})).toEqual({ apiKey: undefined, searchesPerMonth: 100, readsPerMonth: 50 });
    expect(loadProspectConfig({ GOOGLE_PLACES_API_KEY: ' k ', PROSPECT_SEARCHES_PER_MONTH: '50' })).toEqual({ apiKey: 'k', searchesPerMonth: 50, readsPerMonth: 50 });
    expect(() => loadProspectConfig({ PROSPECT_SEARCHES_PER_MONTH: 'lots' })).toThrow();
  });
});

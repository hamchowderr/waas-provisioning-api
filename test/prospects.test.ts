// The Sales Kit's prospect finder (src/prospects.ts): Google Places searches for a storefront, counted against a
// monthly allowance, off until a key is set. Responses are validated against openapi/admin/admin-api.yaml.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAjv } from '../src/openapi.ts';
import { loadProspectConfig } from '../src/prospects.ts';
import { setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');
const valid = (name: string, value: unknown) => {
  const validate = ajv.compile({ $ref: `admin#/components/schemas/${name}` });
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
};

let t: TestContext;
const ADMIN = `Bearer ${TEST_ADMIN_TOKEN}`;
const calls: Array<{ url: string; init: RequestInit }> = [];
let answer: () => Response;

const search = (body: unknown) => t.call('POST', `/admin/products/${t.productId}/prospects/search`, { auth: ADMIN, body });
const usage = async () => (await t.call('GET', `/admin/products/${t.productId}/prospects/usage`, { auth: ADMIN })).json() as Promise<any>;

beforeAll(async () => {
  t = await setup();
  t.deps.placesFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
});
afterAll(async () => t?.close());

describe('the prospect finder', () => {
  it('says it is not set up without a key, and counts nothing', async () => {
    t.deps.config.prospects = { searchesPerMonth: 2 };
    const before = await usage();
    valid('ProspectUsage', before);
    expect(before).toMatchObject({ available: false, used: 0, limit: 2 });
    expect((await search({ query: 'church', location: 'Columbus, Ohio' })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('searches Google Places and answers each business, leaving out closed ones', async () => {
    t.deps.config.prospects = { apiKey: 'test-key', searchesPerMonth: 2 };
    answer = () =>
      Response.json({
        places: [
          { id: 'a', displayName: { text: 'Grace Church' }, formattedAddress: '1 Main St, Columbus, OH', nationalPhoneNumber: '(614) 555-0100', rating: 4.8, userRatingCount: 120, googleMapsUri: 'https://maps.google.com/?cid=1' },
          { id: 'b', displayName: { text: 'Hope Chapel' }, websiteUri: 'https://hope.example', businessStatus: 'OPERATIONAL' },
          { id: 'c', displayName: { text: 'Old Mission' }, businessStatus: 'CLOSED_PERMANENTLY' },
        ],
      });
    const res = await search({ query: '  church ', location: 'Columbus,   Ohio' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    for (const p of body.prospects) valid('Prospect', p);
    valid('ProspectUsage', body.usage);
    expect(body.prospects.map((p: any) => p.name)).toEqual(['Grace Church', 'Hope Chapel']);
    expect(body.prospects[0]).toMatchObject({ website: null, phone: '(614) 555-0100', rating: 4.8, reviews: 120 });
    expect(body.usage).toMatchObject({ available: true, used: 1, limit: 2 });
    const sent = calls.at(-1)!;
    expect(sent.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect((sent.init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('test-key');
    expect(JSON.parse(String(sent.init.body))).toMatchObject({ textQuery: 'church in Columbus, Ohio', pageSize: 20 });
  });

  it("doesn't count a search Google fails", async () => {
    answer = () => new Response('quota', { status: 429 });
    expect((await search({ query: 'church', location: 'Dayton' })).status).toBe(502);
    expect((await usage()).used).toBe(1);
  });

  it("says the finder isn't working when Google refuses the key, and logs Google's reason", async () => {
    answer = () => Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Places API (New) has not been used in project 1 before or it is disabled.' } }, { status: 403 });
    const logged: string[] = [];
    const original = console.error;
    console.error = (msg: unknown) => void logged.push(String(msg));
    try {
      expect((await search({ query: 'church', location: 'Dayton' })).status).toBe(503);
    } finally {
      console.error = original;
    }
    expect(logged.join('\n')).toContain('403 PERMISSION_DENIED: Places API (New) has not been used');
    expect(logged.join('\n')).not.toContain('test-key');
  });

  it('refuses a search once the month is used up', async () => {
    answer = () => Response.json({ places: [] });
    expect((await search({ query: 'church', location: 'Dayton' })).status).toBe(200);
    const spent = await search({ query: 'church', location: 'Dayton' });
    expect(spent.status).toBe(429);
    expect((await usage()).used).toBe(2);
  });

  it('asks for a kind of business and a place', async () => {
    expect((await search({ query: 'c', location: 'Dayton' })).status).toBe(400);
    expect((await search({ query: 'church' })).status).toBe(400);
  });

  it('reads the allowance from the environment', () => {
    expect(loadProspectConfig({})).toEqual({ apiKey: undefined, searchesPerMonth: 100 });
    expect(loadProspectConfig({ GOOGLE_PLACES_API_KEY: ' k ', PROSPECT_SEARCHES_PER_MONTH: '50' })).toEqual({ apiKey: 'k', searchesPerMonth: 50 });
    expect(() => loadProspectConfig({ PROSPECT_SEARCHES_PER_MONTH: 'lots' })).toThrow();
  });
});

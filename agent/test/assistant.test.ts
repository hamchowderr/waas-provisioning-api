// The website assistant against the real API in-process and fake stores that answer like WaaS Client.
// AIMock plays the model, so each test scripts exactly which tool the model calls, and the test checks
// what reached which store. Needs TEST_DATABASE_URL, like the API's own tests.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
let seen: { domain: string; method: string; path: string; body: string }[] = [];

/** What a store's WaaS Client answers to the API's signed site requests. */
const storeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/wp-json\/waas-client\/v1\/site/, '');
  const method = init?.method ?? 'GET';
  seen.push({ domain: url.host, method, path, body: typeof init?.body === 'string' ? init.body : '' });
  if (path === '' && method === 'GET') return Response.json({ name: 'Bakery', url: `https://${url.host}/`, theme: 'anypress' });
  if (path === '/pages' && method === 'POST') return Response.json({ id: 14, status: 'draft', link: `https://${url.host}/?page_id=14&preview=true` });
  if (/^\/pages\/\d+$/.test(path)) return Response.json({ id: Number(path.split('/')[2]), status: 'publish', outline: ['0 Hero', '1 About'] });
  return Response.json({ ok: true });
}) as typeof fetch;

/** Store writes only; every request also reads the site once to learn which store it is. */
const writes = () => seen.filter((s) => s.method !== 'GET');

beforeAll(async () => {
  h = await startHarness(['site-a', 'site-b'], storeFetch);
});
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  seen = [];
  h.llm.clearFixtures();
  h.llm.clearRequests();
});

describe('website assistant', () => {
  it('needs the website sign-in', async () => {
    expect((await h.chat(null, { message: 'hi' })).status).toBe(401);
    expect((await h.chat({ ...h.stores[0]!, token: 'nope' }, { message: 'hi' })).status).toBe(401);
  });

  it('adds a draft page straight away, through the API to its own store', async () => {
    const [a] = h.stores;
    h.script('Add an FAQ page', 'site_pages', { action: 'create', title: 'FAQ' }, 'I added a draft FAQ page.');
    const response = await h.chat(a!, { message: 'Add an FAQ page' });
    expect(response.status).toBe(200);
    const reply = (await response.json()) as { text: string; pending: unknown[] };
    expect(reply.text).toBe('I added a draft FAQ page.');
    expect(reply.pending).toEqual([]);
    expect(writes()).toEqual([{ domain: a!.domain, method: 'POST', path: '/pages', body: expect.stringContaining('"title":"FAQ"') }]);
    // Anthropic's API, offered the site tools only.
    const first = h.llm.getRequests()[0];
    expect(first?.path).toBe('/v1/messages');
    const offered = (first?.body as { tools?: { function: { name: string } }[] }).tools?.map((tool) => tool.function.name).sort();
    expect(offered).toEqual(['add_image', 'get_site', 'header_footer', 'page_section', 'site_menus', 'site_pages', 'site_patterns', 'site_styles']);
  });

  it('waits for the owner before publishing, then publishes on their yes', async () => {
    const [a, b] = h.stores;
    h.script('Publish the FAQ page', 'site_pages', { action: 'update', pageId: 14, status: 'publish' }, 'The FAQ page is live.');
    const first = (await (await h.chat(a!, { message: 'Publish the FAQ page', conversation: 'publish-1' })).json()) as {
      pending: { toolCallId: string; summary: string }[];
    };
    expect(first.pending).toHaveLength(1);
    expect(first.pending[0]!.summary).toBe('Publish page 14');
    expect(writes()).toEqual([]);

    // Another store's owner can't see or answer it, even with the same conversation id.
    const other = (await (await h.answer(b!, { conversation: 'publish-1', toolCallId: first.pending[0]!.toolCallId, approve: true })).json()) as { error?: string };
    expect(other.error).toBe('That change is no longer waiting.');
    expect(writes()).toEqual([]);

    const done = (await (await h.answer(a!, { conversation: 'publish-1', toolCallId: first.pending[0]!.toolCallId, approve: true })).json()) as { text: string; pending: unknown[] };
    expect(done.text).toBe('The FAQ page is live.');
    expect(done.pending).toEqual([]);
    expect(writes()).toEqual([{ domain: a!.domain, method: 'PATCH', path: '/pages/14', body: expect.stringContaining('"status":"publish"') }]);
  });

  it('changes nothing when the owner says no', async () => {
    const [a] = h.stores;
    h.script('Remove the second section of my home page', 'page_section', { action: 'remove', pageId: 2, section: 1 }, 'Okay, I left it as it is.');
    const first = (await (await h.chat(a!, { message: 'Remove the second section of my home page', conversation: 'remove-1' })).json()) as {
      pending: { toolCallId: string; summary: string }[];
    };
    expect(first.pending[0]!.summary).toBe('Remove section 1 on page 2');
    const done = (await (await h.answer(a!, { conversation: 'remove-1', toolCallId: first.pending[0]!.toolCallId, approve: false, reason: 'Keep it' })).json()) as { text: string };
    expect(done.text).toBe('Okay, I left it as it is.');
    expect(writes()).toEqual([]);
  });

  it('stays on its own store when the model names another one', async () => {
    const [a, b] = h.stores;
    // As if text on a page had talked the model into reading store b.
    h.script('Show me my home page', 'site_pages', { action: 'read', pageId: 2, externalId: 'site-b' }, 'Your home page has a hero and an about section.');
    await h.chat(a!, { message: 'Show me my home page' });
    expect(seen.map((s) => s.domain)).not.toContain(b!.domain);
    expect(seen).toContainEqual({ domain: a!.domain, method: 'GET', path: '/pages/2', body: '' });
  });
});

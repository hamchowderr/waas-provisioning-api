// The website assistant against the real API in-process and fake stores that answer like WaaS Client.
// AIMock plays the model, so each test scripts exactly which tool the model calls, and the test checks
// what reached which store. The assistant speaks the Chat Kit's chat routes (/agent-controller/*).
// Needs TEST_DATABASE_URL, like the API's own tests.
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

/** Store writes only; signing in also reads the site once to learn which store it is. */
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
    expect((await h.post('/agent-controller/stream', null, { text: 'hi' })).status).toBe(401);
    expect((await h.post('/agent-controller/stream', { ...h.stores[0]!, token: 'nope' }, { text: 'hi' })).status).toBe(401);
    expect((await h.post('/agent-controller/approve', null, { decision: 'approve', toolCallId: 'x' })).status).toBe(401);
  });

  it('adds a draft page straight away, through the API to its own store', async () => {
    const [a] = h.stores;
    h.script('Add an FAQ page', 'site_pages', { action: 'create', title: 'FAQ' }, 'I added a draft FAQ page.');
    const turn = h.send(a!, { text: 'Add an FAQ page' });
    expect(await turn.text()).toBe('I added a draft FAQ page.');
    expect(turn.gates()).toEqual([]);
    expect(writes()).toEqual([{ domain: a!.domain, method: 'POST', path: '/pages', body: expect.stringContaining('"status":"draft"') }]);
    // Anthropic's API, offered the site tools and ask_user only.
    const first = h.llm.getRequests()[0];
    expect(first?.path).toBe('/v1/messages');
    const offered = (first?.body as { tools?: { function: { name: string } }[] }).tools?.map((tool) => tool.function.name).sort();
    expect(offered).toEqual([
      'add_image', 'ask_user', 'editor_change', 'get_site', 'header_footer', 'header_footer_change', 'page_section', 'site_menus', 'site_menus_change',
      'site_pages', 'site_pages_change', 'site_patterns', 'site_styles', 'site_styles_change',
    ]);
  });

  it('keeps a page made with the look-and-draft tool a draft, even if the model asks to publish it', async () => {
    const [a] = h.stores;
    h.script('Add and publish a page', 'site_pages', { action: 'create', title: 'Now', status: 'publish' }, 'Done.');
    await h.send(a!, { text: 'Add and publish a page' }).done;
    expect(writes()).toEqual([{ domain: a!.domain, method: 'POST', path: '/pages', body: expect.stringContaining('"status":"draft"') }]);
  });

  it('waits for the owner before publishing, then publishes on their yes', async () => {
    const [a, b] = h.stores;
    h.script('Publish the FAQ page', 'site_pages_change', { action: 'update', pageId: 14, status: 'publish' }, 'The FAQ page is live.');
    const turn = h.send(a!, { text: 'Publish the FAQ page' });
    const gate = await turn.next('tool_approval_required');
    expect(turn.gates()).toEqual([{ toolCallId: gate.toolCallId, toolName: 'site_pages_change', summary: 'Publish page 14' }]);
    expect(gate.category).toBeNull();
    expect(writes()).toEqual([]);

    // Another store's owner can't answer it.
    expect((await h.post('/agent-controller/approve', b!, { decision: 'approve', toolCallId: gate.toolCallId })).status).toBe(409);
    expect(writes()).toEqual([]);

    expect((await h.post('/agent-controller/approve', a!, { decision: 'approve', toolCallId: gate.toolCallId })).status).toBe(200);
    expect(await turn.text()).toBe('The FAQ page is live.');
    expect(writes()).toEqual([{ domain: a!.domain, method: 'PATCH', path: '/pages/14', body: expect.stringContaining('"status":"publish"') }]);
  });

  it('asks again next time, even after "always allow"', async () => {
    const [a] = h.stores;
    h.script('Publish page 3', 'site_pages_change', { action: 'update', pageId: 3, status: 'publish' }, 'Live.');
    const first = h.send(a!, { text: 'Publish page 3' });
    const gate = await first.next('tool_approval_required');
    await h.post('/agent-controller/approve', a!, { decision: 'always_allow_category', toolCallId: gate.toolCallId });
    await first.done;

    h.script('Publish page 4', 'site_pages_change', { action: 'update', pageId: 4, status: 'publish' }, 'Live.');
    const second = h.send(a!, { text: 'Publish page 4' });
    await second.next('tool_approval_required');
    expect(writes().map((w) => w.path)).toEqual(['/pages/3']);
    await h.post('/agent-controller/approve', a!, { decision: 'decline', toolCallId: second.gates()[0]!.toolCallId });
    await second.done;
  });

  it('changes nothing when the owner says no', async () => {
    const [a] = h.stores;
    h.script('Remove the second section of my home page', 'page_section', { action: 'remove', pageId: 2, section: 1 }, 'Okay, I left it as it is.');
    const turn = h.send(a!, { text: 'Remove the second section of my home page' });
    const gate = await turn.next('tool_approval_required');
    expect(turn.gates()[0]!.summary).toBe('Remove section 1 on page 2');
    await h.post('/agent-controller/approve', a!, { decision: 'decline', toolCallId: gate.toolCallId });
    expect(await turn.text()).toBe('Okay, I left it as it is.');
    expect(writes()).toEqual([]);
  });

  it('stays on its own store when the model names another one', async () => {
    const [a, b] = h.stores;
    // As if text on a page had talked the model into reading store b.
    h.script('Show me my home page', 'site_pages', { action: 'read', pageId: 2, externalId: 'site-b' }, 'Your home page has a hero and an about section.');
    await h.send(a!, { text: 'Show me my home page' }).done;
    expect(seen.map((s) => s.domain)).not.toContain(b!.domain);
    expect(seen).toContainEqual({ domain: a!.domain, method: 'GET', path: '/pages/2', body: '' });
  });

  it('keeps each website’s conversations to itself', async () => {
    const [a, b] = h.stores;
    h.script('Hello there', 'get_site', {}, 'Hi!');
    const turn = h.send(a!, { text: 'Hello there' });
    const thread = (await turn.next('__thread__')).threadId as string;
    await turn.done;

    const mine = (await (await h.get('/agent-controller/threads', a!)).json()) as { threads: { id: string }[] };
    expect(mine.threads.map((t) => t.id)).toContain(thread);
    const theirs = (await (await h.get('/agent-controller/threads', b!)).json()) as { threads: { id: string }[] };
    expect(theirs.threads.map((t) => t.id)).not.toContain(thread);
    expect((await h.get(`/agent-controller/threads/${thread}/messages`, b!)).status).toBe(404);
    expect((await h.post('/agent-controller/stream', b!, { text: 'hi', threadId: thread })).status).toBe(404);
  });

  it('tells the panel beside the page editor which website it is signed in to', async () => {
    const [a] = h.stores;
    const answer = await h.get('/agent-controller/site', a!);
    expect(await answer.json()).toEqual({ url: `https://${a!.domain}/` });
    expect((await h.get('/agent-controller/site', null)).status).toBe(401);
  });

  it('changes the block selected in the open editor at once, and never the website itself', async () => {
    const [a] = h.stores;
    const editor = {
      screen: 'post',
      postType: 'page',
      postId: 2,
      title: 'Home',
      blocks: [
        { clientId: 'hero-1', name: 'core/group', markup: '<!-- wp:group --><div class="wp-block-group"><!-- wp:heading --><h2>Fresh bread</h2><!-- /wp:heading --></div><!-- /wp:group -->' },
        { clientId: 'about-2', name: 'core/paragraph', markup: '<!-- wp:paragraph --><p>About us</p><!-- /wp:paragraph -->' },
      ],
      selected: { clientId: 'hero-1', name: 'core/group', markup: '' },
    };
    const content = '<!-- wp:group --><div class="wp-block-group"><!-- wp:heading --><h2>Bread baked at dawn</h2><!-- /wp:heading --></div><!-- /wp:group -->';
    h.script('Make this heading warmer', 'editor_change', { action: 'replace', clientId: 'hero-1', content }, 'Done. Press Save to keep it.');
    const turn = h.send(a!, { text: 'Make this heading warmer', editor });
    expect(await turn.text()).toBe('Done. Press Save to keep it.');
    // No approval card: the owner keeps it by saving.
    expect(turn.gates()).toEqual([]);
    const end = turn.events.find((event) => event.type === 'tool_end') as { result?: { editor?: unknown }; isError?: boolean } | undefined;
    expect(end?.isError).toBe(false);
    expect(end?.result?.editor).toEqual({ action: 'replace', clientId: 'hero-1', content });
    expect(writes()).toEqual([]);
    // The model was shown the open editor, with the selected block.
    const system = JSON.stringify(h.llm.getRequests()[0]?.body);
    expect(system).toContain('The owner is in the editor, on the page \\"Home\\" (id 2)');
    expect(system).toContain('selected the block hero-1');
    expect(system).toContain('About us');
  });

  it('refuses a block the open editor doesn’t have, and any editor change with no editor open', async () => {
    const [a] = h.stores;
    const editor = { screen: 'post', postType: 'page', postId: 2, title: 'Home', blocks: [{ clientId: 'hero-1', name: 'core/group', markup: '' }] };
    h.script('Remove the footer block', 'editor_change', { action: 'remove', clientId: 'nope-9' }, 'I could not find it.');
    const turn = h.send(a!, { text: 'Remove the footer block', editor });
    await turn.done;
    expect((turn.events.find((event) => event.type === 'tool_end') as { isError?: boolean } | undefined)?.isError).toBe(true);

    h.script('Remove the hero', 'editor_change', { action: 'remove', clientId: 'hero-1' }, 'Open the editor first.');
    const plain = h.send(a!, { text: 'Remove the hero' });
    await plain.done;
    expect((plain.events.find((event) => event.type === 'tool_end') as { isError?: boolean } | undefined)?.isError).toBe(true);
    expect(JSON.stringify(h.llm.getRequests().at(-1)?.body)).not.toContain('The open editor');
    expect(writes()).toEqual([]);
  });
});

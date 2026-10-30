// The website assistant on a real WordPress: WordPress Playground (WordPress and PHP in Node) runs WaaS Client
// with the store's site key, and the API's signed site requests for the store go to it. AIMock still plays
// the model; WordPress is real, so drafts, publishing, revisions and undo are checked on actual pages.
//
//   WAAS_CLIENT_DIR=../../waas-plugins/packages/waas-client npm run test:playground
//
// Needs Node 24.18+ (Playground's CLI), WaaS Client with its vendor folder (composer install --no-dev),
// and TEST_DATABASE_URL. Skipped when WAAS_CLIENT_DIR isn't set.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callSite, siteKey, siteKeyMaster } from '../../src/sitekeys.ts';
import { TEST_SECRETS_KEY } from '../../test/helpers.ts';
import { startHarness, type Harness, type Store } from './harness.ts';

const CLIENT = process.env.WAAS_CLIENT_DIR ? resolve(process.env.WAAS_CLIENT_DIR) : '';
const WP = process.env.PLAYGROUND_WP || '7.1.4';
const STARTER_PAGES = new URL('../../templates/anypress-store/mu-plugins/anypress-patterns.php', import.meta.url);

let h: Harness;
let store: Store;
let wordpress: string;
let cli: { serverUrl: string; [Symbol.asyncDispose]?: () => Promise<void> } | undefined;

/** The API's signed requests for the store go to Playground; the signature covers the route, not the host. */
const toPlayground = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  return fetch(`${wordpress}${url.pathname}${url.search}`, init);
}) as typeof fetch;

/** Reads the store directly, as the API would, to check what really changed. */
async function read<T>(path: string): Promise<T> {
  const answer = await callSite(siteKey(siteKeyMaster(TEST_SECRETS_KEY), store.id), store.domain, { method: 'GET', path }, toPlayground);
  expect(answer.status).toBe(200);
  return answer.body as T;
}

type Page = { id: number; title: string; status: string };

describe.skipIf(!CLIENT)('website assistant on WordPress Playground', () => {
  beforeAll(async () => {
    if (!existsSync(resolve(CLIENT, 'vendor/autoload.php'))) throw new Error(`${CLIENT}/vendor is missing: composer install --no-dev there first.`);
    h = await startHarness(['bakery'], toPlayground);
    store = h.stores[0]!;
    // Its type declarations don't resolve under NodeNext; runCLI is its documented entry point.
    const { runCLI } = (await import('@wp-playground/cli')) as unknown as { runCLI: (options: unknown) => Promise<typeof cli> };
    cli = await runCLI({
      command: 'server',
      wp: `https://wordpress.org/wordpress-${WP}.zip`,
      php: '8.3',
      port: 0,
      verbosity: 'quiet',
      mount: [{ hostPath: CLIENT, vfsPath: '/wordpress/wp-content/plugins/waas-client' }],
      blueprint: {
        steps: [
          { step: 'activatePlugin', pluginPath: 'waas-client/index.php' },
          { step: 'writeFile', path: '/wordpress/wp-content/mu-plugins/anypress-patterns.php', data: readFileSync(STARTER_PAGES, 'utf8') },
          // Stores get their site key as an environment variable on their container; here a must-use plugin sets it.
          { step: 'writeFile', path: '/wordpress/wp-content/mu-plugins/waas-site-key.php', data: `<?php putenv('WAAS_SITE_KEY=${siteKey(siteKeyMaster(TEST_SECRETS_KEY), store.id)}');\n` },
        ],
      },
    });
    wordpress = cli!.serverUrl.replace(/\/$/, '');
    // Playground answers its first request with a redirect to the same address; take it before the tests.
    await fetch(`${wordpress}/wp-json/`);
  }, 280_000);
  afterAll(async () => {
    await cli?.[Symbol.asyncDispose]?.();
    await h?.close();
  });
  beforeEach(() => {
    h.llm.clearFixtures();
  });

  const pages = () => read<Page[]>('/pages');
  const faq = async () => (await pages()).find((p) => p.title === 'FAQ');

  it('adds a draft, publishes it only after the owner says yes, and can undo a change', async () => {
    h.script('Add an FAQ page', 'site_pages', {
      action: 'create',
      title: 'FAQ',
      content: '<!-- wp:heading --><h2 class="wp-block-heading">Questions</h2><!-- /wp:heading -->',
    }, 'I added a draft FAQ page.');
    const added = (await (await h.chat(store, { message: 'Add an FAQ page', conversation: 'faq' })).json()) as { pending: unknown[] };
    expect(added.pending).toEqual([]);
    const page = await faq();
    expect(page?.status).toBe('draft');

    h.script('Publish it', 'site_pages', { action: 'update', pageId: page!.id, status: 'publish' }, 'The FAQ page is live.');
    const waiting = (await (await h.chat(store, { message: 'Publish it', conversation: 'faq' })).json()) as { pending: { toolCallId: string; summary: string }[] };
    expect(waiting.pending.map((p) => p.summary)).toEqual([`Publish page ${page!.id}`]);
    expect((await faq())?.status).toBe('draft');
    await h.answer(store, { conversation: 'faq', toolCallId: waiting.pending[0]!.toolCallId, approve: true });
    expect((await faq())?.status).toBe('publish');

    h.script('Change the heading to Good to know', 'page_section', {
      action: 'replace',
      pageId: page!.id,
      section: 0,
      content: '<!-- wp:heading --><h2 class="wp-block-heading">Good to know</h2><!-- /wp:heading -->',
    }, 'Done.');
    const change = (await (await h.chat(store, { message: 'Change the heading to Good to know', conversation: 'faq' })).json()) as { pending: { toolCallId: string }[] };
    await h.answer(store, { conversation: 'faq', toolCallId: change.pending[0]!.toolCallId, approve: true });
    const changed = await read<{ content: string }>(`/pages/${page!.id}`);
    expect(changed.content).toContain('Good to know');

    // Undo: the revision from before the change.
    const revisions = await read<{ id: number; outline: unknown }[]>(`/pages/${page!.id}/revisions`);
    const before = revisions.find((r) => JSON.stringify(r.outline).includes('Questions'));
    expect(before).toBeDefined();
    h.script('Put the old heading back', 'site_pages', { action: 'restore_revision', pageId: page!.id, revisionId: before!.id }, 'It’s back the way it was.');
    const undo = (await (await h.chat(store, { message: 'Put the old heading back', conversation: 'faq' })).json()) as { pending: { toolCallId: string; summary: string }[] };
    expect(undo.pending[0]!.summary).toBe(`Put page ${page!.id} back to an earlier version`);
    await h.answer(store, { conversation: 'faq', toolCallId: undo.pending[0]!.toolCallId, approve: true });
    expect((await read<{ content: string }>(`/pages/${page!.id}`)).content).toContain('Questions');
  });

  it('leaves the page alone when the owner says no', async () => {
    const page = await faq();
    const before = await read<{ content: string }>(`/pages/${page!.id}`);
    h.script('Remove the heading', 'page_section', { action: 'remove', pageId: page!.id, section: 0 }, 'Okay, I left it.');
    const waiting = (await (await h.chat(store, { message: 'Remove the heading', conversation: 'faq-2' })).json()) as { pending: { toolCallId: string }[] };
    await h.answer(store, { conversation: 'faq-2', toolCallId: waiting.pending[0]!.toolCallId, approve: false });
    expect((await read<{ content: string }>(`/pages/${page!.id}`)).content).toBe(before.content);
  });
});

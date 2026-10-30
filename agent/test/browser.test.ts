// The chat panel (panel/) in a real browser: the built Next app on top of the assistant, the API
// in-process and a fake store, with AIMock as the model. The owner types a request, the change waits
// on an approval card, and only their click makes it. Run `npm run build` in panel/ first.
// Needs TEST_DATABASE_URL, like the API's own tests, and Playwright with Chromium.
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
let assistant: ServerType;
let api: ServerType;
let shop: Server;
let shopUrl: string;
let panel: ChildProcess;
let panelUrl: string;
let browser: Browser;
let seen: { method: string; path: string; body: string }[] = [];

const storeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/wp-json\/waas-client\/v1\/site/, '');
  const method = init?.method ?? 'GET';
  seen.push({ method, path, body: typeof init?.body === 'string' ? init.body : '' });
  if (path === '' && method === 'GET') return Response.json({ name: 'Bakery', url: `https://${url.host}/`, theme: 'anypress' });
  if (/^\/pages\/\d+$/.test(path)) return Response.json({ id: Number(path.split('/')[2]), status: 'publish' });
  return Response.json({ ok: true });
}) as typeof fetch;

const writes = () => seen.filter((s) => s.method !== 'GET');

async function freePort(): Promise<number> {
  const server = createNetServer().listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  return port;
}

async function waitFor(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} never answered`);
}

beforeAll(async () => {
  h = await startHarness(['bakery'], storeFetch);
  const assistantPort = await freePort();
  assistant = serve({ fetch: h.app.fetch, port: assistantPort });
  const apiPort = await freePort();
  api = serve({ fetch: h.t.app.fetch, port: apiPort });
  // The shop's "Ask the website assistant" route, as WaaS Host answers it for its signed-in owner of "bakery".
  shop = createHttpServer(async (_request, response) => {
    const answer = await h.t.app.request('/v1/tenants/site/handoff?externalId=bakery', {
      method: 'POST',
      headers: { Authorization: h.apiAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistantUrl: panelUrl }),
    });
    const { url } = (await answer.json()) as { url: string };
    response.writeHead(303, { Location: url }).end();
  }).listen(0);
  await once(shop, 'listening');
  shopUrl = `http://localhost:${(shop.address() as AddressInfo).port}`;
  const port = await freePort();
  panelUrl = `http://localhost:${port}`;
  panel = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: new URL('../panel/', import.meta.url),
    env: {
      ...process.env,
      MASTRA_SERVER_URL: `http://localhost:${assistantPort}`,
      ANYPRESS_API_URL: `http://localhost:${apiPort}`,
      PANEL_URL: panelUrl,
    },
    stdio: 'ignore',
  });
  await waitFor(panelUrl);
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  panel?.kill();
  assistant?.close();
  api?.close();
  shop?.close();
  await h?.close();
});

beforeEach(() => {
  seen = [];
  h.llm.clearFixtures();
});

/** A page signed in as the bakery's owner, the way /callback leaves the cookies. */
async function signedInPage(width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height } });
  // Playwright won't add a Secure cookie for plain http, and the panel only reads them here.
  const cookie = { url: panelUrl, httpOnly: true, secure: false, sameSite: 'Lax' as const };
  await context.addCookies([
    { ...cookie, name: 'ap_access', value: h.stores[0]!.token },
    { ...cookie, name: 'ap_expires', value: String(Date.now() + 3_600_000) },
  ]);
  return context.newPage();
}

describe('chat panel', () => {
  it('asks a signed-out owner to sign in with their website', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(panelUrl);
    await expect(page.getByRole('button', { name: 'Continue with WordPress' }).isVisible()).resolves.toBe(true);
    await context.close();
  });

  for (const [label, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]] as const) {
    it(`publishes a page only after the owner clicks Approve (${label})`, async () => {
      h.script(`Publish my FAQ page ${label}`, 'site_pages_change', { action: 'update', pageId: 14, status: 'publish' }, 'Your FAQ page is live.');
      const page = await signedInPage(width, height);
      await page.goto(panelUrl);
      const box = page.getByRole('textbox');
      await box.fill(`Publish my FAQ page ${label}`);
      await box.press('Enter');

      const card = page.getByText('Publish page 14');
      await card.waitFor({ timeout: 30_000 });
      expect(writes()).toEqual([]);
      await page.screenshot({ path: `test-results/panel-approval-${label}.png`, fullPage: true });

      await page.getByRole('button', { name: 'Approve' }).click();
      await page.getByText('Your FAQ page is live.').waitFor({ timeout: 30_000 });
      expect(writes()).toEqual([{ method: 'PATCH', path: '/pages/14', body: expect.stringContaining('"status":"publish"') }]);
      // Nothing spills sideways at this width.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/panel-done-${label}.png`, fullPage: true });
      await page.context().close();
    }, 90_000);
  }

  it('changes nothing when the owner clicks Reject', async () => {
    h.script('Remove my second section', 'page_section', { action: 'remove', pageId: 2, section: 1 }, 'Okay, I left it as it is.');
    const page = await signedInPage(1280, 800);
    await page.goto(panelUrl);
    await page.getByRole('textbox').fill('Remove my second section');
    await page.getByRole('textbox').press('Enter');
    await page.getByText('Remove section 1 on page 2').waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Reject' }).click();
    await page.getByText('Okay, I left it as it is.').waitFor({ timeout: 30_000 });
    expect(writes()).toEqual([]);
    await page.context().close();
  }, 90_000);

  it('opens signed in from the shop’s button, with no sign-in of its own', async () => {
    h.script('What is on my site?', 'get_site', {}, 'Your site is called Bakery.');
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${shopUrl}/assistant`);
    await page.getByRole('textbox').fill('What is on my site?');
    await page.getByRole('textbox').press('Enter');
    await page.getByText('Your site is called Bakery.').waitFor({ timeout: 30_000 });
    // Every redirect lands on the panel's own address (PANEL_URL), never the container's.
    expect(new URL(page.url()).origin).toBe(panelUrl);

    // Reopened, the chat keeps its step card as well as its answer.
    await page.reload();
    await page.getByRole('button', { name: 'Chat history' }).click();
    await page.getByRole('menuitem', { name: /What is on my site/ }).click();
    await page.getByText('Your site is called Bakery.').waitFor({ timeout: 30_000 });
    await expect(page.getByText('Reading your website').isVisible()).resolves.toBe(true);
    await context.close();
  }, 90_000);

  it('keeps the conversation in a centred column on a wide screen', async () => {
    h.script('Hello wide', 'get_site', {}, 'Hello from the middle.');
    const page = await signedInPage(1600, 900);
    await page.goto(panelUrl);
    await page.getByRole('textbox').fill('Hello wide');
    await page.getByRole('textbox').press('Enter');
    await page.getByText('Hello from the middle.').waitFor({ timeout: 30_000 });
    const box = await page.getByRole('textbox').boundingBox();
    expect(box).not.toBeNull();
    // The input sits in the middle, no wider than the reading column.
    expect(box!.width).toBeLessThanOrEqual(800);
    expect(Math.abs(box!.x + box!.width / 2 - 800)).toBeLessThan(40);
    await page.screenshot({ path: 'test-results/panel-wide.png', fullPage: true });
    await page.context().close();
  }, 90_000);

  it('refuses a made-up or used handoff', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${panelUrl}/from-shop?handoff=made-up`);
    expect(new URL(page.url()).origin).toBe(panelUrl);
    await expect(page.getByRole('button', { name: 'Continue with WordPress' }).isVisible()).resolves.toBe(true);
    await context.close();
  });
});

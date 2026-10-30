import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { createAuth, loadAuthConfig, type AuthConfig } from '../src/auth.ts';
import { sendSignInLink } from '../src/authmail.ts';
import { forgetDashboardHosts } from '../src/dashboarddomains.ts';
import { setup, type TestContext } from './helpers.ts';

const MAIL = { key: 'tsend_test_key', from: 'no-reply@app.waas.example', brand: 'AnyPress' };
const AUTH: AuthConfig = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789', mail: MAIL };

let t: TestContext;
let app: ReturnType<typeof createApp>;
const sent: { to: string; url: string; body: any }[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  t = await setup();
  // Only toSend is faked; everything else goes out as usual.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.tosend.com/')) return realFetch(input, init);
    const body = JSON.parse(String(init!.body));
    sent.push({ to: body.to[0].email, url: /href="([^"]+)"/.exec(body.html)![1]!.replaceAll('&amp;', '&'), body });
    return new Response(JSON.stringify({ message_id: 'm1' }), { status: 200 });
  });
  t.deps.config.auth = AUTH;
  t.deps.auth = createAuth(t.pool, AUTH);
  app = createApp(t.deps);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

describe('emailed sign-in links', () => {
  it('emails a link that signs the person in with a verified address', async () => {
    const res = await app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: AUTH.url },
      body: JSON.stringify({ email: 'Owner@Agency.example', callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('owner@agency.example');
    expect(sent[0]!.body.from).toEqual({ email: MAIL.from, name: 'AnyPress' });
    expect(sent[0]!.body.subject).toBe('Your AnyPress sign-in link');

    const link = new URL(sent[0]!.url);
    expect(link.origin).toBe(AUTH.url);
    const verified = await app.request(link.pathname + link.search, { redirect: 'manual' });
    expect(verified.status).toBe(302);
    const cookie = verified.headers.getSetCookie().find((c) => /^(__Secure-)?better-auth.session_token=/.test(c))!;
    expect(cookie).toBeDefined();

    const account = await app.request('/account', { headers: { Cookie: cookie.split(';')[0]! } });
    expect(account.status).toBe(200);
    expect((await account.json()).user).toMatchObject({ email: 'owner@agency.example', emailVerified: true });
    const row = await t.pool.query('SELECT "emailVerified" AS email_verified FROM auth."user" WHERE email = $1', ['owner@agency.example']);
    expect(row.rows[0].email_verified).toBe(true);

    // A link works once.
    const again = await app.request(link.pathname + link.search, { redirect: 'manual' });
    expect(again.headers.getSetCookie().some((c) => /^(__Secure-)?better-auth.session_token=/.test(c))).toBe(false);
  });
});

describe("sign-in on a seller's own dashboard address", () => {
  const OWN = 'dash.seller.example';
  let sellerId: string;
  let otherId: string;

  /** Asks for a link the way the dashboard's proxy does, from `host`, and follows it. */
  async function signInOn(host: string, email: string) {
    sent.splice(0);
    const res = await app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `https://${host}`, 'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ email, callbackURL: '/' }),
    });
    return { res, link: sent[0] ? new URL(sent[0].url) : null };
  }

  beforeAll(async () => {
    const products = await t.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Seller shop'), ('Another shop') RETURNING id");
    [sellerId, otherId] = products.rows.map((r) => r.id) as [string, string];
    await t.pool.query("INSERT INTO dashboard_domains (product_id, domain, status, records) VALUES ($1, $2, 'active', '[]')", [sellerId, OWN]);
    forgetDashboardHosts();
  });

  it('emails a link on that address, and it signs the person in there', async () => {
    const { res, link } = await signInOn(OWN, 'team@seller.example');
    expect(res.status).toBe(200);
    expect(link!.origin).toBe(`https://${OWN}`);
    // In the seller's name, with a small line for the platform.
    expect(sent[0]!.body.from).toEqual({ email: MAIL.from, name: 'Seller shop' });
    expect(sent[0]!.body.subject).toBe('Your Seller shop sign-in link');
    expect(sent[0]!.body.text).toMatch(/Powered by AnyPress$/);
    const verified = await app.request(link!.pathname + link!.search, { redirect: 'manual', headers: { 'X-Forwarded-Host': OWN } });
    expect(verified.status).toBe(302);
    expect(verified.headers.get('location')).toMatch(new RegExp(`^(https://${OWN.replaceAll('.', '\\.')})?/`));
  });

  it('puts any other address back to the platform one', async () => {
    const { res, link } = await signInOn('evil.example', 'victim@seller.example');
    expect(res.status).toBe(200);
    expect(link!.origin).toBe(AUTH.url);
  });

  it("lets only that storefront's team in on that address", async () => {
    const { link } = await signInOn(AUTH.url.replace('https://', ''), 'both@seller.example');
    const verified = await app.request(link!.pathname + link!.search, { redirect: 'manual' });
    const cookie = verified.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
    const userId = (await t.pool.query('SELECT id FROM auth."user" WHERE email = $1', ['both@seller.example'])).rows[0].id;
    for (const [i, productId] of [sellerId, otherId].entries()) {
      const org = await t.pool.query('INSERT INTO auth.organization (name, slug, "createdAt", "productId") VALUES ($1, $2, now(), $3) RETURNING id', [`Org ${i}`, `org-host-${i}`, productId]);
      await t.pool.query('INSERT INTO auth.member ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, \'owner\', now())', [org.rows[0].id, userId]);
    }
    const me = async (host?: string) =>
      (await (await app.request('/account', { headers: { Cookie: cookie, ...(host ? { 'X-Dashboard-Host': host } : {}) } })).json()) as { memberships: { productId: string }[]; active: { productId: string } | null };
    expect((await me()).memberships.map((m) => m.productId).sort()).toEqual([sellerId, otherId].sort());
    expect((await me('app.waas.example')).memberships).toHaveLength(2);
    const own = await me(OWN);
    expect(own.memberships.map((m) => m.productId)).toEqual([sellerId]);
    expect(own.active?.productId).toBe(sellerId);
    expect((await me('unknown.example')).memberships).toEqual([]);
  });

  it('shows the sign-in page its storefront, and nothing for other addresses', async () => {
    const res = await app.request(`/branding/host/${OWN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ productName: 'Seller shop', brand: null });
    expect((await app.request('/branding/host/unknown.example')).status).toBe(404);
  });
});

describe('sign-in email settings', () => {
  const base = { AUTH_URL: 'https://app.waas.example', AUTH_SECRET: 'x'.repeat(32) };

  it("reuses the stores' toSend key and sender", () => {
    expect(loadAuthConfig({ ...base, STORE_SMTP_PASSWORD: 'tsend_k', STORE_MAIL_FROM: 'no-reply@anypress.io' })!.mail).toEqual({
      key: 'tsend_k',
      from: 'no-reply@anypress.io',
      brand: 'AnyPress',
      apiUrl: undefined,
      supportEmail: 'support@anypress.io',
      logoUrl: 'https://anypress.io/logo-512.png',
    });
  });

  it("shows AnyPress's address and logo only under the AnyPress name", () => {
    const env = { ...base, STORE_SMTP_PASSWORD: 'tsend_k', STORE_MAIL_FROM: 'a@x.example', AUTH_BRAND: 'Acme Sites' };
    expect(loadAuthConfig(env)!.mail).toMatchObject({ brand: 'Acme Sites', supportEmail: undefined, logoUrl: undefined });
    expect(loadAuthConfig({ ...env, AUTH_SUPPORT_EMAIL: 'help@acme.example' })!.mail).toMatchObject({ supportEmail: 'help@acme.example' });
  });

  it('puts the message, one button and the support address in the email', async () => {
    let body: any;
    const capture = async (_: unknown, init?: RequestInit) => ((body = JSON.parse(String(init!.body))), new Response('{}', { status: 200 }));
    await sendSignInLink({ ...MAIL, supportEmail: 'support@anypress.io', logoUrl: 'https://anypress.io/logo-512.png' }, 'a@b.example', 'https://x.example/l?a=1&b=2', capture as typeof fetch);
    expect(body.html).toContain('<img src="https://anypress.io/logo-512.png"');
    expect(/href="([^"]+)"/.exec(body.html)![1]).toBe('https://x.example/l?a=1&amp;b=2');
    expect(body.html).toContain('mailto:support@anypress.io');
    expect(body.text).toMatch(/Questions\? Write to support@anypress\.io\.$/);
  });

  it('prefers AUTH_MAIL_KEY and AUTH_MAIL_FROM, and is off without a key', () => {
    const env = { ...base, STORE_SMTP_PASSWORD: 'tsend_k', STORE_MAIL_FROM: 'a@x.example', AUTH_MAIL_KEY: 'tsend_auth', AUTH_MAIL_FROM: 'login@x.example' };
    expect(loadAuthConfig(env)!.mail).toMatchObject({ key: 'tsend_auth', from: 'login@x.example' });
    expect(loadAuthConfig(base)!.mail).toBeUndefined();
  });

  it('leaves GitHub off, without failing, when only half its keys are set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadAuthConfig({ ...base, AUTH_GITHUB_ID: '1234567', STORE_SMTP_PASSWORD: 'tsend_k', STORE_MAIL_FROM: 'a@x.example' })!;
    expect(config.github).toBeUndefined();
    expect(config.mail).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports a refused email', async () => {
    const fail = async () => new Response('nope', { status: 422 });
    await expect(sendSignInLink(MAIL, 'a@b.example', 'https://x.example/l', fail as typeof fetch)).rejects.toThrow(/422/);
  });
});

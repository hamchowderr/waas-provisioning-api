import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { createAuth, loadAuthConfig, type AuthConfig } from '../src/auth.ts';
import { sendSignInLink } from '../src/authmail.ts';
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
    expect((await account.json()).user).toMatchObject({ email: 'owner@agency.example' });
    const row = await t.pool.query('SELECT "emailVerified" AS email_verified FROM auth."user" WHERE email = $1', ['owner@agency.example']);
    expect(row.rows[0].email_verified).toBe(true);

    // A link works once.
    const again = await app.request(link.pathname + link.search, { redirect: 'manual' });
    expect(again.headers.getSetCookie().some((c) => /^(__Secure-)?better-auth.session_token=/.test(c))).toBe(false);
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
    });
  });

  it('prefers AUTH_MAIL_KEY and AUTH_MAIL_FROM, and is off without a key', () => {
    const env = { ...base, STORE_SMTP_PASSWORD: 'tsend_k', STORE_MAIL_FROM: 'a@x.example', AUTH_MAIL_KEY: 'tsend_auth', AUTH_MAIL_FROM: 'login@x.example' };
    expect(loadAuthConfig(env)!.mail).toMatchObject({ key: 'tsend_auth', from: 'login@x.example' });
    expect(loadAuthConfig(base)!.mail).toBeUndefined();
  });

  it('reports a refused email', async () => {
    const fail = async () => new Response('nope', { status: 422 });
    await expect(sendSignInLink(MAIL, 'a@b.example', 'https://x.example/l', fail as typeof fetch)).rejects.toThrow(/422/);
  });
});

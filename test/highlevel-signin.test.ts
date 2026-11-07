// The HighLevel app installed with "Sign in to AnyPress" (HighLevel's External Authentication, OAuth
// 2.0): the install asks for the /apps resource, the person approves on the dashboard, and someone
// with no storefront yet makes one there. The token then signs /v1/apps calls in, and nothing else.
import { createHash, randomBytes } from 'node:crypto';
import { testUtils } from 'better-auth/plugins';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, type AuthConfig } from '../src/auth.ts';
import { createApp } from '../src/app.ts';
import { ALL_SCOPES, READ_SCOPES } from '../mcp/src/scopes.ts';
import { setup, TEST_ADMIN_TOKEN, type TestContext } from './helpers.ts';

const BASE = 'https://api.example.test';
const REDIRECT = 'https://services.leadconnectorhq.com/integrations/oauth/finish';
const AUTH: AuthConfig = { url: 'https://app.waas.example', secret: 'test-auth-secret-not-a-secret-0123456789', brand: 'AnyPress', apiUrl: BASE };

let t: TestContext;
let app: ReturnType<typeof createApp>;
let helpers: any;
let clientId: string;

const asUser = (cookie: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { Cookie: cookie, 'X-Session-Auth': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signedIn(email: string) {
  const user = await helpers.saveUser(helpers.createUser({ email, name: email.split('@')[0], emailVerified: true }));
  const { headers } = await helpers.login({ userId: user.id });
  return { userId: user.id as string, cookie: (headers as Headers).get('cookie')! };
}

/**
 * HighLevel's install: its app settings send the browser to the API's old authorization address, which
 * hands over to the plugin, which sends the signed-in person to the dashboard's Connect page.
 */
async function startInstall(who: { cookie: string }, resource = `${BASE}/apps`) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'hl-state', resource });
  const old = await app.request(`/oauth/authorize?${query}`);
  expect(old.status).toBe(302);
  const plugin = new URL(old.headers.get('Location')!);
  expect(`${plugin.origin}${plugin.pathname}`).toBe(`${AUTH.url}/api/auth/oauth2/authorize`);
  const res = await app.request(`${plugin.pathname}${plugin.search}`, { headers: { Cookie: who.cookie } });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('Location')!, AUTH.url);
  expect(`${location.origin}${location.pathname}`).toBe(`${AUTH.url}/connect`);
  const oauthQuery = location.search.slice(1);
  return { oauthQuery, verifier, path: `/account/oauth/connect?${new URLSearchParams({ oauth_query: oauthQuery })}` };
}

async function finish(redirectUrl: string, verifier: string) {
  const code = new URL(redirectUrl).searchParams.get('code')!;
  const res = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }).toString(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string };
}

const apps = (token: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  t = await setup();
  t.deps.config.publicUrl = BASE;
  const auth = createAuth(t.pool, AUTH, [testUtils()]);
  helpers = ((await auth.$context) as unknown as { test: unknown }).test;
  t.deps.config.auth = AUTH;
  t.deps.auth = auth;
  app = createApp(t.deps);
  const registered = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'HighLevel', redirect_uris: [REDIRECT] }),
  });
  clientId = ((await registered.json()) as { client_id: string }).client_id;
});
afterAll(() => t.close());

describe('installing the HighLevel app by signing in to AnyPress', () => {
  it('makes a storefront for an agency that has none, and signs the app in to it', async () => {
    const agency = await signedIn('owner@flowsper.example');
    const { oauthQuery, verifier, path } = await startInstall(agency);
    const view = await (await asUser(agency.cookie, 'GET', path)).json();
    expect(view).toMatchObject({ clientName: 'HighLevel', forApps: true, canCreateStorefront: true, storefronts: [] });
    // It only makes and manages sites, and hears about them.
    expect((view.areas as { area: string }[]).map((a) => a.area)).toEqual(['stores', 'webhooks']);

    const approved = await asUser(agency.cookie, 'POST', '/account/oauth/connect', { oauth_query: oauthQuery, action: 'approve', newStorefront: 'Flowsper Sites', scopes: ALL_SCOPES });
    expect(approved.status).toBe(200);
    const { redirectUrl } = (await approved.json()) as { redirectUrl: string };
    expect(new URL(redirectUrl).searchParams.get('state')).toBe('hl-state');
    const tokens = await finish(redirectUrl, verifier);
    expect((tokens as unknown as { scope: string }).scope.split(' ').sort()).toEqual(['offline_access', 'stores:read', 'stores:write', 'webhooks:read', 'webhooks:write']);
    expect(tokens.refresh_token).toBeTruthy();

    const account = await apps(tokens.access_token, 'GET', '/v1/apps/account');
    expect(account.status).toBe(200);
    const storefront = (await account.json()) as { id: string; name: string; type: string };
    expect(storefront).toMatchObject({ name: 'Flowsper Sites', type: 'storefront' });
    // An account record with the seller's store limit, and the person as its owner.
    const { rows } = await t.pool.query(
      `SELECT p.max_tenants, m.role FROM products p JOIN auth.organization o ON o."productId" = p.id JOIN auth.member m ON m."organizationId" = o.id WHERE p.id = $1 AND m."userId" = $2`,
      [storefront.id, agency.userId],
    );
    expect(rows).toEqual([{ max_tenants: 3, role: 'owner' }]);

    // The token is for /v1/apps only.
    expect((await apps(tokens.access_token, 'GET', '/v1/tenants')).status).toBe(403);
    // A wrong or old token answers 401, so HighLevel refreshes it.
    expect((await apps('not-a-token', 'GET', '/v1/apps/account')).status).toBe(401);
  });

  it('offers no new storefront to someone who has one', async () => {
    const person = await signedIn('member@agency.example');
    const invitation = await (
      await app.request(`/admin/products/${t.productId}/invitations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'member@agency.example', role: 'owner' }),
      })
    ).json();
    await app.request('/api/auth/organization/accept-invitation', {
      method: 'POST',
      headers: { Cookie: person.cookie, 'Content-Type': 'application/json', Origin: AUTH.url },
      body: JSON.stringify({ invitationId: invitation.id }),
    });
    const { oauthQuery, path } = await startInstall(person);
    expect(await (await asUser(person.cookie, 'GET', path)).json()).toMatchObject({ canCreateStorefront: false });
    expect((await asUser(person.cookie, 'POST', '/account/oauth/connect', { oauth_query: oauthQuery, action: 'approve', newStorefront: 'Another' })).status).toBe(400);
  });

  it("refuses an AI app's token, and actions the sign-in doesn't allow", async () => {
    const agency = await signedIn('reader@agency.example');
    // An /mcp token on /v1/apps: refused.
    const mcp = await startInstall(agency, `${BASE}/mcp`);
    const mcpApproval = await asUser(agency.cookie, 'POST', '/account/oauth/connect', { oauth_query: mcp.oauthQuery, action: 'approve', newStorefront: 'Nope' });
    expect(mcpApproval.status).toBe(400);

    const { oauthQuery, verifier } = await startInstall(agency);
    const approved = await asUser(agency.cookie, 'POST', '/account/oauth/connect', { oauth_query: oauthQuery, action: 'approve', newStorefront: 'Reader Sites', scopes: READ_SCOPES });
    const tokens = await finish(((await approved.json()) as { redirectUrl: string }).redirectUrl, verifier);
    const res = await apps(tokens.access_token, 'POST', '/v1/apps/actions/create-site', { data: { name: 'X', email: 'x@example.com' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/tick Stores/);
  });
});

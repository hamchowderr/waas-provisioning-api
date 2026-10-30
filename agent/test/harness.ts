// What both test files share: the API in-process (../src on the test database) with stores whose site
// requests go to `storeFetch`, a "Sign in with your website" token per store, AIMock as the model, and
// the assistant's HTTP app on top.
import { createHash, randomBytes } from 'node:crypto';
import { LLMock } from '@copilotkit/aimock';
import { LibSQLStore } from '@mastra/libsql';
import { StatusCode, WaasClient } from '../../sdk/typescript/src/index.ts';
import { createApiKey } from '../../src/keys.ts';
import { setup, type TestContext } from '../../test/helpers.ts';
import { createAssistant } from '../src/assistant.ts';
import { createServer } from '../src/server.ts';

export const BASE = 'https://api.example.test';

export interface Store {
  id: string;
  domain: string;
  token: string;
}

export interface Harness {
  t: TestContext;
  llm: LLMock;
  app: ReturnType<typeof createServer>;
  stores: Store[];
  /** POST /chat as `store`'s owner (or signed out). */
  chat(store: Store | null, body: unknown): Promise<Response>;
  /** POST /chat/approval as `store`'s owner. */
  answer(store: Store, body: unknown): Promise<Response>;
  /** The model calls `tool` once for `message`, then answers `reply` after seeing the result. */
  script(message: string, tool: string, args: Record<string, unknown>, reply: string): void;
  close(): Promise<void>;
}

export async function startHarness(storeNames: string[], storeFetch: typeof fetch): Promise<Harness> {
  const t = await setup();
  t.deps.config.publicUrl = BASE;
  t.deps.siteFetch = storeFetch;

  const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    return t.app.request(`${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    });
  }) as typeof fetch;

  const { key, secret } = await createApiKey(t.pool, t.productId);
  const waas = new WaasClient({ baseUrl: BASE, apiKey: key, apiSecret: secret, fetch: appFetch });
  const version = await waas.versions.create({ name: 'v1', phpVersion: '8.3', wordPressVersion: '7.1', useCustomUpload: true });
  for (let i = 0; (await waas.versions.list({ versionId: version.id }))[0]?.statusCode !== StatusCode.Done; i++) {
    if (i > 150) throw new Error('version never became Done');
    await new Promise((r) => setTimeout(r, 100));
  }
  await waas.versions.setProduction(version.id!);

  const stores: Store[] = [];
  for (const name of storeNames) {
    await waas.tenants.create({ name, externalId: name });
    const done = await waas.waitForTenant({ externalId: name }, { intervalMs: 100, timeoutMs: 15_000 });
    // An access token as the API's sign-in issues it: this store only, its pages and design only.
    const token = randomBytes(32).toString('base64url');
    await t.pool.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, tenant_id, product_id, scope, resource, legacy_scope, platform_admin, expires_at)
       VALUES ($1, 'access', 'website-assistant-test', $2, $3, 'site:read site:write', $4, false, false, now() + interval '1 hour')`,
      [createHash('sha256').update(token).digest('base64url'), done.id, t.productId, `${BASE}/mcp/site`],
    );
    stores.push({ id: done.id!, domain: done.domainName!, token });
  }

  const llm = new LLMock({ port: 0 });
  await llm.start();
  // Mastra's model router reads <PROVIDER>_BASE_URL, so the assistant speaks Anthropic's API, just to AIMock.
  process.env.ANTHROPIC_BASE_URL = `${llm.url}/v1`;
  const { agent } = createAssistant({ model: 'test-model', anthropicApiKey: 'mock', storage: new LibSQLStore({ id: 'assistant-test', url: ':memory:' }) });
  const app = createServer({ assistant: agent, apiUrl: BASE, fetch: appFetch });

  const post = async (path: string, store: Store | null, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(store ? { authorization: `Bearer ${store.token}` } : {}) },
      body: JSON.stringify(body),
    });

  return {
    t,
    llm,
    app,
    stores,
    chat: (store, body) => post('/chat', store, body),
    answer: (store, body) => post('/chat/approval', store, body),
    script(message, tool, args, reply) {
      llm.on({ userMessage: message, hasToolResult: false }, { toolCalls: [{ name: tool, arguments: args }] });
      llm.on({ userMessage: message, hasToolResult: true }, { content: reply });
    },
    async close() {
      await llm.stop();
      await t.close();
    },
  };
}

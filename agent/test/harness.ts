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
  /** The storefront's Authorization header (its API key and secret). */
  apiAuth: string;
  llm: LLMock;
  app: ReturnType<typeof createServer>;
  stores: Store[];
  /** POST `path` as `store`'s owner (or signed out). */
  post(path: string, store: Store | null, body: unknown): Promise<Response>;
  /** GET `path` as `store`'s owner. */
  get(path: string, store: Store): Promise<Response>;
  /** Starts a message on /agent-controller/stream and reads its events as they come. */
  send(store: Store, body: Record<string, unknown>): Turn;
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
    await waas.tenants.create({ name, externalId: name, wordPressUserName: 'owner', wordPressUserEmail: 'owner@example.com' });
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
  const storage = new LibSQLStore({ id: 'assistant-test', url: ':memory:' });
  const app = createServer({
    createAssistant: (callSite) => createAssistant({ model: 'test-model', anthropicApiKey: 'mock', storage, callSite }),
    apiUrl: BASE,
    fetch: appFetch,
  });

  const auth = (store: Store | null): Record<string, string> => (store ? { authorization: `Bearer ${store.token}` } : {});
  const post = async (path: string, store: Store | null, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(store) }, body: JSON.stringify(body) });
  const get = async (path: string, store: Store) => app.request(path, { headers: auth(store) });

  return {
    t,
    apiAuth: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
    llm,
    app,
    stores,
    post,
    get,
    send: (store, body) => new Turn(post('/agent-controller/stream', store, body)),
    script(message, tool, args, reply) {
      llm.on({ userMessage: message, hasToolResult: false }, { toolCalls: [{ name: tool, arguments: args }] });
      llm.on({ userMessage: message, hasToolResult: true }, { content: reply });
    },
    async close() {
      await app.close();
      await llm.stop();
      await t.close();
    },
  };
}

type Event = { type: string; [key: string]: unknown };

/** One message's server-sent events, read as they arrive. */
export class Turn {
  readonly events: Event[] = [];
  readonly done: Promise<Event[]>;
  status = 0;
  #waiters: (() => void)[] = [];

  constructor(response: Promise<Response>) {
    this.done = (async () => {
      const answer = await response;
      this.status = answer.status;
      if (!answer.ok || !answer.body) {
        this.events.push({ type: 'http', status: answer.status, body: await answer.text() });
        this.#wake();
        return this.events;
      }
      const reader = answer.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/^data: /, '');
          buffer = buffer.slice(end + 2);
          if (line) this.events.push(JSON.parse(line) as Event);
          this.#wake();
        }
      }
      this.#wake();
      return this.events;
    })();
  }

  #wake() {
    for (const wake of this.#waiters.splice(0)) wake();
  }

  /** The first event of `type`, waiting for it if it hasn't come yet. */
  async next(type: string, timeoutMs = 15_000): Promise<Event> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find((event) => event.type === type);
      if (found) return found;
      if (this.events.some((event) => event.type === '__done__' || event.type === 'http') || Date.now() > deadline) {
        throw new Error(`no ${type} event; got ${this.events.map((event) => event.type).join(', ')}`);
      }
      await Promise.race([new Promise<void>((resolve) => this.#waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 200))]);
    }
  }

  /** Everything the assistant wrote, once the turn is done. */
  async text(): Promise<string> {
    await this.done;
    return this.events
      .map((event) => event.event as { type?: string; delta?: string } | undefined)
      .filter((part) => part?.type === 'text-delta')
      .map((part) => part!.delta)
      .join('');
  }

  /** The tool calls waiting for the owner, as the approval cards show them. */
  gates(): { toolCallId: string; toolName: string; summary: string }[] {
    return this.events
      .filter((event) => event.type === 'tool_approval_required')
      .map((event) => ({
        toolCallId: event.toolCallId as string,
        toolName: event.toolName as string,
        summary: (event.preview as { summary: string }).summary,
      }));
  }
}

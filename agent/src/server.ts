// HTTP for the website assistant: the Chat Kit's chat routes (src/chat-server, from mastra-chat-kit's
// `chat-server` registry item), behind the website owner's sign-in.
//
// Every request carries the owner's token from "Sign in with your website" (the API's /mcp/site login).
// The server asks the API which website the token is for; that website's address becomes the request's
// resource id, so threads and waiting changes are kept per website and one owner can't open another's.
// Tool calls then run with the same token, so the API itself keeps the assistant to that one store.
import { createHash } from 'node:crypto';
import { MCPClient } from '@mastra/mcp';
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { Assistant, RecordTokens, StepTokens } from './assistant.js';
import { createControllerRoutes } from './chat-server/routes/controller.js';
import { createThreadRoutes } from './chat-server/routes/threads.js';
import type { ChatServerDeps } from './chat-server/routes/types.js';
import { BUSINESS_FIELDS, describeCall } from './site-tools.js';

export interface ServerDeps {
  /** The assistant, given how its tools reach a website (see `callSite` below). */
  createAssistant: (callSite: (resourceId: string, tool: string, args: Record<string, unknown>) => Promise<unknown>, recordTokens: RecordTokens) => Assistant;
  /** The AnyPress API, e.g. https://api.anypress.io */
  apiUrl: string;
  /** How the site tools are reached (tests answer in-process). */
  fetch?: typeof fetch;
  /** Browser pages allowed to call this server (the chat panel's address). */
  allowedOrigins?: string[];
}

/** The API refused the owner's token: expired, revoked, or not a website sign-in. */
class SignedOut extends Error {}

/** One owner's connection to the site tools. */
interface Connection {
  mcp: MCPClient;
  tools: Record<string, { execute?: (input: unknown, context: unknown) => Promise<unknown> }>;
  resource: string;
  /** The website's address, as the API answered it. */
  url: string;
  checked: number;
}

/** How long a checked token is trusted before the API is asked again. */
const RECHECK_MS = 5 * 60_000;

/**
 * A demo on anypress.io/try signs in with a demo sign-in from the API (src/demo-assistant.ts), not a website's. There is
 * no website behind it: the assistant only changes the page open in the demo's editor (isDemo in assistant.ts).
 */
const DEMO_TOKEN = /^apdemo_[A-Za-z0-9_-]{43}$/;
/** Where demos run: the panel beside a demo's editor only talks to an editor there. */
const DEMO_SITE_URL = 'https://demo.anypress.site';

const bearer = (c: Context) => /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The text a site tool answered, as JSON when it is JSON. A tool error becomes a thrown error. */
function toolAnswer(result: unknown): unknown {
  const answer = result as { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown } | undefined;
  const text = answer?.content?.find((part) => part.type === 'text')?.text;
  if (answer?.isError) throw new Error(text ?? 'The website could not do that.');
  if (text === undefined) return answer?.structuredContent ?? result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createServer(deps: ServerDeps) {
  const fetchImpl = deps.fetch ?? fetch;
  const connections = new Map<string, Connection>();
  /** The newest signed-in connection for each website, used by its tool calls. */
  const byResource = new Map<string, string>();
  /** The newest sign-in token for each website, which its model steps' token counts are sent with. */
  const tokenOf = new Map<string, string>();

  /** A demo's sign-in, checked with the API. A demo has no site tools: its connection only names it. */
  const demos = new Map<string, { resource: string; checked: number }>();
  async function connectDemo(token: string): Promise<{ resource: string; url: string }> {
    const key = hash(token);
    const known = demos.get(key);
    if (!known || Date.now() - known.checked >= RECHECK_MS) {
      const res = await fetchImpl(new URL('/demos/assistant/usage', deps.apiUrl), { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 403) {
        demos.delete(key);
        throw new SignedOut();
      }
      if (!res.ok) throw new Error(`The API answered ${res.status} for a demo.`);
      demos.set(key, { resource: `demo:${key.slice(0, 32)}`, checked: Date.now() });
    }
    return { resource: demos.get(key)!.resource, url: DEMO_SITE_URL };
  }

  async function connect(token: string): Promise<Connection> {
    const key = hash(token);
    const known = connections.get(key);
    if (known && Date.now() - known.checked < RECHECK_MS) return known;
    const mcp = new MCPClient({
      id: `site-${key.slice(0, 16)}-${Date.now()}`,
      servers: {
        site: {
          url: new URL('/mcp/site', deps.apiUrl),
          fetch: (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${token}`);
            return fetchImpl(url, { ...init, headers });
          },
          timeout: 60_000,
        },
      },
    });
    try {
      const { toolsets, errors } = await mcp.listToolsetsWithErrors();
      if (errors.site) throw /\b(401|403)\b|authoriz/i.test(errors.site) ? new SignedOut() : new Error(errors.site);
      const tools = (toolsets.site ?? {}) as Connection['tools'];
      const info = toolAnswer(await tools.get_site?.execute?.({}, {})) as { url?: string } | undefined;
      if (!info?.url) throw new Error('The website did not answer.');
      // One website, one memory: the address the API answered for this token, never one the browser sends.
      const connection = { mcp, tools, resource: `site:${new URL(info.url).host}`, url: info.url, checked: Date.now() };
      if (known) await known.mcp.disconnect().catch(() => {});
      connections.set(key, connection);
      byResource.set(connection.resource, key);
      return connection;
    } catch (error) {
      await mcp.disconnect().catch(() => {});
      if (known) {
        connections.delete(key);
        await known.mcp.disconnect().catch(() => {});
      }
      throw error;
    }
  }

  /** A site tool call, as the owner who signed in for `resourceId`. */
  async function callSite(resourceId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const key = byResource.get(resourceId);
    const connection = key ? connections.get(key) : undefined;
    const run = connection?.tools[tool]?.execute;
    if (!connection || connection.resource !== resourceId || !run) throw new Error('Sign in with your website again.');
    return toolAnswer(await run(args, {}));
  }

  /**
   * Counts one message with the API. The answer when the month's allowance is spent; null when the message may go
   * ahead, also when the API can't be reached, so an owner is never stopped by an outage.
   */
  async function countMessage(token: string): Promise<string | null> {
    try {
      if (DEMO_TOKEN.test(token)) {
        const res = await fetchImpl(new URL('/demos/assistant/usage', deps.apiUrl), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        if (res.status !== 429) return null;
        const usage = (await res.json().catch(() => null)) as { limit?: number } | null;
        return `This demo has used all ${usage?.limit ?? 'its'} assistant messages. Make it your website to keep going: your own website's plan comes with many more.`;
      }
      const res = await fetchImpl(new URL('/oauth/site/assistant-usage', deps.apiUrl), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (res.status !== 429) return null;
      const usage = (await res.json().catch(() => null)) as { limit?: number; resetsAt?: string } | null;
      const resets = usage?.resetsAt ? new Date(usage.resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : 'the first of next month';
      return `You've used all ${usage?.limit ?? 'the'} assistant messages in your plan this month. They start again on ${resets}.`;
    } catch (error) {
      console.error('assistant usage:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  /**
   * Sends one model step's tokens to the API with the website's latest sign-in, without holding up the reply; a
   * failure is only logged. A message, an approval or an answer can each run model steps.
   */
  function recordTokens(resourceId: string, tokens: StepTokens): void {
    const token = tokenOf.get(resourceId);
    // A demo's messages are capped per demo instead (src/demo-assistant.ts in the API).
    if (!token || DEMO_TOKEN.test(token)) return;
    fetchImpl(new URL('/oauth/site/assistant-usage/tokens', deps.apiUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens),
    })
      .then((res) => {
        if (!res.ok) console.error('assistant tokens:', res.status);
      })
      .catch((error) => console.error('assistant tokens:', error instanceof Error ? error.message : error));
  }

  const assistant = deps.createAssistant(callSite, recordTokens);

  const chatDeps: ChatServerDeps = {
    getSession: async (resourceId) => {
      // The auth middleware always sets one; without it there is no website to work on.
      if (!resourceId) throw new Error('No website for this request.');
      return assistant.session(resourceId);
    },
    getAgentController: () => assistant.getController(),
    agentId: 'website-assistant',
    workspace: { root: '', readTree: async () => [], readFile: async () => null },
    getImage: () => undefined,
    getBrowser: async () => {
      throw new Error('The website assistant has no browser.');
    },
    modelAllowlist: new Set(),
    // The approval card's plain sentence, e.g. "Publish page 14".
    approvalPreview: async ({ toolName, args }) => ({ summary: describeCall(toolName, (args ?? {}) as Record<string, unknown>) }),
  };

  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));

  /** The website (or demo) a token signs in to, or why it can't. */
  async function signIn(token: string, demo: boolean): Promise<{ connection: { resource: string; url: string } } | { refused: string; status: 401 | 502 }> {
    try {
      return { connection: demo ? await connectDemo(token) : await connect(token) };
    } catch (error) {
      if (error instanceof SignedOut) return { refused: demo ? 'This demo has ended. Start it again to keep going.' : 'Sign in with your website again.', status: 401 };
      return { refused: demo ? 'The assistant can’t be reached right now. Try again in a minute.' : 'The website can’t be reached right now. Try again in a minute.', status: 502 };
    }
  }

  app.use('/agent-controller/*', async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin && deps.allowedOrigins?.includes(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Headers', 'authorization, content-type');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
      c.header('Vary', 'Origin');
      if (c.req.method === 'OPTIONS') return c.body(null, 204);
    }
    const token = bearer(c);
    if (!token) return c.json({ error: 'Sign in with your website first.' }, 401);
    const demo = DEMO_TOKEN.test(token);
    const signed = await signIn(token, demo);
    if ('refused' in signed) return c.json({ error: signed.refused }, signed.status);
    const { connection } = signed;
    if (!demo) byResource.set(connection.resource, hash(token));
    tokenOf.set(connection.resource, token);
    // Each message the owner sends counts against the store's monthly allowance, which the API keeps per plan size.
    if (c.req.method === 'POST' && c.req.path === '/agent-controller/stream') {
      const refused = await countMessage(token);
      if (refused) return c.json({ error: refused }, 429);
    }
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_RESOURCE_ID_KEY, connection.resource);
    c.set('requestContext' as never, requestContext as never);
    c.set('siteUrl' as never, connection.url as never);
    c.set('resource' as never, connection.resource as never);
    c.set('demo' as never, demo as never);
    await next();
  });

  // The signed-in website's address. The panel beside the page editor only talks to an editor there.
  app.get('/agent-controller/site', (c) => c.json({ url: c.get('siteUrl' as never) as string }));

  // This month's messages for the website ({ used, limit, resetsAt }), for the panel's "messages left". Empty when
  // the API can't be reached: the panel then shows nothing rather than a wrong number.
  app.get('/agent-controller/usage', async (c) => {
    try {
      const path = c.get('demo' as never) ? '/demos/assistant/usage' : '/oauth/site/assistant-usage';
      const res = await fetchImpl(new URL(path, deps.apiUrl), { headers: { Authorization: `Bearer ${bearer(c)}` } });
      if (!res.ok) return c.json({});
      const usage = (await res.json()) as { used?: number; limit?: number; resetsAt?: string };
      return c.json({ used: usage.used, limit: usage.limit, resetsAt: usage.resetsAt });
    } catch {
      return c.json({});
    }
  });

  // What the website and its owner say about the business, for the panel's "About your business", where the owner
  // checks it and corrects their own facts (business.ts). The owner typing it is their yes, so a save here doesn't
  // wait for an approval the way the assistant's own business_profile_change does.
  const business = async (c: Context, args: Record<string, unknown>) => {
    const resource = c.get('resource' as never) as string;
    // A demo has no website to keep the details: nothing to show, and nowhere to save.
    if (c.get('demo' as never)) return args.action === 'read' ? c.json({}) : c.json({ error: 'A demo can’t keep these details. Make it your website first.' }, 409);
    try {
      const answer = await callSite(resource, 'business_profile', args);
      if (args.action !== 'read') assistant.forgetBusiness(resource);
      return c.json(answer as object);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A website whose AnyPress Client predates the profile answers 404 for the route.
      const old = /\b404\b|rest_no_route/i.test(message);
      return c.json({ error: old ? 'Your website needs an update before it can keep these details.' : 'Your website couldn’t answer just now. Try again in a minute.' }, old ? 409 : 502);
    }
  };
  app.get('/agent-controller/business', (c) => business(c, { action: 'read' }));
  app.patch('/agent-controller/business', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { about?: Record<string, unknown> } | null;
    const about = Object.fromEntries(
      Object.entries(body?.about ?? {})
        .filter(([key, value]) => key in BUSINESS_FIELDS && typeof value === 'string')
        .map(([key, value]) => [key, (value as string).slice(0, 1500)]),
    );
    if (!Object.keys(about).length) return c.json({ error: `Send about with at least one of: ${Object.keys(BUSINESS_FIELDS).join(', ')}.` }, 400);
    return business(c, { action: 'save', about });
  });

  // Goals, observational memory, schedules, workspace and browser are Chat Kit features the
  // assistant doesn't use; only the chat, its threads and its approvals are served.
  const SERVED = /^\/agent-controller\/(stream|approve|answer|abort|threads)/;
  for (const route of [...createControllerRoutes(chatDeps), ...createThreadRoutes(chatDeps)]) {
    if (!('path' in route) || !SERVED.test(route.path)) continue;
    const { path, method, handler, middleware } = route as unknown as {
      path: string;
      method: string;
      handler: (c: Context) => Promise<Response> | Response;
      middleware?: MiddlewareHandler | MiddlewareHandler[];
    };
    const before = [middleware ?? []].flat();
    app.on(method.toUpperCase(), [path], ...before, (c: Context) => handler(c));
  }

  return Object.assign(app, { assistant, close: async () => {
    await assistant.destroy();
    await Promise.all([...connections.values()].map((connection) => connection.mcp.disconnect().catch(() => {})));
  } });
}

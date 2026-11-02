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
import type { Assistant } from './assistant.js';
import { createControllerRoutes } from './chat-server/routes/controller.js';
import { createThreadRoutes } from './chat-server/routes/threads.js';
import type { ChatServerDeps } from './chat-server/routes/types.js';
import { BUSINESS_FIELDS, describeCall } from './site-tools.js';

export interface ServerDeps {
  /** The assistant, given how its tools reach a website (see `callSite` below). */
  createAssistant: (callSite: (resourceId: string, tool: string, args: Record<string, unknown>) => Promise<unknown>) => Assistant;
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
      const res = await fetchImpl(new URL('/oauth/site/assistant-usage', deps.apiUrl), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (res.status !== 429) return null;
      const usage = (await res.json().catch(() => null)) as { limit?: number; resetsAt?: string } | null;
      const resets = usage?.resetsAt ? new Date(usage.resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : 'the first of next month';
      return `You've used all ${usage?.limit ?? 'the'} assistant messages in your plan this month. They start again on ${resets}. A bigger plan gets more.`;
    } catch (error) {
      console.error('assistant usage:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  const assistant = deps.createAssistant(callSite);

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
    let connection: Connection;
    try {
      connection = await connect(token);
    } catch (error) {
      const signedOut = error instanceof SignedOut;
      return c.json({ error: signedOut ? 'Sign in with your website again.' : 'The website can’t be reached right now. Try again in a minute.' }, signedOut ? 401 : 502);
    }
    byResource.set(connection.resource, hash(token));
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
    await next();
  });

  // The signed-in website's address. The panel beside the page editor only talks to an editor there.
  app.get('/agent-controller/site', (c) => c.json({ url: c.get('siteUrl' as never) as string }));

  // This month's messages for the website ({ used, limit, resetsAt }), for the panel's "messages left". Empty when
  // the API can't be reached: the panel then shows nothing rather than a wrong number.
  app.get('/agent-controller/usage', async (c) => {
    try {
      const res = await fetchImpl(new URL('/oauth/site/assistant-usage', deps.apiUrl), { headers: { Authorization: `Bearer ${bearer(c)}` } });
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
    try {
      const answer = await callSite(resource, 'business_profile', args);
      if (args.action !== 'read') assistant.forgetBusiness(resource);
      return c.json(answer as object);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A website whose WaaS Client predates the profile answers 404 for the route.
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

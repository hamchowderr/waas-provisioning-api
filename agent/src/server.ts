// HTTP for the website assistant. Every request carries the website owner's token from "Sign in with your
// website" (the API's /mcp/site login). The assistant uses that token for the site tools, so the API itself
// decides which store it reaches: the token works for one store, and only for its pages and design.
// Conversations and paused approvals are kept per store, keyed by the address the API answers with.
import { createHash } from 'node:crypto';
import { MCPClient } from '@mastra/mcp';
import { Hono, type Context } from 'hono';
import { describeCall, needsApproval, SITE_TOOLS } from './approval.js';
import type { Assistant } from './assistant.js';

export interface ServerDeps {
  assistant: Assistant;
  /** The AnyPress API, e.g. https://api.anypress.io */
  apiUrl: string;
  /** How the site tools are reached (tests answer in-process). */
  fetch?: typeof fetch;
}

interface Pending {
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

/** The API refused the owner's token: expired, revoked, or not a website sign-in. */
class SignedOut extends Error {}

type Reply = { conversation: string; text: string; pending: Pending[] };

const bearer = (c: Context) => /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];

/** Only the site tools, even if the server offers more. */
function siteToolsOnly<T extends Record<string, unknown>>(tools: T): T {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => (SITE_TOOLS as readonly string[]).includes(name))) as T;
}

/** The text a site tool answered, as JSON when it is JSON. */
function toolAnswer(result: unknown): unknown {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  const text = content?.find((part) => part.type === 'text')?.text;
  if (text === undefined) return (result as { structuredContent?: unknown })?.structuredContent ?? result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();
  const fetchImpl = deps.fetch ?? fetch;

  /** Connects to the site tools as the owner and works out which store they're for. */
  async function connect(token: string) {
    const mcp = new MCPClient({
      id: `site-${createHash('sha256').update(token).digest('hex').slice(0, 16)}-${Date.now()}`,
      servers: {
        site: {
          url: new URL('/mcp/site', deps.apiUrl),
          fetch: (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${token}`);
            return fetchImpl(url, { ...init, headers });
          },
          requireToolApproval: ({ toolName, args }) => needsApproval(toolName, args),
          timeout: 60_000,
        },
      },
    });
    try {
      const { toolsets, errors } = await mcp.listToolsetsWithErrors();
      if (errors.site) throw /\b(401|403)\b|authoriz/i.test(errors.site) ? new SignedOut() : new Error(errors.site);
      const site = siteToolsOnly(toolsets.site ?? {});
      const getSite = site.get_site as { execute?: (input: unknown, context: unknown) => Promise<unknown> } | undefined;
      if (!getSite?.execute) throw new Error('The site tools are not available for this sign-in.');
      const info = toolAnswer(await getSite.execute({}, {})) as { url?: string } | undefined;
      if (!info?.url) throw new Error('The website did not answer.');
      // One store, one memory: the address the API answered for this token, never one the browser sends.
      const resource = `site:${new URL(info.url).host}`;
      return { mcp, toolsets: { site }, resource };
    } catch (error) {
      await mcp.disconnect().catch(() => {});
      throw error;
    }
  }

  /** A conversation id the browser can keep; stored under the store's own name so it can't open another store's. */
  const threadOf = (resource: string, conversation: string) => `${resource}:${conversation}`;

  async function pendingFor(resource: string, conversation: string): Promise<Pending[]> {
    const { runs } = await deps.assistant.listSuspendedRuns({ resourceId: resource, threadId: threadOf(resource, conversation) });
    return runs.flatMap((run) =>
      run.toolCalls
        .filter((call) => call.requiresApproval && call.toolCallId && call.toolName)
        .map((call) => {
          const args = (call.args ?? {}) as Record<string, unknown>;
          return { toolCallId: call.toolCallId!, tool: call.toolName!, args, summary: describeCall(call.toolName!, args) };
        }),
    );
  }

  async function withSite<T>(c: Context, run: (site: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<Response> {
    const token = bearer(c);
    if (!token) return c.json({ error: 'Sign in with your website first.' }, 401);
    let site: Awaited<ReturnType<typeof connect>>;
    try {
      site = await connect(token);
    } catch (error) {
      const signedOut = error instanceof SignedOut;
      return c.json({ error: signedOut ? 'Sign in with your website again.' : 'The website can’t be reached right now. Try again in a minute.' }, signedOut ? 401 : 502);
    }
    try {
      return c.json((await run(site)) as object);
    } finally {
      await site.mcp.disconnect().catch(() => {});
    }
  }

  app.get('/health', (c) => c.json({ ok: true }));

  // { message, conversation? } → the reply, plus any changes waiting for the owner's yes.
  app.post('/chat', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { message?: unknown; conversation?: unknown };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 4000) return c.json({ error: 'Write a message of up to 4,000 characters.' }, 400);
    const conversation = typeof body.conversation === 'string' && /^[\w-]{1,64}$/.test(body.conversation) ? body.conversation : crypto.randomUUID();
    return withSite(c, async ({ toolsets, resource }): Promise<Reply> => {
      const output = await deps.assistant.generate(message, {
        toolsets,
        memory: { resource, thread: threadOf(resource, conversation) },
      });
      return { conversation, text: output.text, pending: await pendingFor(resource, conversation) };
    });
  });

  // { conversation, toolCallId, approve, reason? } → the owner's answer to a waiting change.
  app.post('/chat/approval', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { conversation?: unknown; toolCallId?: unknown; approve?: unknown; reason?: unknown };
    if (typeof body.conversation !== 'string' || typeof body.toolCallId !== 'string' || typeof body.approve !== 'boolean') {
      return c.json({ error: 'Send conversation, toolCallId and approve.' }, 400);
    }
    const { conversation, toolCallId, approve } = body as { conversation: string; toolCallId: string; approve: boolean };
    return withSite(c, async ({ toolsets, resource }): Promise<Reply | { error: string }> => {
      const thread = threadOf(resource, conversation);
      const { runs } = await deps.assistant.listSuspendedRuns({ resourceId: resource, threadId: thread });
      const run = runs.find((r) => r.toolCalls.some((call) => call.toolCallId === toolCallId && call.requiresApproval));
      if (!run) return { error: 'That change is no longer waiting.' };
      const options = { runId: run.runId, toolCallId, toolsets, memory: { resource, thread } };
      const output = approve
        ? await deps.assistant.approveToolCallGenerate(options)
        : await deps.assistant.declineToolCallGenerate({ ...options, ...(typeof body.reason === 'string' ? { reason: body.reason.slice(0, 500) } : {}) });
      return { conversation, text: output.text, pending: await pendingFor(resource, conversation) };
    });
  });

  return app;
}

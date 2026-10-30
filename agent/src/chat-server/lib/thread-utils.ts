import { START_THREAD_TOOL } from './work-thread-info';

/**
 * Helpers for the chat-history sidebar thread routes. Mastra message content is
 * heterogeneous (string | { parts } | array), so these normalize it for display.
 */

// biome-ignore lint/suspicious/noExplicitAny: Mastra message content is heterogeneous
export function messageText(m: any): string {
  const content = m?.content;
  if (typeof content === 'string') {
    return content;
  }
  // biome-ignore lint/suspicious/noExplicitAny: part union
  const parts: any[] | undefined = Array.isArray(content?.parts)
    ? content.parts
    : Array.isArray(content)
      ? content
      : undefined;
  if (parts) {
    return parts
      .map((p) => {
        // Assistant text arrives as a text part; the user's own turn (Mastra core
        // ≥1.52 "format 2") arrives as a data-user-message part with the text on
        // data.contents.
        if (p?.type === 'text' && typeof p.text === 'string') return p.text;
        if (p?.type === 'data-user-message' && typeof p?.data?.contents === 'string') {
          return p.data.contents;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  if (typeof content?.text === 'string') {
    return content.text;
  }
  return '';
}

/** Thread display title: explicit title → first user message snippet → "New chat". */
// biome-ignore lint/suspicious/noExplicitAny: StorageThreadType
export function threadTitle(thread: any, firstUserMessage?: string): string {
  const title = typeof thread?.title === 'string' ? thread.title.trim() : '';
  if (title) {
    return title;
  }
  const fm = (firstUserMessage ?? '').trim();
  if (fm) {
    return fm.split(/\s+/).slice(0, 8).join(' ');
  }
  return 'New chat';
}

/** `suggest_threads` (work-thread-steering.ts), named here so this file does not import that one. */
const SUGGEST_THREADS = 'suggest_threads';

/** A thread a `start_thread` call made, as a restored message carries it. */
type WorkThreadPart = { type: 'data-work-thread'; data: { threadId: string; title: string } };
/** The threads a `suggest_threads` call offered, as a restored message carries them. */
type SuggestionsPart = {
  type: 'data-thread-suggestions';
  data: { suggestions: Array<{ title: string; why: string }> };
};

/**
 * A UIMessage (AI SDK v7 parts shape) for restoring a thread into the chat UI: its text,
 * plus one `data-work-thread` part per thread a `start_thread` call made in it
 * (lib/work-threads.ts), so a restored main chat still shows the thread it started where
 * it started it, one `data-thread-suggestions` part per `suggest_threads` card, and one
 * `data-tool-call` part per other finished tool call, so its step card shows again.
 */
// biome-ignore lint/suspicious/noExplicitAny: MastraDBMessage
export function toUIMessage(m: any): {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<{ type: 'text'; text: string } | WorkThreadPart | SuggestionsPart | ToolCallPart>;
} {
  const parts: unknown[] = Array.isArray(m?.content?.parts) ? (m.content.parts as unknown[]) : [];
  const text = messageText(m);
  // An assistant turn keeps its order: the steps it took (tool cards) where it took them, then
  // what it said. Anything else is its text.
  const ordered =
    m?.role === 'assistant' && parts.some((p) => (p as { type?: string }).type === 'tool-invocation')
      ? parts.flatMap((p): Array<{ type: 'text'; text: string } | WorkThreadPart | SuggestionsPart | ToolCallPart> => {
          const part = p as { type?: string; text?: unknown };
          if (part.type === 'text') return typeof part.text === 'string' && part.text ? [{ type: 'text', text: part.text }] : [];
          return toolParts(p);
        })
      : [{ type: 'text' as const, text }, ...parts.flatMap(toolParts)];
  return {
    id: String(m?.id ?? `${m?.threadId ?? 't'}-${m?.createdAt ?? Math.random()}`),
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    parts: ordered,
  };
}

/** A finished tool call, restored so its step card shows again (the client turns it back into a call and result). */
type ToolCallPart = {
  type: 'data-tool-call';
  data: { id: string; name: string; args: unknown; result: unknown };
};

/** Tools whose cards have their own surfaces (the live question, the goal, the plan) and are not restored. */
const NOT_RESTORED = new Set(['ask_user', 'setGoal', 'submit_plan']);

/** One stored part's restored cards: a thread `start_thread` made, a `suggest_threads` card, or a finished step. */
function toolParts(p: unknown): Array<WorkThreadPart | SuggestionsPart | ToolCallPart> {
  const call = (p as { type?: string; toolInvocation?: Record<string, unknown> }).toolInvocation;
  if ((p as { type?: string }).type !== 'tool-invocation' || !call) return [];
  if (call.toolName === SUGGEST_THREADS) {
    // Only a card the tool accepted: a refused or unfinished call offered nothing.
    const offered = (call.result as { suggested?: unknown } | undefined)?.suggested;
    return call.state === 'result' && Array.isArray(offered) ? suggestionsOf(call.args) : [];
  }
  if (call.toolName !== START_THREAD_TOOL) {
    if (call.state !== 'result' || typeof call.toolName !== 'string' || NOT_RESTORED.has(call.toolName)) return [];
    return [
      {
        type: 'data-tool-call' as const,
        data: { id: String(call.toolCallId ?? ''), name: call.toolName, args: call.args, result: call.result },
      },
    ];
  }
  const result = call.result as { threadId?: unknown; title?: unknown } | undefined;
  if (typeof result?.threadId !== 'string') return [];
  return [
    {
      type: 'data-work-thread' as const,
      data: {
        threadId: result.threadId,
        title: typeof result.title === 'string' ? result.title : '',
      },
    },
  ];
}

/** A `suggest_threads` call's titles and reasons (the briefs stay in the agent's history). */
function suggestionsOf(args: unknown): SuggestionsPart[] {
  const threads = (args as { threads?: unknown } | undefined)?.threads;
  if (!Array.isArray(threads)) return [];
  const suggestions = threads.flatMap((t) => {
    const { title, why } = (t ?? {}) as { title?: unknown; why?: unknown };
    return typeof title === 'string' && title.trim()
      ? [{ title, why: typeof why === 'string' ? why : '' }]
      : [];
  });
  return suggestions.length > 0
    ? [{ type: 'data-thread-suggestions' as const, data: { suggestions } }]
    : [];
}

/** A short, query-centered excerpt for search results. */
export function searchSnippet(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i === -1) {
    return text.slice(0, 100);
  }
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + query.length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

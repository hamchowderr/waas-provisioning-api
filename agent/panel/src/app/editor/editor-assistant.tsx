'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatPanel } from '@/components/chat-panel/chat-panel';
import type { AgentControllerToolEnd } from '@/lib/agent-controller/use-agent-controller-chat';
import { approvalViews, toolTitles } from '../assistant';
import { withBase } from '@/lib/base-path';

// Messages between this page and the editor that frames it (WaaS Client's editor-assistant.js).
// From the editor: { source: 'site-editor', type: 'view', view } with what it has open.
// To the editor: { source: 'site-assistant', type: 'ready' | 'apply' | 'sign-in', ... }.
// Only the signed-in website's own address is listened to and written to. WaaS Client before 2.12
// frames the panel's own address and uses the names of before (`older`); 2.12 understands both.
const FROM_EDITOR = new Set(['site-editor', 'anypress-editor']);
const toEditor = (older: boolean) => (older ? 'anypress-assistant' : 'site-assistant');

const framed = () => typeof window !== 'undefined' && window.parent !== window;

/** Signed out inside the editor: the editor gets a sign-in from the website and reloads this frame with it. */
export function EditorSignIn({ error, older }: { error?: string; older: boolean }) {
  useEffect(() => {
    // Nothing private in it, so any parent may hear it; only the website's own editor can answer it.
    if (framed() && !error) window.parent.postMessage({ source: toEditor(older), type: 'sign-in' }, '*');
  }, [error, older]);
  return (
    <main className="flex flex-1 items-center justify-center p-6 text-center">
      <p className="max-w-xs text-sm text-muted-foreground">
        {error ?? (framed() ? 'Signing you in…' : 'Open the assistant from your website’s editor.')}
      </p>
    </main>
  );
}

/** The chat, sending the editor's view with each message and handing its editor changes back. */
export function EditorAssistant({ older }: { older: boolean }) {
  const [site, setSite] = useState<string | null>(null);
  const view = useRef<unknown>(undefined);

  useEffect(() => {
    let live = true;
    fetch(withBase('/api/agent-controller/site'))
      .then((response) => (response.ok ? (response.json() as Promise<{ url?: string }>) : {}))
      .then((answer: { url?: string }) => {
        if (live && answer.url) setSite(new URL(answer.url).origin);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!site || !framed()) return;
    const listen = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== site) return;
      const data = event.data as { source?: string; type?: string; view?: unknown } | null;
      if (data?.source && FROM_EDITOR.has(data.source) && data.type === 'view') view.current = data.view;
    };
    window.addEventListener('message', listen);
    window.parent.postMessage({ source: toEditor(older), type: 'ready' }, site);
    return () => window.removeEventListener('message', listen);
  }, [site, older]);

  const extra = useCallback(() => (view.current ? { editor: view.current } : undefined), []);
  const onToolEnd = useCallback(
    (tool: AgentControllerToolEnd) => {
      const change = (tool.result as { editor?: unknown } | undefined)?.editor;
      if (tool.toolName !== 'editor_change' || tool.isError || !change || !site || !framed()) return;
      window.parent.postMessage({ source: toEditor(older), type: 'apply', id: tool.toolCallId, change }, site);
    },
    [site, older],
  );

  return (
    <ChatPanel
      className="h-full min-h-0 flex-1"
      // WordPress's panel above already says "Assistant"; the header keeps only its history and new-chat buttons.
      title={null}
      plan={false}
      placeholder="Ask for a change…"
      greeting={{ title: 'What should we change?', description: 'Select a block and ask. Changes show here in the editor; press Save to keep them.' }}
      suggestions={[
        { label: 'Rewrite the selected block', prompt: 'Rewrite the selected block so it is warmer and shorter.' },
        { label: 'Add an FAQ section', prompt: 'Add an FAQ section with four common questions at the end of this page.' },
        { label: 'Improve this page', prompt: 'Read this page and suggest three improvements.' },
      ]}
      approvalViews={approvalViews}
      toolTitles={{ ...toolTitles, editor_change: 'Page edited' }}
      extra={extra}
      onToolEnd={onToolEnd}
    />
  );
}

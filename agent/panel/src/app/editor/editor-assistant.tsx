'use client';

import { Maximize2Icon, Minimize2Icon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
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

type Selected = { clientId: string; name: string } | null;
type EditorView = { selected?: Selected; phone?: boolean };

/** A block's name as the owner knows it: core/heading → "Heading". */
const BLOCK_NAMES: Record<string, string> = {
  'core/paragraph': 'Paragraph',
  'core/heading': 'Heading',
  'core/image': 'Image',
  'core/cover': 'Cover',
  'core/group': 'Section',
  'core/columns': 'Columns',
  'core/column': 'Column',
  'core/buttons': 'Buttons',
  'core/button': 'Button',
  'core/list': 'List',
  'core/quote': 'Quote',
  'core/gallery': 'Gallery',
  'core/media-text': 'Media and text',
  'core/navigation': 'Menu',
  'core/site-logo': 'Logo',
  'core/site-title': 'Site title',
  'core/template-part': 'Header or footer',
  'core/details': 'FAQ item',
};
export function blockName(name: string): string {
  if (BLOCK_NAMES[name]) return BLOCK_NAMES[name];
  const last = name.split('/').pop() ?? name;
  return last.charAt(0).toUpperCase() + last.slice(1).replace(/-/g, ' ');
}

type Suggestion = { label: string; prompt: string };
const TEXT_BLOCKS = new Set(['core/paragraph', 'core/heading', 'core/list', 'core/quote', 'core/button', 'core/buttons', 'core/details']);
const IMAGE_BLOCKS = new Set(['core/image', 'core/cover', 'core/media-text', 'core/gallery', 'core/site-logo']);

/** Ideas for an empty chat that fit what is selected. */
export function suggestionsFor(selected: Selected): Suggestion[] {
  if (selected && TEXT_BLOCKS.has(selected.name)) {
    return [
      { label: 'Make it shorter', prompt: 'Make the selected block shorter and clearer.' },
      { label: 'Make it friendlier', prompt: 'Rewrite the selected block so it sounds warmer and friendlier.' },
      { label: 'Fix spelling and grammar', prompt: 'Fix any spelling and grammar in the selected block. Keep the meaning.' },
      { label: 'Translate to Spanish', prompt: 'Translate the selected block into Spanish.' },
    ];
  }
  if (selected && IMAGE_BLOCKS.has(selected.name)) {
    return [
      { label: 'Describe this image', prompt: 'Write alt text for the selected image so people using screen readers know what it shows.' },
      { label: 'Change the words on it', prompt: 'Suggest better text for the selected block and change it.' },
      { label: 'Add a section below', prompt: 'Add a section below the selected block that fits this page.' },
    ];
  }
  if (selected) {
    return [
      { label: 'Rewrite this section', prompt: 'Rewrite the text in the selected section so it is clearer and sounds like my business.' },
      { label: 'Add a section below', prompt: 'Add a section below the selected one that fits this page.' },
      { label: 'Remove this section', prompt: 'Remove the selected section.' },
    ];
  }
  return [
    { label: 'Improve this page', prompt: 'Read this page and suggest three improvements, then make the one I pick.' },
    { label: 'Add an FAQ section', prompt: 'Add an FAQ section with four questions my customers would ask, at the end of this page.' },
    { label: 'Add opening hours', prompt: 'Add a section with my opening hours and how to reach me.' },
  ];
}

type Usage = { used?: number; limit?: number };

/** "128 messages left" in the chat's header, once the month's count is known. */
function MessagesLeft({ usage }: { usage: Usage | null }) {
  if (!usage || typeof usage.used !== 'number' || typeof usage.limit !== 'number') return null;
  const left = Math.max(0, usage.limit - usage.used);
  return (
    <span className={`font-normal text-xs ${left <= usage.limit * 0.1 ? 'text-amber-700' : 'text-muted-foreground'}`} title={`${usage.used} of ${usage.limit} messages used this month`}>
      {left} {left === 1 ? 'message' : 'messages'} left this month
    </span>
  );
}

/** The chat, sending the editor's view with each message and handing its editor changes back. */
export function EditorAssistant({ older }: { older: boolean }) {
  const [site, setSite] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [phone, setPhone] = useState(false);
  const [wide, setWide] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
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

  const refreshUsage = useCallback(() => {
    fetch(withBase('/api/agent-controller/usage'))
      .then((response) => (response.ok ? (response.json() as Promise<Usage>) : null))
      .then((answer) => setUsage(answer))
      .catch(() => {});
  }, []);
  useEffect(refreshUsage, [refreshUsage]);

  const tell = useCallback(
    (message: Record<string, unknown>) => {
      if (site && framed()) window.parent.postMessage({ source: toEditor(older), ...message }, site);
    },
    [site, older],
  );

  useEffect(() => {
    if (!site || !framed()) return;
    const listen = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== site) return;
      const data = event.data as { source?: string; type?: string; view?: EditorView } | null;
      if (data?.source && FROM_EDITOR.has(data.source) && data.type === 'view') {
        view.current = data.view;
        const next = data.view?.selected ?? null;
        setSelected((now) => (now?.clientId === next?.clientId ? now : next ? { clientId: next.clientId, name: next.name } : null));
        setPhone(Boolean(data.view?.phone));
      }
    };
    window.addEventListener('message', listen);
    window.parent.postMessage({ source: toEditor(older), type: 'ready' }, site);
    return () => window.removeEventListener('message', listen);
  }, [site, older]);

  // Ctrl + . (⌘ + . on a Mac) inside the chat opens and closes the panel, as it does in the editor.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === '.' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        tell({ type: 'toggle' });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [tell]);

  const extra = useCallback(() => (view.current ? { editor: view.current } : undefined), []);
  const onToolEnd = useCallback(
    (tool: AgentControllerToolEnd) => {
      const change = (tool.result as { editor?: unknown } | undefined)?.editor;
      if (tool.toolName !== 'editor_change' || tool.isError || !change) return;
      tell({ type: 'apply', id: tool.toolCallId, change });
    },
    [tell],
  );

  const toggleWide = () => {
    setWide((now) => {
      tell({ type: 'width', wide: !now });
      return !now;
    });
  };

  const chip = selected ? (
    <div className="flex w-full items-center gap-1 px-1 pt-1">
      <span className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/60 py-0.5 pr-0.5 pl-2 text-xs">
        <span className="text-muted-foreground">Selected:</span>
        <span className="truncate font-medium">{blockName(selected.name)}</span>
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label="Clear the selection"
          onClick={() => {
            setSelected(null);
            tell({ type: 'clear-selection' });
          }}
        >
          <XIcon className="size-3" />
        </button>
      </span>
    </div>
  ) : null;

  return (
    <ChatPanel
      className="h-full min-h-0 flex-1"
      // WordPress's panel above already says "Assistant"; the header shows the messages left, history and new chat.
      title={<MessagesLeft usage={usage} />}
      actions={
        phone ? undefined : (
          <Button variant="ghost" size="icon" className="size-8" aria-label={wide ? 'Narrower panel' : 'Wider panel'} onClick={toggleWide}>
            {wide ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
          </Button>
        )
      }
      plan={false}
      placeholder={selected ? `Ask about this ${blockName(selected.name).toLowerCase()}…` : 'Ask for a change…'}
      greeting={{ title: 'What should we change?', description: 'Select a block and ask, or pick an idea. Changes show here in the editor; press Save to keep them.' }}
      suggestions={suggestionsFor(selected)}
      approvalViews={approvalViews}
      toolTitles={{ ...toolTitles, editor_change: 'Page edited' }}
      extra={extra}
      onToolEnd={onToolEnd}
      onTurnEnd={refreshUsage}
      composerHeader={chip}
    />
  );
}

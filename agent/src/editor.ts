// The page editor beside the chat (WaaS Client's Assistant panel in the block editor and the Site
// Editor). With each message the editor sends what it has open: the page, its top-level blocks and
// the block the owner selected. The assistant changes that open page with `editor_change`, whose
// answer the panel hands back to the editor: the change shows there at once, can be undone, and is
// kept only when the owner saves. Nothing here reaches the website itself.
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/** Where the editor's view rides in a turn's request context. */
export const EDITOR_KEY = 'editor';

/** At most this many characters of block markup reach the model per turn; the rest is named only. */
const MARKUP_BUDGET = 60_000;

const clientId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const block = z.object({
  clientId,
  name: z.string().max(100),
  markup: z.string().max(40_000).default(''),
});

const editorSchema = z.object({
  /** The page and post editor, or the Site Editor (templates, template parts, patterns). */
  screen: z.enum(['post', 'site']),
  postType: z.string().max(60),
  postId: z.union([z.number().int(), z.string().max(200)]),
  title: z.string().max(300).default(''),
  blocks: z.array(block).max(200).default([]),
  selected: block.nullish(),
});

export type EditorView = z.infer<typeof editorSchema>;

/** The editor's view from a request body: an odd one reads as absent, never a reason to refuse the turn. */
export function readEditor(value: unknown): EditorView | undefined {
  const parsed = editorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function editorOf(requestContext: RequestContext | undefined): EditorView | undefined {
  return requestContext?.get(EDITOR_KEY) as EditorView | undefined;
}

/** What the model is told about the open editor this turn. */
export function describeEditor(view: EditorView): string {
  let budget = MARKUP_BUDGET;
  const shown = (markup: string) => {
    if (!markup || markup.length > budget) return '(markup not shown; ask the owner to select it)';
    budget -= markup.length;
    return markup;
  };
  const selected = view.selected
    ? `The owner selected the block ${view.selected.clientId} (${view.selected.name}):\n${shown(view.selected.markup)}`
    : 'No block is selected.';
  const blocks = view.blocks.map((b, i) => `[${i}] ${b.clientId} ${b.name}\n${shown(b.markup)}`).join('\n\n');
  const what = view.screen === 'site' ? `the Site Editor, on the ${view.postType.replace(/^wp_/, '').replace('_', ' ')} "${view.title}"` : `the editor, on the ${view.postType} "${view.title}" (id ${view.postId})`;
  return `## The open editor

The owner is in ${what}. Change what is open there with editor_change: the change shows in their editor at once, they can undo it, and it is kept when they press Save. Don't change this ${view.screen === 'site' ? 'template' : 'page'} with site_pages_change, page_section or header_footer_change while it is open, or the owner's editor and the website would disagree. Tell the owner to press Save when they are happy.

When the owner says "this", "here" or "it" they mean the selected block. ${selected}

Its top-level blocks, in order (client id, then name and markup):

${blocks || '(empty)'}`;
}

const blocks = z.string().describe('WordPress block markup. Use the theme’s colour, font-size and spacing slugs from site_styles, not raw values.');

export const EDITOR_TOOLS = ['editor_change'] as const;

export function createEditorTools() {
  return {
    editor_change: createTool({
      id: 'editor_change',
      description:
        'Change the page open in the owner’s editor (only when the instructions describe an open editor). The change shows there at once and is kept when the owner saves. Actions: replace (the block clientId with content: copy its markup and change only what was asked); insert (content before or after the block clientId, or at the end without one); remove (the block clientId); replace_all (the whole page’s content).',
      inputSchema: z.object({
        action: z.enum(['replace', 'insert', 'remove', 'replace_all']),
        clientId: clientId.optional().describe('A client id from the open editor’s blocks'),
        position: z.enum(['before', 'after']).optional().describe('For insert'),
        content: blocks.optional(),
      }),
      execute: async (args, context) => {
        const view = editorOf(context?.requestContext as RequestContext | undefined);
        if (!view) throw new Error('No editor is open. Ask the owner to open the page in the editor, or change it with the site tools.');
        const { action, clientId: id, position, content } = args;
        if (action !== 'replace_all' && action !== 'insert' && !id) throw new Error(`${action} needs the block's clientId.`);
        if (action !== 'remove' && !content?.trim()) throw new Error(`${action} needs content.`);
        const known = new Set([...view.blocks.map((b) => b.clientId), ...(view.selected ? [view.selected.clientId] : [])]);
        if (id && !known.has(id)) throw new Error(`The open editor has no block ${id}. Use a client id from its blocks.`);
        return {
          editor: { action, ...(id ? { clientId: id } : {}), ...(action === 'insert' ? { position: position ?? 'after' } : {}), ...(content ? { content } : {}) },
          note: 'Sent to the owner’s editor. It shows there now and is kept when they press Save.',
        };
      },
    }),
  };
}

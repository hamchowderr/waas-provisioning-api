// The assistant's tools: the API's site tools (mcp/src/server.ts), split by what a visitor would see.
// Mastra's AgentController asks the owner per tool NAME, not per call, so every site tool that both
// reads and changes is offered twice: the "look and draft" half runs straight away, the change half
// (named `..._change`) always waits for the owner's yes. Each half only accepts its own actions.
//
// The tools hold no login of their own. A call runs as the owner who started the conversation: its
// resource id (the website, see server.ts) picks that owner's connection to /mcp/site, so the API
// decides which store it reaches, and nothing the model sends can name another one.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/** Runs one of the API's site tools as the owner of `resourceId`. */
export type CallSite = (resourceId: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;

const blocks = z.string().describe('WordPress block markup. Use the theme’s colour, font-size and spacing slugs from site_styles, not raw values.');
const pageId = z.number().int().positive().describe('The page id, from site_pages list');
const pattern = z.string().describe('A pattern name from site_patterns, e.g. anypress/hero-statement');

/** Tools that never change what visitors see: reads, a new draft page, an image in the media library. */
export const SAFE_TOOLS = ['get_site', 'site_pages', 'site_patterns', 'site_styles', 'header_footer', 'site_menus', 'add_image', 'business_profile'] as const;
/** Tools that change the live site, or what the assistant remembers about the business. Each call waits for the owner. */
export const CHANGE_TOOLS = ['site_pages_change', 'page_section', 'site_styles_change', 'header_footer_change', 'site_menus_change', 'business_profile_change'] as const;

/** The owner's own facts about the business, as the site keeps them (WaaS Client's /site/business). */
export const BUSINESS_FIELDS = {
  what: 'What the business does',
  who: 'Who it is for',
  area: 'Where it works or the area it serves',
  hours: 'Opening hours',
  contact: 'How customers reach it',
  voice: 'How its words should sound',
  notes: 'Anything else worth knowing',
} as const;
export type BusinessField = keyof typeof BUSINESS_FIELDS;

export function createSiteTools(call: CallSite) {
  /** A tool that forwards to the API's site tool `remote`, with `fixed` arguments the model can't change. */
  const site = <Shape extends z.ZodRawShape>(
    id: string,
    remote: string,
    description: string,
    input: Shape,
    fixed: (args: z.infer<z.ZodObject<Shape>>) => Record<string, unknown> = () => ({}),
  ) =>
    createTool({
      id,
      description,
      inputSchema: z.object(input),
      execute: async (args, context) => {
        const resourceId = context?.agent?.resourceId;
        if (!resourceId) throw new Error('This conversation has no website.');
        const typed = args as z.infer<z.ZodObject<Shape>>;
        return call(resourceId, remote, { ...typed, ...fixed(typed) });
      },
    });

  return {
    get_site: site('get_site', 'get_site', 'The site’s name, tagline, address, theme and what its home page shows. Start here.', {}),
    site_pages: site(
      'site_pages',
      'site_pages',
      'Look at the site’s pages, or add a new page as a draft (visitors can’t see it until it is published with site_pages_change). Actions: list (each page with a link, a preview link for drafts); read (one page’s numbered sections and block markup; read a page before changing it); revisions (its last 20 saved versions); create (a draft page).',
      {
        action: z.enum(['list', 'read', 'revisions', 'create']),
        pageId: pageId.optional(),
        title: z.string().optional().describe('For create'),
        content: blocks.optional().describe('For create: the whole page'),
      },
      // A page made here is always a draft; publishing it is a change.
      (args) => (args.action === 'create' ? { status: 'draft' } : {}),
    ),
    site_pages_change: site(
      'site_pages_change',
      'site_pages',
      'Change a page visitors can see; waits for the owner. Actions: update (title, slug, status — publish only when the owner says so — or all its content); restore_revision (put a page back the way it was in revisionId, to undo).',
      {
        action: z.enum(['update', 'restore_revision']),
        pageId,
        title: z.string().optional(),
        slug: z.string().optional(),
        status: z.enum(['draft', 'publish']).optional(),
        content: blocks.optional().describe('The whole page. To change one part, use page_section'),
        revisionId: z.number().int().positive().optional().describe('For restore_revision'),
      },
    ),
    page_section: site(
      'page_section',
      'page_section',
      'Change one section of a page; waits for the owner. Sections are numbered in site_pages read, 0 first. Actions: add (a pattern, preferred, or your own blocks; before `section`, or at the end); replace (copy its markup from site_pages read and change only what was asked); remove (restore_revision can bring it back).',
      {
        action: z.enum(['add', 'replace', 'remove']),
        pageId,
        section: z.number().int().min(0).optional(),
        pattern: pattern.optional(),
        content: blocks.optional(),
      },
    ),
    site_patterns: site(
      'site_patterns',
      'site_patterns',
      'Ready-made sections the theme offers, and whole starter pages (category anypress/pages). Actions: find (by search word or category); get (one pattern’s block markup).',
      {
        action: z.enum(['find', 'get']),
        search: z.string().optional(),
        category: z.string().optional(),
        name: pattern.optional().describe('For get'),
      },
    ),
    site_styles: site('site_styles', 'site_styles', 'The site’s colours, fonts, font sizes and spacing, with the slugs to use in blocks.', {}, () => ({ action: 'get' })),
    site_styles_change: site(
      'site_styles_change',
      'site_styles',
      'Change the whole site’s look (Styles in the Site Editor); waits for the owner. Merges theme.json settings and styles into the site’s changes.',
      {
        settings: z.record(z.string(), z.unknown()).optional().describe('theme.json settings, e.g. settings.color.palette.custom'),
        styles: z.record(z.string(), z.unknown()).optional().describe('theme.json styles, e.g. styles.elements.button.color.background'),
      },
      () => ({ action: 'update' }),
    ),
    header_footer: site('header_footer', 'header_footer', 'The header or footer every page shows, as blocks with an outline.', { part: z.enum(['header', 'footer']) }, () => ({ action: 'get' })),
    header_footer_change: site(
      'header_footer_change',
      'header_footer',
      'Replace the whole header or footer; waits for the owner. Start from header_footer and change only what was asked.',
      { part: z.enum(['header', 'footer']), content: blocks },
      () => ({ action: 'update' }),
    ),
    site_menus: site('site_menus', 'site_menus', 'Every navigation menu with its links.', {}, () => ({ action: 'list' })),
    site_menus_change: site(
      'site_menus_change',
      'site_menus',
      'Replace a menu’s links; waits for the owner. Pages: <!-- wp:navigation-link {"label":"About","type":"page","id":12,"kind":"post-type"} /-->; other addresses: {"label":"…","url":"https://…","kind":"custom"}.',
      { menuId: z.number().int().positive(), content: z.string(), title: z.string().optional() },
      () => ({ action: 'update' }),
    ),
    business_profile: site(
      'business_profile',
      'business_profile',
      'What the site knows about its business: `site` (name, tagline, language, time zone, site type, the owner’s name, phone and place, currency, products and prices, booking types, forms) and `about` (what the owner has told you). It is already in your instructions; read it again after a save.',
      {},
      () => ({ action: 'read' }),
    ),
    business_profile_change: site(
      'business_profile_change',
      'business_profile',
      'Remember facts about the business the owner told you and agreed to keep, so later conversations know them; waits for the owner. Actions: save (only the fields given change; an empty string clears one); undo (put back the facts as they were before the last save).',
      {
        action: z.enum(['save', 'undo']),
        about: z
          .object(Object.fromEntries(Object.entries(BUSINESS_FIELDS).map(([key, what]) => [key, z.string().max(1500).optional().describe(what)])) as Record<BusinessField, z.ZodOptional<z.ZodString>>)
          .optional()
          .describe('For save: only the facts to change, in the owner’s words, short'),
      },
    ),
    add_image: site(
      'add_image',
      'add_image',
      'Copy an image from a public https link into the site’s media library (visitors don’t see it until a page uses it). Returns its id and address.',
      { url: z.string().url(), alt: z.string().optional().describe('What the image shows') },
    ),
  };
}

/** A plain sentence for the approval card, e.g. "Replace section 2 on page 14". */
export function describeCall(tool: string, args: Record<string, unknown>): string {
  const page = typeof args.pageId === 'number' ? ` on page ${args.pageId}` : '';
  const section = typeof args.section === 'number' ? `section ${args.section}` : 'a section';
  switch (`${tool}:${String(args.action ?? '')}`) {
    case 'site_pages_change:update':
      return args.status === 'publish' ? `Publish page ${String(args.pageId)}` : `Change page ${String(args.pageId)}`;
    case 'site_pages_change:restore_revision':
      return `Put page ${String(args.pageId)} back to an earlier version`;
    case 'page_section:add':
      return `Add a section${page}`;
    case 'page_section:replace':
      return `Replace ${section}${page}`;
    case 'page_section:remove':
      return `Remove ${section}${page}`;
    case 'business_profile_change:save': {
      const about = (args.about ?? {}) as Record<string, unknown>;
      const facts = Object.entries(about)
        .filter(([key]) => key in BUSINESS_FIELDS)
        .map(([key, value]) => (String(value ?? '') === '' ? `forget ${BUSINESS_FIELDS[key as BusinessField].toLowerCase()}` : `${BUSINESS_FIELDS[key as BusinessField]}: ${String(value)}`));
      return facts.length ? `Remember about your business: ${facts.join('; ')}` : 'Remember about your business';
    }
    case 'business_profile_change:undo':
      return 'Put back what I knew about your business before the last change';
  }
  switch (tool) {
    case 'site_styles_change':
      return 'Change the site’s colours, fonts or spacing';
    case 'header_footer_change':
      return `Change the ${String(args.part ?? 'header or footer')}`;
    case 'site_menus_change':
      return 'Change a menu';
    default:
      return `Run ${tool}`;
  }
}

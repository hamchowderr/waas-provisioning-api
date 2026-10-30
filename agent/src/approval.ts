// Which site tool calls the website owner must approve first. The site tools (mcp/src/server.ts) change
// the live site at once, so anything a visitor could see waits for the owner's yes. Unknown tools and
// actions need approval too: a new tool on the server is never trusted until it is listed here.

/** The site tools the assistant may use, with the actions that only read. */
const READS: Record<string, readonly string[] | true> = {
  get_site: true,
  site_pages: ['list', 'read', 'revisions'],
  site_patterns: ['find', 'get'],
  site_styles: ['get'],
  header_footer: ['get'],
  site_menus: ['list'],
};

/** Writes nobody but the owner sees until they publish: a new draft page, an image in the media library. */
function isPrivateWrite(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'site_pages') return args.action === 'create' && args.status !== 'publish';
  return tool === 'add_image';
}

export const SITE_TOOLS = [...Object.keys(READS), 'page_section', 'add_image'] as const;

/** Whether a call waits for the owner's approval. */
export function needsApproval(tool: string, args: Record<string, unknown> = {}): boolean {
  const reads = READS[tool];
  if (reads === true) return false;
  if (reads && typeof args.action === 'string' && reads.includes(args.action)) return false;
  if (!(SITE_TOOLS as readonly string[]).includes(tool)) return true;
  return !isPrivateWrite(tool, args);
}

/** A plain sentence for the approval card, e.g. "Replace section 2 on page 14". */
export function describeCall(tool: string, args: Record<string, unknown>): string {
  const page = typeof args.pageId === 'number' ? ` on page ${args.pageId}` : '';
  const section = typeof args.section === 'number' ? `section ${args.section}` : 'a section';
  switch (`${tool}:${String(args.action ?? '')}`) {
    case 'site_pages:create':
      return `Add and publish the page “${String(args.title ?? '')}”`;
    case 'site_pages:update':
      return args.status === 'publish' ? `Publish page ${String(args.pageId)}` : `Change page ${String(args.pageId)}`;
    case 'site_pages:restore_revision':
      return `Put page ${String(args.pageId)} back to an earlier version`;
    case 'page_section:add':
      return `Add a section${page}`;
    case 'page_section:replace':
      return `Replace ${section}${page}`;
    case 'page_section:remove':
      return `Remove ${section}${page}`;
    case 'site_styles:update':
      return 'Change the site’s colours, fonts or spacing';
    case 'header_footer:update':
      return `Change the ${String(args.part ?? 'header or footer')}`;
    case 'site_menus:update':
      return 'Change a menu';
    default:
      return `Run ${tool}${args.action ? ` (${String(args.action)})` : ''}`;
  }
}

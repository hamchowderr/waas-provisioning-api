import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** The app screens (MCP Apps), each a ui:// resource a show_* tool points at. */
export const VIEWS = {
  stores: 'ui://waas/stores.html',
  store: 'ui://waas/store.html',
  backups: 'ui://waas/backups.html',
  domains: 'ui://waas/domains.html',
} as const;
export type View = keyof typeof VIEWS;

export const STORES_VIEW_URI = VIEWS.stores;

const cache = new Map<View, string>();
let bundleScript: string | undefined;

/**
 * The MCP Apps client bundle as a classic script: the bundle is an ES module, so its export list
 * is rewritten into a `McpApps` global the screens' own scripts read.
 */
function appsBundle(): string {
  if (bundleScript) return bundleScript;
  const require = createRequire(import.meta.url);
  const bundle = readFileSync(require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8');
  const exportList = /export\s*\{([^}]*)\};?\s*$/.exec(bundle);
  if (!exportList) throw new Error('Unexpected @modelcontextprotocol/ext-apps bundle: no trailing export list');
  const globals = exportList[1]!
    .split(',')
    .map((entry) => entry.trim().split(/\s+as\s+/))
    .map(([local, exported]) => `${exported ?? local}:${local}`)
    .join(',');
  bundleScript = `${bundle.slice(0, exportList.index)}\nglobalThis.McpApps={${globals}};`;
  return bundleScript;
}

const read = (file: string) => readFileSync(new URL(`./view/${file}`, import.meta.url), 'utf8');
const inScript = (code: string) => code.replaceAll('</script', '<\\/script');

/**
 * A screen's HTML, self-contained: hosts render it in a sandboxed iframe that can't load scripts or
 * styles from elsewhere, so the MCP Apps client bundle, the shared styles (view/base.css) and the
 * shared helpers (view/common.js) are inlined.
 */
export function viewHtml(view: View): string {
  const cached = cache.get(view);
  if (cached) return cached;
  // Function replacers, so `$` sequences in the inlined code are kept as they are.
  const html = read(`${view}.html`)
    .replace('/*VIEW_STYLE*/', () => read('base.css'))
    .replace('/*MCP_APPS_BUNDLE*/', () => inScript(appsBundle()))
    .replace('/*VIEW_COMMON*/', () => inScript(read('common.js')));
  cache.set(view, html);
  return html;
}

/** The show_stores panel's HTML. */
export const storesViewHtml = () => viewHtml('stores');

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export const STORES_VIEW_URI = 'ui://waas/stores.html';

let cached: string | undefined;

/**
 * The store panel's HTML, self-contained: hosts render it in a sandboxed iframe that can't load
 * scripts from elsewhere, so the MCP Apps client bundle is inlined. The bundle is an ES module;
 * its export list is rewritten into a `McpApps` global the panel's own script reads.
 */
export function storesViewHtml(): string {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const bundle = readFileSync(require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8');
  const exportList = /export\s*\{([^}]*)\};?\s*$/.exec(bundle);
  if (!exportList) throw new Error('Unexpected @modelcontextprotocol/ext-apps bundle: no trailing export list');
  const globals = exportList[1]!
    .split(',')
    .map((entry) => entry.trim().split(/\s+as\s+/))
    .map(([local, exported]) => `${exported ?? local}:${local}`)
    .join(',');
  const script = `${bundle.slice(0, exportList.index)}\nglobalThis.McpApps={${globals}};`;
  const template = readFileSync(new URL('./view/stores.html', import.meta.url), 'utf8');
  // A function replacer, so `$` sequences in the bundle are kept as they are.
  cached = template.replace('/*MCP_APPS_BUNDLE*/', () => script.replaceAll('</script', '<\\/script'));
  return cached;
}

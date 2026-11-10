/**
 * What comes installed on a store, for the dashboard's store page: the plugins its site types turn on (the
 * template's roles.json, in the store's version), what each is for, and whether the owner may add plugins of their
 * own. The same list AnyPress Client shows the owner on Dashboard > Your plan.
 */

/** Display names of the template's plugins (templates/anypress-store/build.sh); any other plugin goes by its folder. */
const NAMES: Record<string, string> = {
  'fluent-security': 'FluentAuth',
  'fluent-smtp': 'FluentSMTP',
  'fluent-crm': 'FluentCRM',
  fluentform: 'Fluent Forms',
  'fluent-booking': 'FluentBooking',
  'fluent-cart': 'FluentCart',
  'fluent-community': 'FluentCommunity',
  'fluent-player': 'FluentPlayer',
  'fluent-affiliate': 'FluentAffiliate',
  'fluent-support': 'Fluent Support',
  'easy-code-manager': 'FluentSnippets',
  'seo-by-rank-math': 'Rank Math SEO',
  automatorwp: 'AutomatorWP',
  'wp-fusion-lite': 'WP Fusion Lite',
  leadconnector: 'LeadConnector',
  'fluent-toolkit': 'FluentHub',
  'anypress-blocks': 'AnyPress Blocks',
  'mcp-adapter': 'MCP Adapter',
};

export type SitePlugin = { file: string; name: string; about: string | null };
export type SitePlugins = { siteTypes: { key: string; title: string }[]; ownPlugins: boolean; plugins: SitePlugin[] };

type Role = { title?: unknown; plugins?: unknown; ownPlugins?: unknown; about?: unknown };

export function sitePluginsOf(roles: unknown, siteTypes: string[]): SitePlugins {
  const all = roles && typeof roles === 'object' ? (roles as Record<string, Role>) : {};
  const matched = siteTypes.filter((key) => Object.hasOwn(all, key) && all[key] && typeof all[key] === 'object');
  const plugins = new Map<string, SitePlugin>();
  for (const key of matched) {
    const role = all[key]!;
    const about = role.about && typeof role.about === 'object' ? (role.about as Record<string, unknown>) : {};
    for (const file of Array.isArray(role.plugins) ? role.plugins : []) {
      if (typeof file !== 'string' || plugins.has(file)) continue;
      const folder = file.split('/')[0]!;
      plugins.set(file, { file, name: NAMES[folder] ?? folder, about: typeof about[file] === 'string' ? (about[file] as string) : null });
    }
  }
  return {
    siteTypes: matched.map((key) => ({ key, title: typeof all[key]!.title === 'string' ? (all[key]!.title as string) : key })),
    ownPlugins: matched.some((key) => all[key]!.ownPlugins === true),
    plugins: [...plugins.values()],
  };
}

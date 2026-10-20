// The public API reference: GET /openapi.json and the page at GET /docs. Built from the contract
// files in openapi/ (the admin API is left out), keeping only the operations this server
// actually answers, with notes meant for us (phases, plugin file references, the Postman mock,
// Beads ids) taken out. The files themselves stay as they are: request validation and the SDK read them.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const SOURCES = [
  { file: 'waas-provisioning-api.yaml' },
  { file: 'store-mail.yaml', tag: 'TenantMail' },
  { file: 'plugin-updates.yaml', tag: 'PluginUpdates' },
  { file: 'api-keys.yaml', tag: 'ApiKeys' },
  { file: 'webhooks.yaml', tag: 'Webhooks' },
];

const DOCS_BASE = 'https://github.com/hamchowderr/waas-provisioning-api/blob/main/docs/';

const DESCRIPTION = `Create and manage WordPress stores: tenants, their domains and sending domains, versions, snapshots and templates.

**Authentication.** Every \`/v1\` call uses HTTP Basic auth with your API key as the username and your API secret as the password. A missing or wrong key or secret returns **403**, not 401.

**Writes are asynchronous.** A create, update or delete returns once it is scheduled. Poll the matching GET and read \`statusCode\`: 0 Pending, 1 Done, 2 Failed, 3 Removing.

**Partner keys.** A partner (reseller) key works across products: add \`productId\` to the query string of tenant, version and snapshot calls to say which product you mean.

**Versioning.** The version is in the path: every call is under \`/v1\`. Within v1, changes only add things (new calls, new optional fields, new response fields, new webhook events), so code written against v1 keeps working: ignore response fields you don't know. Nothing in v1 is removed or renamed, and its meaning doesn't change. A call or field that is replaced is marked deprecated here and keeps working. A change that can't be made this way would come as \`/v2\`, with \`/v1\` kept running alongside it.

**Domains** are bare hostnames (\`shop.example.com\`, no \`https://\`). A tenant's \`domainName\` is its custom domain when it was created with one, otherwise its base domain.`;

// Tag names stay as in the contract (operations refer to them); x-displayName is what the page shows.
const TAGS: Record<string, [string, string]> = {
  Tenant: ['Tenants', 'Create, list, update and delete stores (tenants).'],
  TenantDomain: ['Domains', "A store's domains: add one, remove one, choose the main domain, check availability."],
  TenantLifecycle: ['Suspend, back up and restore', 'Suspend, resume, back up and restore stores, so a cancelled subscription can keep its store for a grace period and a deleted store can come back from its backup.'],
  TenantSite: ['Site editing', "Edit a store's pages and design (sections, patterns, colours and fonts, header, footer, menus) through its WaaS Client, for AI agents. How: [guide](https://github.com/hamchowderr/waas-provisioning-api/blob/main/docs/site-editing.md)."],
  SiteImport: ['Moving a site in', 'Move an existing WordPress site in from another host with the AnyPress Export plugin. These calls take the import code instead of an API key. How: [guide](https://github.com/hamchowderr/waas-provisioning-api/blob/main/docs/site-imports.md).'],
  TenantMail: ['Sending domain', "A store's own sending domain, and the Domain Connect link that adds DNS records at the customer's DNS host."],
  Version: ['Versions', 'Versions of your storefront product: the WordPress install each new store is copied from.'],
  Snapshot: ['Snapshots', 'Snapshots of versions.'],
  BaseSnapshot: ['Templates', 'Templates (base snapshots) that new versions start from. Partner keys only.'],
  ApiKeys: ['API keys', 'List, create, rotate and revoke your own API keys. A secret is shown once, in the response that creates the key.'],
  Webhooks: ['Webhooks', 'Endpoints that get a signed POST when a store or version finishes a change, and their deliveries. How to verify them: [guide](https://github.com/hamchowderr/waas-provisioning-api/blob/main/docs/webhooks.md).'],
  PluginUpdates: ['Plugin updates', 'Update checks made by the WaaS plugins. The response points at a signed release package.'],
};

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'];

// Lines and phrases in the contract written for us rather than for API users.
const INTERNAL: [RegExp, string][] = [
  [/^Phase \d[^.\n]*\.\s*/gm, ''],
  [/\s*Phase \d\./g, ''],
  // Where the storefront plugin makes each call, with file and line references.
  [/^\*\*Storefront plugin:\*\*.*$/gm, ''],
  [/\s*\([^()]*\.php[^()]*\)/g, ''],
  [/ Sent by the storefront plugin; missing from the original spec\./g, ''],
  // Links into an old docs site that is gone.
  [/\s*(?:For more info see|See) (?:our )?\[[^\]]*\]\(docs\/[^)]*\)\.?/g, ''],
  [/\s*\((?:waas|wpcs)-[a-z0-9]+(?:\.[0-9]+)*\)/gi, ''],
  [/\((docs\/([a-z0-9-]+)\.md)\)/g, `([guide](${DOCS_BASE}$2.md))`],
];

function clean(text: string): string {
  let out = text;
  for (const [pattern, replacement] of INTERNAL) out = out.replace(pattern, replacement);
  return out.trim();
}

/** Deep copy without x-* extensions, with internal notes taken out of every description. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrub(value: any): any {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any = {};
  for (const [key, v] of Object.entries(value)) {
    if (key.startsWith('x-')) continue;
    out[key] = (key === 'description' || key === 'summary') && typeof v === 'string' ? clean(v) : scrub(v);
  }
  return out;
}

/** Spec path to the matching Hono route path: {id} becomes :id. */
const routePath = (path: string) => path.replace(/\{([^}]+)\}/g, ':$1');

/**
 * The public spec. `served` lists "METHOD /path" for every route the app answers, in Hono's
 * form; operations the server doesn't implement yet are left out.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildPublicSpec(served: Set<string>): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paths: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const components: Record<string, Record<string, any>> = {};
  const usedTags = new Set<string>();
  let version = '';

  for (const source of SOURCES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec: any = parse(readFileSync(new URL(`../openapi/${source.file}`, import.meta.url), 'utf8'));
    version ||= spec.info.version;
    for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kept: Record<string, any> = {};
      for (const [key, op] of Object.entries(item)) {
        if (!METHODS.includes(key)) {
          kept[key] = op;
          continue;
        }
        if (!served.has(`${key.toUpperCase()} ${routePath(path)}`)) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const operation: any = { ...(op as object) };
        if (!operation.tags?.length && source.tag) operation.tags = [source.tag];
        for (const tag of operation.tags ?? []) usedTags.add(tag);
        kept[key] = operation;
      }
      if (Object.keys(kept).some((key) => METHODS.includes(key))) paths[path] = { ...paths[path], ...kept };
    }
    for (const [kind, entries] of Object.entries<Record<string, unknown>>(spec.components ?? {})) {
      if (kind === 'securitySchemes') continue;
      const merged = (components[kind] ??= {});
      for (const [name, value] of Object.entries(entries)) {
        if (name in merged && JSON.stringify(merged[name]) !== JSON.stringify(value)) {
          throw new Error(`components.${kind}.${name} differs between the contract files`);
        }
        merged[name] = value;
      }
    }
  }

  // Only the components the kept operations reach, so models of unimplemented calls don't show.
  const reached = new Set<string>();
  const pending = [JSON.stringify(paths)];
  while (pending.length) {
    for (const [, kind, name] of pending.pop()!.matchAll(/"#\/components\/([^/"]+)\/([^"]+)"/g)) {
      const ref = `${kind}/${name}`;
      const value = components[kind!]?.[name!];
      if (reached.has(ref) || value === undefined) continue;
      reached.add(ref);
      pending.push(JSON.stringify(value));
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kept: Record<string, Record<string, any>> = {};
  for (const [kind, entries] of Object.entries(components)) {
    const used = Object.entries(entries).filter(([name]) => reached.has(`${kind}/${name}`));
    if (used.length) kept[kind] = Object.fromEntries(used);
  }

  const publicSpec = scrub({
    openapi: '3.0.1',
    info: {
      title: 'WaaS Provisioning API',
      version,
      description: DESCRIPTION,
      license: { name: 'GPL-3.0-or-later', url: 'https://www.gnu.org/licenses/gpl-3.0.html' },
    },
    // Relative, so the page's "Try it" calls whichever server is showing it.
    servers: [{ url: '/', description: 'This server' }],
    security: [{ basic: [] }],
    tags: Object.keys(TAGS)
      .filter((name) => usedTags.has(name))
      .map((name) => ({ name, description: TAGS[name]![1] })),
    paths,
    components: {
      ...kept,
      securitySchemes: {
        basic: { type: 'http', scheme: 'basic', description: 'Your API key as the username and your API secret as the password.' },
      },
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const tag of publicSpec.tags as any[]) tag['x-displayName'] = TAGS[tag.name]![0];
  return publicSpec;
}

const SCALAR = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.4/dist/browser/standalone.js';

export const docsPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WaaS Provisioning API reference</title>
</head>
<body>
<div id="app"></div>
<script src="${SCALAR}"></script>
<script>
Scalar.createApiReference('#app', {
  url: './openapi.json',
  agent: { disabled: true },
  mcp: { disabled: true },
  showDeveloperTools: 'never',
  telemetry: false,
  documentDownloadType: 'json',
});
</script>
</body>
</html>
`;

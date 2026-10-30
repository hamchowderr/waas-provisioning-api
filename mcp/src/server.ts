import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { McpServer, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/server';
import { TenantFailedError, WaasApiError, type TenantRef, type WaasClient } from 'waas-provisioning-sdk';
import { z } from 'zod';
import { AREA_LABELS, AREAS, ALL_SCOPES, scopeOf, type Access, type Area } from './scopes.js';
import { loadSkills, registerSkills } from './skills.js';
import { viewHtml, VIEWS, type View } from './view.js';

export interface WaasMcpOptions {
  /** Offers only the actions that read; nothing the agent calls can change a store. */
  readOnly?: boolean;
  /**
   * The scopes this connection was granted (scopes.ts), e.g. ['stores:read', 'backups:read'].
   * Only the actions whose scope is granted are offered. Every scope when omitted.
   */
  scopes?: readonly string[];
  /**
   * Connected to one store only (its owner's "Sign in with your website"): registers only the site
   * tools, and they act on this store whatever store the agent names.
   */
  store?: TenantRef;
  /** How often get_stores' wait action polls (tests shorten it). */
  pollIntervalMs?: number;
  /** Logos AI apps show for this server, e.g. [{ src: 'https://…/icon.png', mimeType: 'image/png' }]. */
  icons?: { src: string; mimeType?: string; sizes?: string[] }[];
}

const ref = {
  externalId: z.string().optional().describe('Your own id for the store (what WaaS Host uses). Give this or tenantId.'),
  tenantId: z.string().optional().describe("The API's id for the store. Give this or externalId."),
};

const stringMap = z.record(z.string(), z.string());
const phpConstants = z.record(
  z.string(),
  z.object({ value: z.string().optional(), isPrivate: z.boolean().optional().describe('Hide the value in the console') }),
);
const size = z
  .enum(['small', 'medium', 'large'])
  .describe('Store size: small (1 CPU, 5 GB, 5,000 emails a month), medium (2 CPUs, 10 GB, 20,000) or large (4 CPUs, 25 GB, 50,000)');

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const WAIT_NOTE = ' Returns once the work is scheduled; then call get_stores with action wait.';

type StoreArgs = { externalId?: string | undefined; tenantId?: string | undefined };

function toRef(args: StoreArgs): TenantRef {
  if (args.externalId && args.tenantId) throw new UsageError('Give externalId or tenantId, not both.');
  if (args.externalId) return { externalId: args.externalId };
  if (args.tenantId) return { tenantId: args.tenantId };
  throw new UsageError('Give the store’s externalId or tenantId.');
}

class UsageError extends Error {}

/** Where to download the AnyPress Export plugin: the API the import code points at. */
function pluginDownload(importCode: string | undefined): string | undefined {
  if (!importCode?.startsWith('AP1.')) return undefined;
  try {
    const { u } = JSON.parse(Buffer.from(importCode.slice(4), 'base64url').toString('utf8')) as { u?: unknown };
    return typeof u === 'string' ? `${u}/imports/plugin.zip` : undefined;
  } catch {
    return undefined;
  }
}

/** A parameter an action can't do without. */
function need<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined || value === null || value === '') throw new UsageError(`Action ${action} needs ${field}.`);
  return value;
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: value === undefined ? 'Done.' : JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): CallToolResult {
  let text: string;
  if (error instanceof WaasApiError) text = `The API refused ${error.operationId} (HTTP ${error.status}): ${error.apiMessage ?? 'no message'}`;
  else if (error instanceof TenantFailedError) text = `The store failed to provision:\n${JSON.stringify(error.tenant, null, 2)}`;
  else if (error instanceof Error) text = error.message;
  else text = String(error);
  return { isError: true, content: [{ type: 'text', text }] };
}

/** One action of a tool: the access it needs in the tool's area, a few words on what it does, and the call. */
interface Action<Args> {
  access: Access;
  does: string;
  destructive?: boolean;
  run: (args: Args) => Promise<unknown>;
}

/**
 * An MCP server whose tools call the WaaS provisioning API through the TypeScript SDK. The tools
 * are grouped by area (stores, backups, domains, email, versions, site) and most take an `action`;
 * each action needs its area's read or write scope, and only the actions a connection may use are
 * offered. It also serves the store screens (MCP Apps) and the anypress-stores skill (Skills
 * extension). Serve it with serveStdio or createMcpHandler from @modelcontextprotocol/server; it is
 * built per connection or request.
 */
export function createWaasMcpServer(client: WaasClient, options: WaasMcpOptions = {}): McpServer {
  const granted = new Set(options.scopes ?? ALL_SCOPES);
  /** Whether this connection may read or change an area. */
  const may = (area: Area, access: Access) => granted.has(scopeOf(area, access)) && !(options.readOnly && access === 'write');
  // What the connection may not do, for the instructions: "see or change backups", "change domains".
  const withheld = AREAS.filter((area) => !may(area, 'write')).map((area) => `${may(area, 'read') ? 'change' : 'see or change'} ${AREA_LABELS[area].name.toLowerCase()}`);
  const skill = loadSkills()[0]?.uri;
  const server = new McpServer(
    { name: 'waas-provisioning', title: 'AnyPress', version: '0.1.0', websiteUrl: 'https://anypress.io', ...(options.icons ? { icons: options.icons } : {}) },
    {
      instructions:
        'Manages WordPress stores on the WaaS provisioning API. A store is a "tenant"; pick one by externalId (your own id) or tenantId. ' +
        'Most tools take an action, e.g. manage_domain with action add. ' +
        'Every store write is asynchronous: it returns once scheduled, and the store shows statusCode 0 (Pending) until the work finishes, then 1 (Done) or 2 (Failed). ' +
        'Call get_stores with action wait after creating, restoring, moving or changing domains, and before the next write to the same store. ' +
        'The site tools (get_site, site_pages, page_section, site_patterns, site_styles, header_footer, site_menus, add_image) edit a store’s pages and design directly and take effect at once: ' +
        'read a page before changing it, build from the theme’s patterns and style slugs, create new pages as drafts, and publish only when the user says so. ' +
        'For a whole new page, start from a starter page (site_patterns with action find and category anypress/pages: home pages per site type, about, services, contact) and then rewrite its text for the business.' +
        (skill ? ` The skill ${skill} walks through the common jobs step by step.` : '') +
        (options.readOnly ? ' This server is read-only: it cannot change anything.' : '') +
        (!options.readOnly && !options.store && withheld.length ? ` This connection was not allowed to ${withheld.join(', ')}, so those tools and actions are not offered; the user can reconnect to allow more.` : '') +
        (options.store ? ' This connection is for one website only: the site tools act on it, and the store ids can be left out.' : ''),
    },
  );
  registerSkills(server);

  // Until the site tools below, every tool is for running stores, which a store's own connection can't do.
  let siteTools = false;

  const run = async (call: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return json(await call());
    } catch (error) {
      return failure(error);
    }
  };

  /** A tool with one job. */
  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; area: Area; input: Shape; annotations: ToolAnnotations },
    call: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ) => {
    if (!may(config.area, config.annotations.readOnlyHint ? 'read' : 'write')) return;
    if (options.store && !siteTools) return;
    server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema: z.object(config.input), annotations: config.annotations },
      async (args) => run(() => call(args as z.infer<z.ZodObject<Shape>>)),
    );
  };

  /**
   * A tool whose `action` picks what it does. Only the actions this connection's scopes allow are
   * offered (the action enum lists just those), and each is checked again when called. The hints
   * follow the offered actions: read-only when they all read, destructive when any destroys.
   */
  const actionTool = <Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; area: Area; input: Shape; actions: Record<string, Action<z.infer<z.ZodObject<Shape>>>> },
  ) => {
    if (options.store && !siteTools) return;
    const offered = Object.entries(config.actions).filter(([, action]) => may(config.area, action.access));
    if (!offered.length) return;
    const names = offered.map(([action]) => action) as [string, ...string[]];
    const description = `${config.description} Actions: ${offered.map(([action, { does }]) => `${action} (${does})`).join('; ')}.`;
    const annotations: ToolAnnotations = offered.every(([, action]) => action.access === 'read')
      ? READ
      : { ...WRITE, destructiveHint: offered.some(([, action]) => action.destructive) };
    server.registerTool(
      name,
      {
        title: config.title,
        description,
        inputSchema: z.object({ action: z.enum(names).describe('What to do'), ...config.input }),
        annotations,
      },
      async (args) => {
        const { action: chosen, ...rest } = args as { action: string };
        const action = config.actions[chosen];
        if (!action || !may(config.area, action.access)) {
          return failure(new UsageError(`This connection may not use ${name} with action ${chosen}: it needs ${scopeOf(config.area, action?.access ?? 'write')}.`));
        }
        return run(() => action.run(rest as z.infer<z.ZodObject<Shape>>));
      },
    );
  };

  // App screens (MCP Apps): render in clients that support them (Claude, ChatGPT, VS Code...);
  // other clients get the same data as text. A store's own connection has no stores to show.

  const SCREENS: Record<View, string> = { stores: 'Store list', store: 'Store details', backups: 'Store backups', domains: 'Store domains' };
  const screen = (view: View, tool: string) =>
    registerAppResource(server, SCREENS[view], VIEWS[view], { description: `The ${tool} screen` }, async () => ({
      contents: [{ uri: VIEWS[view], mimeType: RESOURCE_MIME_TYPE, text: viewHtml(view) }],
    }));

  const appTool = <Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; area: Area; view: View; input: Shape },
    call: (args: z.infer<z.ZodObject<Shape>>) => Promise<{ text: string; data: Record<string, unknown> }>,
  ) => {
    if (options.store || !may(config.area, 'read')) return;
    registerAppTool(
      server,
      name,
      { title: config.title, description: config.description, inputSchema: z.object(config.input), annotations: READ, _meta: { ui: { resourceUri: VIEWS[config.view] } } },
      async (args) => {
        try {
          const { text, data } = await call(args as z.infer<z.ZodObject<Shape>>);
          return { content: [{ type: 'text', text }], structuredContent: data };
        } catch (error) {
          return failure(error);
        }
      },
    );
    screen(config.view, name);
  };

  const findStore = async (storeRef: TenantRef) => {
    const store = await client.tenants.get(storeRef);
    if (!store) throw new UsageError('No store has that id.');
    return store;
  };

  appTool(
    'show_stores',
    {
      title: 'Show stores', area: 'stores', view: 'stores',
      description: 'Shows your stores in a panel (status, main domain, version) with buttons to back up, suspend and resume. Use get_stores when you only need the data.',
      input: {},
    },
    async () => {
      const stores = await client.tenants.list();
      return {
        text: `${stores.length === 1 ? '1 store' : `${stores.length} stores`}:\n${JSON.stringify(stores, null, 2)}`,
        data: { stores, readOnly: !may('stores', 'write') && !may('backups', 'write'), canBackup: may('backups', 'write'), canChange: may('stores', 'write') },
      };
    },
  );

  appTool(
    'show_store',
    {
      title: 'Show a store', area: 'stores', view: 'store',
      description: 'Shows one store in a panel: status, size, version, dates, its domains and the versions it can move to.',
      input: ref,
    },
    async (args) => {
      const store = await findStore(toRef(args));
      const storeRef = { tenantId: store.id! };
      const [domains, versions] = await Promise.all([
        may('domains', 'read') ? client.domains.list(storeRef) : undefined,
        may('versions', 'read') ? client.versions.list() : undefined,
      ]);
      return {
        text: JSON.stringify({ store, domains, versions }, null, 2),
        data: { ref: storeRef, store, domains, versions, canBackup: may('backups', 'write'), canChange: may('stores', 'write') },
      };
    },
  );

  appTool(
    'show_store_backups',
    { title: 'Show backups', area: 'backups', view: 'backups', description: "Shows a store's backups in a panel, with buttons to back up and restore.", input: ref },
    async (args) => {
      const storeRef = toRef(args);
      const [backups, store] = await Promise.all([client.tenants.listBackups(storeRef), may('stores', 'read') ? client.tenants.get(storeRef) : undefined]);
      return { text: JSON.stringify(backups, null, 2), data: { ref: storeRef, store: store ?? undefined, backups, canBackup: may('backups', 'write') } };
    },
  );

  appTool(
    'show_store_domains',
    { title: 'Show domains', area: 'domains', view: 'domains', description: "Shows a store's domains in a panel, with buttons to add, remove and pick the main one.", input: ref },
    async (args) => {
      const storeRef = toRef(args);
      const [domains, store] = await Promise.all([client.domains.list(storeRef), may('stores', 'read') ? client.tenants.get(storeRef) : undefined]);
      return { text: JSON.stringify(domains, null, 2), data: { ref: storeRef, store: store ?? undefined, domains, canChange: may('domains', 'write') } };
    },
  );

  // Stores

  actionTool('get_stores', {
    title: 'Get stores', area: 'stores',
    description: 'Looks up stores.',
    input: { ...ref, timeoutSeconds: z.number().int().min(1).max(600).optional().describe('For wait: how long to wait, 120 when omitted, at most 600') },
    actions: {
      list: { access: 'read', does: 'every store with its status, version and main domain', run: () => client.tenants.list() },
      get: { access: 'read', does: 'one store: status, size, version, snapshot, main domain and dates; null when no store has that id', run: (args) => client.tenants.get(toRef(args)) },
      wait: {
        access: 'read',
        does: 'polls the store until it is Done, or returns { done: false, store } when the time is up so you can call again',
        run: async (args) => {
          const storeRef = toRef(args);
          try {
            const store = await client.waitForTenant(storeRef, { intervalMs: options.pollIntervalMs ?? 5_000, timeoutMs: (args.timeoutSeconds ?? 120) * 1000 });
            return { done: true, store };
          } catch (error) {
            if (error instanceof WaasApiError || error instanceof TenantFailedError) throw error;
            return { done: false, store: await client.tenants.get(storeRef) };
          }
        },
      },
      move_in: {
        access: 'read',
        does:
          'for a site moved in (import_site): waiting, moving, done or failed with its reason, warnings to check, and siteReport: ' +
          'its form, shop, CRM, booking, support, affiliate and community plugins with their counts, whether a Fluent plugin can bring the data in ' +
          '(route, needsPro), what a switch would lose (willLose) and what to fix first (blockers)',
        run: (args) => client.tenants.getImport(toRef(args)),
      },
    },
  });

  tool(
    'create_store',
    {
      title: 'Create a store', area: 'stores',
      description:
        'Creates a WordPress store on the production version (or versionId), from the newest snapshot (or snapshotId / groupName).' +
        ' Repeating a create with the same externalId answers with the store it already made.' +
        WAIT_NOTE,
      input: {
        name: z.string().describe('Display name, at most 30 characters, starting and ending with a letter or digit'),
        externalId: z.string().optional().describe("Your own id (letters, digits and '-'). Generated when omitted."),
        customDomainName: z.string().optional().describe('A custom domain for the store, e.g. shop.example.com'),
        versionId: z.string().optional().describe('Version to create it on; the production version when omitted'),
        snapshotId: z.string().optional().describe('Snapshot to start from'),
        groupName: z.string().optional().describe('Start from the newest snapshot in this group'),
        wordPressUserName: z.string().optional(),
        wordPressUserEmail: z.string().optional(),
        wordPressUserRole: z.string().optional().describe('e.g. administrator'),
        wordPressUserPassword: z.string().optional(),
        wpOptions: stringMap.optional().describe('WordPress options to set, by option name'),
        phpConstants: phpConstants.optional().describe('PHP constants to define, by name'),
        size: size.optional().describe('small when omitted'),
      },
      annotations: WRITE,
    },
    (args) => client.tenants.create(args),
  );

  actionTool('import_site', {
    title: 'Move a site in', area: 'stores',
    description:
      'Moves an existing WordPress site from another host into a new store, which keeps the site’s own plugins and themes. ' +
      'The site owner installs the AnyPress Export plugin (pluginDownload) on the old site and pastes the importCode under Tools → Move to AnyPress, ' +
      'or runs `wp anypress-export send <code>`. The code works for 7 days. The store stays Pending until the move is done; follow it with get_stores action wait. ' +
      'Once moved the store is on hold (onHold): no scheduled tasks, email only to its owner, not indexed, until the owner says it is live (store_status action go_live). ' +
      'Multisite networks cannot be moved.',
    input: {
      ...ref,
      name: z.string().optional().describe('For start: display name, at most 30 characters, starting and ending with a letter or digit'),
      customDomainName: z.string().optional().describe('For start: a custom domain for the store, e.g. shop.example.com'),
      wordPressUserName: z.string().optional().describe('For start: an administrator to add to the moved site, besides its own users'),
      wordPressUserEmail: z.string().optional(),
      size: size.optional().describe('For start: small when omitted. The site’s files and database must fit in its storage.'),
    },
    actions: {
      start: {
        access: 'write',
        does: 'creates the store that waits for the site, and answers its importCode and pluginDownload; externalId is your own id for it',
        run: async ({ tenantId: _tenantId, name, ...args }) => {
          const created = await client.tenants.create({ ...args, name: need(name, 'name', 'start'), uploadCustomSnapshot: true });
          const { uploadUrl: _uploadUrl, ...rest } = created as typeof created & { uploadUrl?: string };
          return { ...rest, pluginDownload: pluginDownload(created.importCode) };
        },
      },
      new_code: {
        access: 'write',
        does: 'a fresh import code for a store still waiting for its site; the old code stops working',
        run: async (args) => {
          const result = await client.tenants.newImportCode(toRef(args));
          return { ...result, pluginDownload: pluginDownload(result.importCode) };
        },
      },
    },
  });

  actionTool('update_store', {
    title: 'Change a store', area: 'stores',
    description: 'Changes a store’s settings or version.' + WAIT_NOTE,
    input: {
      ...ref,
      wpOptions: stringMap.optional().describe('For options: WordPress options to set, by option name'),
      phpConstants: phpConstants.optional().describe('For options: PHP constants to define, by name'),
      size: size.optional().describe('For options: move the store to this size (restarts it once)'),
      targetVersionId: z.string().optional().describe('For move: the version to move to'),
    },
    actions: {
      options: {
        access: 'write',
        does: 'sets wpOptions and phpConstants, or size',
        run: ({ wpOptions, phpConstants, size, ...args }) => client.tenants.update(toRef(args), { wpOptions, phpConstants, size }),
      },
      move: {
        access: 'write',
        does: 'moves the store to targetVersionId',
        run: ({ targetVersionId, ...args }) => client.tenants.moveToVersion(toRef(args), need(targetVersionId, 'targetVersionId', 'move')),
      },
    },
  });

  actionTool('store_status', {
    title: 'Suspend, resume, make live or delete a store', area: 'stores',
    description: 'Takes a store offline, brings it back, makes a site moved in live, or deletes it.',
    input: { ...ref, takeBackup: z.boolean().optional().describe('For suspend: back up first, true when omitted') },
    actions: {
      suspend: { access: 'write', destructive: true, does: 'takes the store offline, backing it up first unless takeBackup is false', run: ({ takeBackup, ...args }) => client.tenants.suspend(toRef(args), { takeBackup: takeBackup ?? true }) },
      resume: { access: 'write', does: 'brings a suspended store back online', run: (args) => client.tenants.resume(toRef(args)) },
      go_live: {
        access: 'write',
        does: 'ends the hold on a site moved in (onHold): its scheduled tasks start, it emails customers again and search engines may index it; ask the owner first',
        run: (args) => client.tenants.goLive(toRef(args)),
      },
      delete: { access: 'write', destructive: true, does: 'deletes the store; its backups are kept for the retention period, so it can be restored until then', run: (args) => client.tenants.delete(toRef(args)) },
    },
  });

  // Backups

  actionTool('manage_backups', {
    title: 'Backups', area: 'backups',
    description: 'A store’s backups.',
    input: { ...ref, backupId: z.string().optional().describe('For restore: the backup to restore; the newest finished one when omitted') },
    actions: {
      list: { access: 'read', does: 'the store’s backups with their status and dates', run: (args) => client.tenants.listBackups(toRef(args)) },
      create: { access: 'write', does: 'takes a full backup (files and database); list shows when it is Done', run: (args) => client.tenants.createBackup(toRef(args)) },
      restore: {
        access: 'write',
        destructive: true,
        does: 're-creates a deleted store, or rolls a live one back, replacing its files and database; then wait',
        run: ({ backupId, ...args }) => client.tenants.restore(toRef(args), backupId ? { backupId } : {}),
      },
    },
  });

  // Domains

  actionTool('manage_domain', {
    title: 'Domains', area: 'domains',
    description: 'A store’s domains. Changes are scheduled; wait after each one.',
    input: {
      ...ref,
      domainName: z.string().optional().describe('The domain, e.g. shop.example.com'),
      setAsMainDomain: z.boolean().optional().describe('For add: make it the main domain'),
      service: z.enum(['website', 'email']).optional().describe("For connect_link: 'website' points the domain at the store; 'email' adds the sending domain's records"),
    },
    actions: {
      list: { access: 'read', does: 'the store’s domains, including which one is main', run: (args) => client.domains.list(toRef(args)) },
      check: { access: 'read', does: 'whether domainName is free to use; needs no store', run: ({ domainName }) => client.domains.checkAvailability(need(domainName, 'domainName', 'check')) },
      connect_link: {
        access: 'read',
        does: 'a Domain Connect link the domain’s owner opens to add the DNS records in one click, for domainName and service',
        run: ({ domainName, service, ...args }) => client.domainConnect(toRef(args), need(domainName, 'domainName', 'connect_link'), need(service, 'service', 'connect_link')),
      },
      add: {
        access: 'write',
        does: 'adds domainName, optionally as the main domain; it must point at the platform first',
        run: ({ domainName, setAsMainDomain, ...args }) => client.domains.add(toRef(args), { domainName: need(domainName, 'domainName', 'add'), setAsMainDomain }),
      },
      set_main: { access: 'write', does: 'makes domainName the main domain (the address WordPress uses)', run: ({ domainName, ...args }) => client.domains.setMain(toRef(args), { domainName: need(domainName, 'domainName', 'set_main') }) },
      remove: { access: 'write', destructive: true, does: 'removes domainName from the store', run: ({ domainName, ...args }) => client.domains.remove(toRef(args), { domainName: need(domainName, 'domainName', 'remove') }) },
    },
  });

  // Email

  actionTool('mail_domain', {
    title: 'Sending domain', area: 'email',
    description: 'The domain a store sends email from.',
    input: { ...ref, domainName: z.string().optional().describe('For set: the domain to send from, e.g. mail.example.com') },
    actions: {
      get: { access: 'read', does: 'the sending domain, its DNS records and whether they verify; null when the store sends from the platform address', run: (args) => client.mailDomain.get(toRef(args)) },
      set: { access: 'write', does: 'sends from domainName and returns the DNS records it needs', run: ({ domainName, ...args }) => client.mailDomain.set(toRef(args), need(domainName, 'domainName', 'set')) },
      remove: { access: 'write', destructive: true, does: 'goes back to sending from the platform address', run: (args) => client.mailDomain.remove(toRef(args)) },
    },
  });

  // Versions, snapshots, templates

  actionTool('manage_versions', {
    title: 'Versions', area: 'versions',
    description: 'Versions of your product (a staging WordPress stores are made from), their snapshots and templates.',
    input: {
      versionId: z.string().optional().describe('For set_production and delete: the version. For snapshots: only this version’s'),
      name: z.string().optional().describe('For create: at most 30 characters, letters, digits, dashes and dots'),
      wordPressVersion: z.string().optional().describe('For create: e.g. 6.8'),
      phpVersion: z.string().optional().describe('For create: e.g. 8.3'),
      snapshotId: z.string().optional().describe('For create: start from this snapshot'),
    },
    actions: {
      list: { access: 'read', does: 'versions with their status and which is production', run: () => client.versions.list() },
      snapshots: { access: 'read', does: 'snapshots new stores can start from', run: ({ versionId }) => client.snapshots.list(versionId ? { versionId } : {}) },
      templates: { access: 'read', does: 'base snapshots new versions can start from', run: () => client.templates.list() },
      create: {
        access: 'write',
        does: 'creates a version from name, wordPressVersion and phpVersion; list shows when it is Done',
        run: ({ name, wordPressVersion, phpVersion, snapshotId }) =>
          client.versions.create({ name: need(name, 'name', 'create'), wordPressVersion: need(wordPressVersion, 'wordPressVersion', 'create'), phpVersion: need(phpVersion, 'phpVersion', 'create'), snapshotId }),
      },
      set_production: { access: 'write', does: 'new stores are made on versionId unless they name another', run: ({ versionId }) => client.versions.setProduction(need(versionId, 'versionId', 'set_production')) },
      delete: { access: 'write', destructive: true, does: 'deletes versionId; stores must be moved off it first', run: ({ versionId }) => client.versions.delete(need(versionId, 'versionId', 'delete')) },
    },
  });

  // Webhooks: store and version events sent to your own URL (docs/webhooks.md), for automations and apps.

  const EVENT_TYPES = [
    'tenant.ready', 'tenant.updated', 'tenant.version_changed', 'tenant.domains_changed', 'tenant.suspended', 'tenant.resumed', 'tenant.deleted',
    'tenant.restored', 'tenant.rolled_back', 'tenant.backup_completed', 'tenant.backup_failed', 'tenant.failed', 'version.ready', 'version.deleted',
    'version.failed', 'webhook.test',
  ] as const;
  actionTool('manage_webhooks', {
    title: 'Webhooks', area: 'webhooks',
    description: 'Endpoints that get a signed POST when something happens to your stores or versions, such as tenant.ready when a new store is up.',
    input: {
      webhookId: z.string().optional().describe('The endpoint, from list; for everything but list and create'),
      deliveryId: z.string().optional().describe('For retry: the delivery, from deliveries'),
      url: z.string().url().optional().describe('For create and update: the https URL to send events to'),
      description: z.string().optional().describe('For create and update: what the endpoint is for'),
      eventTypes: z.array(z.enum(EVENT_TYPES)).optional().describe('For create and update: the events to send; every event when omitted on create'),
      enabled: z.boolean().optional().describe('For update: false pauses the endpoint, true starts it again'),
    },
    actions: {
      list: { access: 'read', does: 'your webhook endpoints', run: () => client.webhooks.list() },
      get: { access: 'read', does: 'one endpoint', run: ({ webhookId }) => client.webhooks.get(need(webhookId, 'webhookId', 'get')) },
      deliveries: { access: 'read', does: 'the endpoint’s recent deliveries, with status and response', run: ({ webhookId }) => client.webhooks.deliveries(need(webhookId, 'webhookId', 'deliveries')) },
      create: {
        access: 'write',
        does: 'adds an endpoint for url and returns its signing secret, shown only this once',
        run: ({ url, description, eventTypes }) => client.webhooks.create({ url: need(url, 'url', 'create'), description, eventTypes }),
      },
      update: {
        access: 'write',
        does: 'changes the endpoint’s url, description, eventTypes or enabled',
        run: ({ webhookId, url, description, eventTypes, enabled }) => client.webhooks.update(need(webhookId, 'webhookId', 'update'), { url, description, eventTypes, enabled }),
      },
      test: { access: 'write', does: 'sends a webhook.test event to the endpoint now', run: ({ webhookId }) => client.webhooks.test(need(webhookId, 'webhookId', 'test')) },
      retry: { access: 'write', does: 'sends a failed delivery again', run: ({ deliveryId }) => client.webhooks.retryDelivery(need(deliveryId, 'deliveryId', 'retry')) },
      rotate_secret: { access: 'write', destructive: true, does: 'replaces the signing secret; the old one stops working, so update your receiver', run: ({ webhookId }) => client.webhooks.rotateSecret(need(webhookId, 'webhookId', 'rotate_secret')) },
      delete: { access: 'write', destructive: true, does: 'removes the endpoint', run: ({ webhookId }) => client.webhooks.delete(need(webhookId, 'webhookId', 'delete')) },
    },
  });

  // Site: the store's pages and design, through its WaaS Client (docs/site-editing.md).

  siteTools = true;
  type SiteCall = Parameters<WaasClient['tenants']['editSite']>[1];
  const site = async (args: StoreArgs, call: SiteCall) => {
    const answer = await client.tenants.editSite(options.store ?? toRef(args), call);
    if (answer.status && answer.status >= 400) {
      const body = answer.body as { message?: string } | undefined;
      throw new Error(`The store answered ${answer.status}: ${body?.message ?? JSON.stringify(answer.body)}`);
    }
    return answer.body;
  };
  const blocks = z.string().describe('WordPress block markup (<!-- wp:paragraph --><p>…</p><!-- /wp:paragraph -->). Use the theme’s colour, font-size and spacing slugs from site_styles, not raw values.');
  const pattern = z.string().describe('A pattern name from site_patterns, e.g. anypress/hero-statement');
  const pageId = z.number().int().positive().describe('The page id, from site_pages list');

  tool(
    'get_site',
    { title: 'Get a site', area: 'site', description: 'The site’s name, tagline, address, theme and what its home page shows. Start here before editing a site.', input: ref, annotations: READ },
    (args) => site(args, { method: 'GET', path: '' }),
  );

  actionTool('site_pages', {
    title: 'Pages', area: 'site',
    description: 'The site’s pages. WordPress keeps a revision of every change.',
    input: {
      ...ref,
      pageId: pageId.optional(),
      title: z.string().optional().describe('For create (required) and update'),
      slug: z.string().optional().describe('For update'),
      status: z.enum(['draft', 'publish']).optional().describe('For create and update; publish only when the user says so'),
      content: blocks.optional().describe('For create and update: the whole page as block markup. To change one part, use page_section'),
      revisionId: z.number().int().positive().optional().describe('For restore_revision'),
    },
    actions: {
      list: { access: 'read', does: 'id, title, slug, status and link of each page (a preview link for drafts)', run: (args) => site(args, { method: 'GET', path: '/pages' }) },
      read: {
        access: 'read',
        does: 'one page’s outline (numbered sections, 0 first) and full block markup; read a page before changing it',
        run: ({ pageId: id, ...args }) => site(args, { method: 'GET', path: `/pages/${need(id, 'pageId', 'read')}` }),
      },
      revisions: { access: 'read', does: 'a page’s last 20 saved versions, newest first', run: ({ pageId: id, ...args }) => site(args, { method: 'GET', path: `/pages/${need(id, 'pageId', 'revisions')}/revisions` }) },
      create: {
        access: 'write',
        does: 'adds a page, a draft with a preview link unless status is publish',
        run: ({ title, content, status, ...args }) => site(args, { method: 'POST', path: '/pages', body: { title: need(title, 'title', 'create'), content, status } }),
      },
      update: {
        access: 'write',
        does: 'changes a page’s title, slug or status, or replaces all its content',
        run: ({ pageId: id, title, slug, status, content, ...args }) => site(args, { method: 'PATCH', path: `/pages/${need(id, 'pageId', 'update')}`, body: { title, slug, status, content } }),
      },
      restore_revision: {
        access: 'write',
        does: 'puts a page back the way it was in revisionId (undo)',
        run: ({ pageId: id, revisionId, ...args }) => site(args, { method: 'POST', path: `/pages/${need(id, 'pageId', 'restore_revision')}/revisions/${need(revisionId, 'revisionId', 'restore_revision')}/restore` }),
      },
    },
  });

  actionTool('page_section', {
    title: 'Page sections', area: 'site',
    description: 'One section of a page at a time, from a pattern (preferred, it matches the site’s design) or your own blocks. Sections are numbered in site_pages read.',
    input: {
      ...ref,
      pageId,
      section: z.number().int().min(0).optional().describe('A section number from the page outline; 0 is the first. For add: goes before this section, or at the end when omitted'),
      pattern: pattern.optional(),
      content: blocks.optional(),
    },
    actions: {
      add: {
        access: 'write',
        does: 'adds a pattern or content; then replace the pattern’s sample text and images with the user’s own',
        run: ({ pageId: id, pattern: name, content, section, ...args }) => site(args, { method: 'POST', path: `/pages/${id}/sections`, body: { pattern: name, content, position: section } }),
      },
      replace: {
        access: 'write',
        does: 'replaces a section; copy its markup from site_pages read and change only what the user asked for',
        run: ({ pageId: id, section, pattern: name, content, ...args }) => site(args, { method: 'PUT', path: `/pages/${id}/sections/${need(section, 'section', 'replace')}`, body: { pattern: name, content } }),
      },
      remove: {
        access: 'write',
        destructive: true,
        does: 'removes a section; site_pages restore_revision can bring it back',
        run: ({ pageId: id, section, ...args }) => site(args, { method: 'DELETE', path: `/pages/${id}/sections/${need(section, 'section', 'remove')}` }),
      },
    },
  });

  actionTool('site_patterns', {
    title: 'Patterns', area: 'site',
    description: 'Ready-made sections (heroes, features, pricing, testimonials, contact, footers…) the theme offers, and whole starter pages (category anypress/pages).',
    input: { ...ref, search: z.string().optional().describe('For find'), category: z.string().optional().describe('For find'), name: pattern.optional().describe('For get') },
    actions: {
      find: {
        access: 'read',
        does: 'patterns, filtered by a search word or category',
        run: ({ search, category, ...args }) => site(args, { method: 'GET', path: '/patterns', query: { ...(search ? { search } : {}), ...(category ? { category } : {}) } }),
      },
      get: { access: 'read', does: 'one pattern’s block markup, to adapt before adding it', run: ({ name, ...args }) => site(args, { method: 'GET', path: `/patterns/${need(name, 'name', 'get')}` }) },
    },
  });

  actionTool('site_styles', {
    title: 'Site styles', area: 'site',
    description: 'The whole site’s look, as Styles in the Site Editor.',
    input: {
      ...ref,
      settings: z.record(z.string(), z.unknown()).optional().describe('For update: theme.json settings, e.g. settings.color.palette.custom'),
      styles: z.record(z.string(), z.unknown()).optional().describe('For update: theme.json styles, e.g. styles.elements.button.color.background'),
    },
    actions: {
      get: { access: 'read', does: 'colours, fonts, font sizes and spacing with the slugs to use in blocks, and what the site changed from the theme', run: (args) => site(args, { method: 'GET', path: '/styles' }) },
      update: { access: 'write', does: 'merges settings and styles into the site’s changes', run: ({ settings, styles, ...args }) => site(args, { method: 'PATCH', path: '/styles', body: { settings, styles } }) },
    },
  });

  actionTool('header_footer', {
    title: 'Header and footer', area: 'site',
    description: 'The header or footer every page shows.',
    input: { ...ref, part: z.enum(['header', 'footer']), content: blocks.optional().describe('For update: the whole part as block markup') },
    actions: {
      get: { access: 'read', does: 'the part as blocks, with its outline', run: ({ part, ...args }) => site(args, { method: 'GET', path: `/parts/${part}` }) },
      update: {
        access: 'write',
        does: 'replaces the whole part; start from get and change only what the user asked for',
        run: ({ part, content, ...args }) => site(args, { method: 'PUT', path: `/parts/${part}`, body: { content: need(content, 'content', 'update') } }),
      },
    },
  });

  actionTool('site_menus', {
    title: 'Menus', area: 'site',
    description: 'The site’s navigation menus.',
    input: {
      ...ref,
      menuId: z.number().int().positive().optional().describe('For update'),
      content: z
        .string()
        .optional()
        .describe('For update: the links. Pages: <!-- wp:navigation-link {"label":"About","type":"page","id":12,"kind":"post-type"} /-->; other addresses: {"label":"…","url":"https://…","kind":"custom"}'),
      title: z.string().optional().describe('For update'),
    },
    actions: {
      list: { access: 'read', does: 'every menu with its links', run: (args) => site(args, { method: 'GET', path: '/menus' }) },
      update: {
        access: 'write',
        does: 'replaces a menu’s links',
        run: ({ menuId, content, title, ...args }) => site(args, { method: 'PUT', path: `/menus/${need(menuId, 'menuId', 'update')}`, body: { content: need(content, 'content', 'update'), title } }),
      },
    },
  });

  tool(
    'add_image',
    {
      title: 'Add an image', area: 'site',
      description: 'Copies an image from a public https link into the site’s media library and returns its id and address, to use in an image or cover block.',
      input: { ...ref, url: z.string().url(), alt: z.string().optional().describe('What the image shows, for people who can’t see it.') },
      annotations: WRITE,
    },
    ({ url, alt, ...args }) => site(args, { method: 'POST', path: '/media', body: { url, alt } }),
  );

  return server;
}

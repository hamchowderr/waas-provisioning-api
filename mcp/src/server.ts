import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { McpServer, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/server';
import { TenantFailedError, WaasApiError, type TenantRef, type WaasClient } from 'waas-provisioning-sdk';
import { z } from 'zod';
import { storesViewHtml, STORES_VIEW_URI } from './view.js';

export interface WaasMcpOptions {
  /** Registers only the tools that read; nothing the agent calls can change a store. */
  readOnly?: boolean;
  /** How often wait_for_store polls (tests shorten it). */
  pollIntervalMs?: number;
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
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const ASYNC_NOTE = ' Returns once the work is scheduled; call wait_for_store until the store is Done.';

function toRef(args: { externalId?: string | undefined; tenantId?: string | undefined }): TenantRef {
  if (args.externalId && args.tenantId) throw new UsageError('Give externalId or tenantId, not both.');
  if (args.externalId) return { externalId: args.externalId };
  if (args.tenantId) return { tenantId: args.tenantId };
  throw new UsageError('Give the store’s externalId or tenantId.');
}

class UsageError extends Error {}

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

/**
 * An MCP server whose tools call the WaaS provisioning API through the TypeScript SDK:
 * stores (tenants), their domains, backups, sending domain and lifecycle, plus versions,
 * snapshots and templates, plus the show_stores panel (MCP App). Serve it with serveStdio or
 * createMcpHandler from @modelcontextprotocol/server; it is built per connection or request.
 */
export function createWaasMcpServer(client: WaasClient, options: WaasMcpOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'waas-provisioning', version: '0.1.0' },
    {
      instructions:
        'Manages WordPress stores on the WaaS provisioning API. A store is a "tenant"; pick one by externalId (your own id) or tenantId. ' +
        'Every write is asynchronous: it returns once scheduled, and the store shows statusCode 0 (Pending) until the work finishes, then 1 (Done) or 2 (Failed). ' +
        'Call wait_for_store after creating, restoring, moving or changing domains, and before the next write to the same store.' +
        (options.readOnly ? ' This server is read-only: it cannot change anything.' : ''),
    },
  );

  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; input: Shape; annotations: ToolAnnotations },
    run: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ) => {
    if (options.readOnly && !config.annotations.readOnlyHint) return;
    server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema: z.object(config.input), annotations: config.annotations },
      async (args) => {
        try {
          return json(await run(args as z.infer<z.ZodObject<Shape>>));
        } catch (error) {
          return failure(error);
        }
      },
    );
  };

  // MCP App: a store panel that renders in clients supporting MCP Apps (Claude, ChatGPT, VS Code...).
  // Clients without it get the same list as text.

  registerAppTool(
    server,
    'show_stores',
    {
      title: 'Show stores',
      description:
        'Shows your stores in an interactive panel (status, main domain, version) with buttons to back up, suspend and resume. ' +
        'Use when the user wants to see or browse their stores; use list_stores when you only need the data.',
      inputSchema: z.object({}),
      annotations: READ,
      _meta: { ui: { resourceUri: STORES_VIEW_URI } },
    },
    async () => {
      try {
        const stores = await client.tenants.list();
        const summary = stores.length === 1 ? '1 store' : `${stores.length} stores`;
        return {
          content: [{ type: 'text', text: `${summary}:\n${JSON.stringify(stores, null, 2)}` }],
          structuredContent: { stores, readOnly: !!options.readOnly },
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  registerAppResource(server, 'Store panel', STORES_VIEW_URI, { description: 'The show_stores panel' }, async () => ({
    contents: [{ uri: STORES_VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: storesViewHtml() }],
  }));

  // Stores

  tool(
    'list_stores',
    { title: 'List stores', description: 'Lists every store of your product with its status, version and main domain.', input: {}, annotations: READ },
    () => client.tenants.list(),
  );

  tool(
    'get_store',
    { title: 'Get a store', description: 'One store: status, version, snapshot, main domain and dates. Null when no store has that id.', input: ref, annotations: READ },
    (args) => client.tenants.get(toRef(args)),
  );

  tool(
    'wait_for_store',
    {
      title: 'Wait for a store',
      description:
        'Polls the store until it is Done (returns it) or Failed (an error), for up to timeoutSeconds. ' +
        'If it is still working when the time is up, returns { done: false, store } so you can call again.',
      input: { ...ref, timeoutSeconds: z.number().int().min(1).max(600).default(120).describe('How long to wait, at most 600') },
      annotations: READ,
    },
    async (args) => {
      const storeRef = toRef(args);
      try {
        const store = await client.waitForTenant(storeRef, { intervalMs: options.pollIntervalMs ?? 5_000, timeoutMs: args.timeoutSeconds * 1000 });
        return { done: true, store };
      } catch (error) {
        if (error instanceof WaasApiError || error instanceof TenantFailedError) throw error;
        return { done: false, store: await client.tenants.get(storeRef) };
      }
    },
  );

  tool(
    'create_store',
    {
      title: 'Create a store',
      description:
        'Creates a new WordPress store on the production version (or versionId), from the newest snapshot (or snapshotId / groupName).' +
        ' Repeating a create with the same externalId answers with the store it already made.' +
        ASYNC_NOTE,
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

  tool(
    'update_store_options',
    {
      title: 'Set WordPress options, PHP constants and size',
      description: 'Sets WordPress options and PHP constants on a store, or moves it to another size (restarting it once).' + ASYNC_NOTE,
      input: { ...ref, wpOptions: stringMap.optional(), phpConstants: phpConstants.optional(), size: size.optional() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ wpOptions, phpConstants, size, ...args }) => client.tenants.update(toRef(args), { wpOptions, phpConstants, size }),
  );

  tool(
    'suspend_store',
    {
      title: 'Suspend a store',
      description: 'Takes the store offline, backing it up first unless takeBackup is false. resume_store brings it back.',
      input: { ...ref, takeBackup: z.boolean().default(true) },
      annotations: DESTRUCTIVE,
    },
    ({ takeBackup, ...args }) => client.tenants.suspend(toRef(args), { takeBackup }),
  );

  tool(
    'resume_store',
    { title: 'Resume a store', description: 'Brings a suspended store back online.', input: ref, annotations: { ...WRITE, idempotentHint: true } },
    (args) => client.tenants.resume(toRef(args)),
  );

  tool(
    'delete_store',
    {
      title: 'Delete a store',
      description: 'Deletes the store. Its backups are kept for the retention period, so restore_store can bring it back until then.',
      input: ref,
      annotations: DESTRUCTIVE,
    },
    (args) => client.tenants.delete(toRef(args)),
  );

  tool(
    'restore_store',
    {
      title: 'Restore a store from a backup',
      description:
        'Re-creates a deleted store, or rolls a live one back, from a backup (the newest finished one when backupId is omitted). ' +
        'Rolling back replaces the live files and database.' +
        ASYNC_NOTE,
      input: { ...ref, backupId: z.string().optional().describe('From list_store_backups') },
      annotations: DESTRUCTIVE,
    },
    ({ backupId, ...args }) => client.tenants.restore(toRef(args), backupId ? { backupId } : {}),
  );

  tool(
    'move_store_to_version',
    {
      title: 'Move a store to another version',
      description: 'Moves the store to another version of your product (see list_versions).' + ASYNC_NOTE,
      input: { ...ref, targetVersionId: z.string() },
      annotations: WRITE,
    },
    ({ targetVersionId, ...args }) => client.tenants.moveToVersion(toRef(args), targetVersionId),
  );

  // Backups

  tool(
    'list_store_backups',
    { title: 'List backups', description: "A store's backups with their status and dates.", input: ref, annotations: READ },
    (args) => client.tenants.listBackups(toRef(args)),
  );

  tool(
    'create_store_backup',
    { title: 'Back up a store', description: 'Takes a full backup (files and database). Poll list_store_backups for its status.', input: ref, annotations: WRITE },
    (args) => client.tenants.createBackup(toRef(args)),
  );

  // Domains

  tool(
    'list_store_domains',
    { title: 'List domains', description: "A store's domains, including which one is main.", input: ref, annotations: READ },
    (args) => client.domains.list(toRef(args)),
  );

  tool(
    'check_domain_availability',
    { title: 'Check a domain', description: 'Whether a domain is free to use as a store domain.', input: { domain: z.string() }, annotations: READ },
    ({ domain }) => client.domains.checkAvailability(domain),
  );

  tool(
    'add_store_domain',
    {
      title: 'Add a domain',
      description:
        'Adds a custom domain to the store, optionally as its main domain. The domain must point at the platform; get_domain_connect_link can set that up.' +
        ASYNC_NOTE,
      input: { ...ref, domainName: z.string(), setAsMainDomain: z.boolean().optional() },
      annotations: WRITE,
    },
    ({ domainName, setAsMainDomain, ...args }) => client.domains.add(toRef(args), { domainName, setAsMainDomain }),
  );

  tool(
    'set_store_main_domain',
    {
      title: 'Set the main domain',
      description: 'Makes one of the store’s domains its main domain (the address WordPress uses).' + ASYNC_NOTE,
      input: { ...ref, domainName: z.string() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ domainName, ...args }) => client.domains.setMain(toRef(args), { domainName }),
  );

  tool(
    'remove_store_domain',
    { title: 'Remove a domain', description: 'Removes a domain from the store.' + ASYNC_NOTE, input: { ...ref, domainName: z.string() }, annotations: DESTRUCTIVE },
    ({ domainName, ...args }) => client.domains.remove(toRef(args), { domainName }),
  );

  tool(
    'get_domain_connect_link',
    {
      title: 'Get a Domain Connect link',
      description:
        "A link the domain's owner opens to add the store's DNS records at their DNS host in one click, when the host supports Domain Connect. " +
        "service 'website' points the domain at the store; 'email' adds the sending domain's records.",
      input: { ...ref, domainName: z.string(), service: z.enum(['website', 'email']) },
      annotations: READ,
    },
    ({ domainName, service, ...args }) => client.domainConnect(toRef(args), domainName, service),
  );

  // Sending domain

  tool(
    'get_store_mail_domain',
    {
      title: 'Get the sending domain',
      description: "The store's own email sending domain with the DNS records to add and whether they verify. Null when the store sends from the platform address.",
      input: ref,
      annotations: READ,
    },
    (args) => client.mailDomain.get(toRef(args)),
  );

  tool(
    'set_store_mail_domain',
    {
      title: 'Set the sending domain',
      description: 'Makes the store send email from its own domain. Returns the DNS records the domain needs.',
      input: { ...ref, domainName: z.string() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ domainName, ...args }) => client.mailDomain.set(toRef(args), domainName),
  );

  tool(
    'remove_store_mail_domain',
    { title: 'Remove the sending domain', description: 'The store goes back to sending from the platform address.', input: ref, annotations: DESTRUCTIVE },
    (args) => client.mailDomain.remove(toRef(args)),
  );

  // Versions, snapshots, templates

  tool(
    'list_versions',
    { title: 'List versions', description: 'Versions of your product (PHP and WordPress versions, which is production).', input: {}, annotations: READ },
    () => client.versions.list(),
  );

  tool(
    'create_version',
    {
      title: 'Create a version',
      description: 'Creates a version: a staging WordPress that new stores can be made from. Poll list_versions for its status.',
      input: {
        name: z.string().describe('At most 30 characters: letters, digits, dashes and dots'),
        wordPressVersion: z.string().describe('e.g. 6.8'),
        phpVersion: z.string().describe('e.g. 8.3'),
        snapshotId: z.string().optional().describe('Start from this snapshot'),
      },
      annotations: WRITE,
    },
    (args) => client.versions.create(args),
  );

  tool(
    'set_production_version',
    {
      title: 'Set the production version',
      description: 'New stores are created on the production version unless they name another.',
      input: { versionId: z.string() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ versionId }) => client.versions.setProduction(versionId),
  );

  tool(
    'delete_version',
    { title: 'Delete a version', description: 'Deletes a version. Stores must be moved off it first.', input: { versionId: z.string() }, annotations: DESTRUCTIVE },
    ({ versionId }) => client.versions.delete(versionId),
  );

  tool(
    'list_snapshots',
    {
      title: 'List snapshots',
      description: 'Snapshots new stores can start from, optionally for one version.',
      input: { versionId: z.string().optional() },
      annotations: READ,
    },
    ({ versionId }) => client.snapshots.list(versionId ? { versionId } : {}),
  );

  tool(
    'list_templates',
    { title: 'List templates', description: 'Base snapshots (templates) new versions can start from.', input: {}, annotations: READ },
    () => client.templates.list(),
  );

  return server;
}

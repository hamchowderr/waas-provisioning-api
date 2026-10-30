// Drives the MCP server (mcp/) through real MCP clients over the API's /mcp endpoint (src/mcp.ts):
// a 2026-07-28 client and a 2025-era one, against the app with the fake provisioner.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSkills } from '../mcp/src/skills.ts';
import { storesViewHtml, viewHtml } from '../mcp/src/view.ts';
import { StatusCode, WaasClient } from '../sdk/typescript/src/index.ts';
import { createApiKey } from '../src/keys.ts';
import { basic, setup, type TestContext } from './helpers.ts';

let t: TestContext;
let auth: string;
let mcp: Client;

const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  return t.app.request(`${url.pathname}${url.search}`, init);
}) as typeof fetch;

async function connect(path = '/mcp', mode: 'auto' | 'legacy' = 'auto') {
  const transport = new StreamableHTTPClientTransport(new URL(`https://api.example.test${path}`), {
    fetch: appFetch,
    requestInit: { headers: { Authorization: auth } },
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]!.text;
  return { isError: result.isError === true, text, data: result.isError ? undefined : text === 'Done.' ? undefined : JSON.parse(text) };
}

beforeAll(async () => {
  t = await setup();
  const created = await createApiKey(t.pool, t.productId);
  auth = basic(created.key, created.secret);
  const waas = new WaasClient({ baseUrl: 'https://api.example.test', apiKey: created.key, apiSecret: created.secret, fetch: appFetch });
  const version = await waas.versions.create({ name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true });
  for (let i = 0; (await waas.versions.list({ versionId: version.id }))[0]?.statusCode !== StatusCode.Done; i++) {
    if (i > 150) throw new Error('version never became Done');
    await new Promise((r) => setTimeout(r, 100));
  }
  await waas.versions.setProduction(version.id!);
  mcp = await connect();
});
afterAll(async () => {
  await mcp?.close();
  await t.close();
});

describe('MCP server', () => {
  it('speaks MCP 2026-07-28, and 2025-era clients still work', async () => {
    expect(mcp.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const legacy = await connect('/mcp', 'legacy');
    expect(legacy.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect((await legacy.listTools()).tools.map((tool) => tool.name)).toContain('create_store');
    await legacy.close();
  });

  it('asks for credentials', async () => {
    const response = await t.app.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toMatch(/^Bearer resource_metadata=.*, Basic realm=/);
    const wrong = await t.app.request('/mcp', { method: 'POST', headers: { Authorization: basic('nope', 'nope') }, body: '{}' });
    expect(wrong.status).toBe(401);
  });

  it('offers about 20 tools, with actions and read-only and destructive hints', async () => {
    const { tools } = await mcp.listTools();
    expect(tools.length).toBe(22);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('get_stores')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('store_status')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('create_store')?.inputSchema.required).toEqual(['name']);
    expect(byName.get('manage_domain')?.inputSchema.required).toEqual(['action']);
    expect((byName.get('manage_domain')?.inputSchema.properties?.action as { enum: string[] }).enum).toEqual(['list', 'check', 'connect_link', 'add', 'set_main', 'remove']);
    expect(byName.get('manage_domain')?.description).toContain('set_main (makes domainName the main domain');
  });

  it('creates a store and waits until it is Done', async () => {
    const created = await call(mcp, 'create_store', { name: 'MCP store', externalId: 'mcp-1' });
    expect(created.data).toMatchObject({ externalId: 'mcp-1' });

    const waited = await call(mcp, 'get_stores', { action: 'wait', externalId: 'mcp-1', timeoutSeconds: 15 });
    expect(waited.data).toMatchObject({ done: true, store: { externalId: 'mcp-1', statusCode: StatusCode.Done } });
    expect((await call(mcp, 'get_stores', { action: 'list' })).data.map((s: { externalId: string }) => s.externalId)).toContain('mcp-1');
    expect((await call(mcp, 'get_stores', { action: 'get', externalId: 'nope' })).data).toBeNull();
  });

  it('manages domains', async () => {
    expect((await call(mcp, 'manage_domain', { action: 'check', domainName: 'shop.mcp-example.com' })).data).toMatchObject({ available: true });
    expect(await call(mcp, 'manage_domain', { action: 'add', externalId: 'mcp-1' })).toMatchObject({ isError: true, text: 'Action add needs domainName.' });
    await call(mcp, 'manage_domain', { action: 'add', externalId: 'mcp-1', domainName: 'shop.mcp-example.com' });
    const domains = (await call(mcp, 'manage_domain', { action: 'list', externalId: 'mcp-1' })).data;
    expect(domains.map((d: { domainName: string }) => d.domainName)).toContain('shop.mcp-example.com');
    await call(mcp, 'get_stores', { action: 'wait', externalId: 'mcp-1', timeoutSeconds: 15 });
    expect((await call(mcp, 'manage_domain', { action: 'remove', externalId: 'mcp-1', domainName: 'shop.mcp-example.com' })).isError).toBe(false);
  });

  it('manages webhook endpoints', async () => {
    expect(await call(mcp, 'manage_webhooks', { action: 'create' })).toMatchObject({ isError: true, text: 'Action create needs url.' });
    const created = (await call(mcp, 'manage_webhooks', { action: 'create', url: 'https://hooks.mcp-example.com/anypress', eventTypes: ['tenant.ready'] })).data;
    expect(created).toMatchObject({ url: 'https://hooks.mcp-example.com/anypress', eventTypes: ['tenant.ready'] });
    expect(created.secret).toBeTruthy();
    const listed = (await call(mcp, 'manage_webhooks', { action: 'list' })).data;
    expect(JSON.stringify(listed)).toContain(created.id);
    expect((await call(mcp, 'manage_webhooks', { action: 'update', webhookId: created.id, enabled: false })).data).toMatchObject({ enabled: false });
    expect((await call(mcp, 'manage_webhooks', { action: 'deliveries', webhookId: created.id })).isError).toBe(false);
    expect((await call(mcp, 'manage_webhooks', { action: 'delete', webhookId: created.id })).isError).toBe(false);
  });

  it('suspends, backs up and resumes a store', async () => {
    await call(mcp, 'get_stores', { action: 'wait', externalId: 'mcp-1', timeoutSeconds: 15 });
    expect((await call(mcp, 'store_status', { action: 'suspend', externalId: 'mcp-1', takeBackup: false })).data).toMatchObject({ externalId: 'mcp-1' });
    const { backupId } = (await call(mcp, 'manage_backups', { action: 'create', externalId: 'mcp-1' })).data;
    const backups = (await call(mcp, 'manage_backups', { action: 'list', externalId: 'mcp-1' })).data;
    expect(backups.map((b: { id: string }) => b.id)).toContain(backupId);
    expect((await call(mcp, 'store_status', { action: 'resume', externalId: 'mcp-1' })).data).toMatchObject({ externalId: 'mcp-1' });
  });

  it('moves a site in: a store waiting for its site, an import code and the plugin link', async () => {
    const created = await call(mcp, 'import_site', { action: 'start', name: 'Moved site', externalId: 'mcp-import' });
    expect(created.data).toMatchObject({ externalId: 'mcp-import' });
    expect(created.data.importCode).toMatch(/^AP1\./);
    expect(created.data.pluginDownload).toMatch(/^https?:\/\/.+\/imports\/plugin\.zip$/);
    expect(created.data).not.toHaveProperty('uploadUrl');
    expect((await call(mcp, 'get_stores', { action: 'get', externalId: 'mcp-import' })).data).toMatchObject({ waitingForSite: true, keepsOwnCode: true });
    expect((await call(mcp, 'import_site', { action: 'start' })).text).toBe('Action start needs name.');

    const renewed = await call(mcp, 'import_site', { action: 'new_code', externalId: 'mcp-import' });
    expect(renewed.data.importCode).toMatch(/^AP1\./);
    expect(renewed.data.importCode).not.toBe(created.data.importCode);

    expect((await call(mcp, 'store_status', { action: 'delete', externalId: 'mcp-import' })).isError).toBe(false);
    for (let i = 0; (await call(mcp, 'get_stores', { action: 'get', externalId: 'mcp-import' })).data; i++) {
      if (i > 150) throw new Error('the waiting store was never removed');
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it('turns API errors, bad refs and unknown actions into tool errors', async () => {
    const bad = await call(mcp, 'create_store', { name: 'dupe', externalId: 'has space' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^The API refused createTenant \(HTTP 400\): /);

    expect(await call(mcp, 'get_stores', { action: 'get' })).toMatchObject({ isError: true, text: 'Give the store’s externalId or tenantId.' });
    expect(await call(mcp, 'get_stores', { action: 'get', externalId: 'a', tenantId: 'b' })).toMatchObject({ isError: true });
    expect((await call(mcp, 'get_stores', { action: 'explode' })).isError).toBe(true);
    expect((await call(mcp, 'get_stores', {})).isError).toBe(true);
  });

  it('offers only read actions at /mcp/read-only', async () => {
    const readOnly = await connect('/mcp/read-only');
    const { tools } = await readOnly.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('get_stores');
    expect(names).toContain('manage_domain');
    expect(names).not.toContain('create_store');
    expect(names).not.toContain('store_status');
    expect(names).not.toContain('import_site');
    const domains = tools.find((tool) => tool.name === 'manage_domain')!;
    expect((domains.inputSchema.properties?.action as { enum: string[] }).enum).toEqual(['list', 'check', 'connect_link']);
    expect(domains.annotations?.readOnlyHint).toBe(true);
    expect(domains.description).not.toContain('remove');
    // A write action isn't offered, so a call naming one is refused.
    expect((await call(readOnly, 'manage_domain', { action: 'remove', externalId: 'mcp-1', domainName: 'x.example.com' })).isError).toBe(true);
    expect((await call(readOnly, 'manage_backups', { action: 'create', externalId: 'mcp-1' })).isError).toBe(true);
    await readOnly.close();
  });

  it('shows the store panel (MCP App)', async () => {
    const { tools } = await mcp.listTools();
    const show = tools.find((tool) => tool.name === 'show_stores');
    expect(show?._meta).toMatchObject({ ui: { resourceUri: 'ui://waas/stores.html' } });

    const result = await mcp.callTool({ name: 'show_stores', arguments: {} });
    expect(result.structuredContent).toMatchObject({ readOnly: false, stores: [expect.objectContaining({ externalId: 'mcp-1' })] });

    const { contents } = await mcp.readResource({ uri: 'ui://waas/stores.html' });
    expect(contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' });
    const html = (contents[0] as { text: string }).text;
    expect(html).toBe(storesViewHtml());
    for (const marker of ['/*MCP_APPS_BUNDLE*/', '/*VIEW_STYLE*/', '/*VIEW_COMMON*/']) expect(html).not.toContain(marker);
    expect(html).toContain('globalThis.McpApps={');
    expect(html).toMatch(/globalThis\.McpApps=\{[^}]*\bApp:/);
    expect(html).toContain('globalThis.WaasView');
    // Its buttons call tools that exist.
    expect(html).toContain("'manage_backups', 'create'");
    expect(html).toContain("'store_status', 'suspend'");
  });

  it('shows one store, its backups and its domains (MCP Apps)', async () => {
    const { tools } = await mcp.listTools();
    for (const [tool, view] of [['show_store', 'store'], ['show_store_backups', 'backups'], ['show_store_domains', 'domains']] as const) {
      expect(tools.find((t) => t.name === tool)?._meta).toMatchObject({ ui: { resourceUri: `ui://waas/${view}.html` } });
      const { contents } = await mcp.readResource({ uri: `ui://waas/${view}.html` });
      expect(contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', text: viewHtml(view) });
      for (const marker of ['/*MCP_APPS_BUNDLE*/', '/*VIEW_STYLE*/', '/*VIEW_COMMON*/']) expect(viewHtml(view)).not.toContain(marker);
    }
    await call(mcp, 'get_stores', { action: 'wait', externalId: 'mcp-1', timeoutSeconds: 15 });

    const store = await mcp.callTool({ name: 'show_store', arguments: { externalId: 'mcp-1' } });
    expect(store.structuredContent).toMatchObject({
      ref: { tenantId: expect.any(String) },
      store: { externalId: 'mcp-1', size: 'small' },
      domains: [expect.objectContaining({ isMainDomain: true })],
      versions: [expect.objectContaining({ isProduction: true })],
      canBackup: true,
      canChange: true,
    });
    expect((await mcp.callTool({ name: 'show_store', arguments: { externalId: 'nope' } })).isError).toBe(true);

    const backups = await mcp.callTool({ name: 'show_store_backups', arguments: { externalId: 'mcp-1' } });
    expect(backups.structuredContent).toMatchObject({ ref: { externalId: 'mcp-1' }, store: { externalId: 'mcp-1' }, backups: [expect.objectContaining({ externalId: 'mcp-1' })], canBackup: true });

    const domains = await mcp.callTool({ name: 'show_store_domains', arguments: { externalId: 'mcp-1' } });
    expect(domains.structuredContent).toMatchObject({ ref: { externalId: 'mcp-1' }, domains: [expect.objectContaining({ isBaseDomain: true })], canChange: true });
  });

  it('serves the anypress-stores skill (Skills extension)', async () => {
    expect(mcp.getServerCapabilities()?.extensions).toMatchObject({ 'io.modelcontextprotocol/skills': {} });
    expect(mcp.getServerCapabilities()?.resources).toBeDefined();
    expect(mcp.getInstructions()).toContain('skill://anypress-stores/SKILL.md');

    const markdown = readFileSync(new URL('../mcp/skills/anypress-stores/SKILL.md', import.meta.url));
    const resources = [{ uri: 'skill://anypress-stores/SKILL.md', digest: `sha256:${createHash('sha256').update(markdown).digest('hex')}`, size: markdown.length }];
    const entry = { uri: 'skill://anypress-stores/SKILL.md', frontmatter: { name: 'anypress-stores', description: expect.stringContaining('AnyPress'), license: 'GPL-3.0-or-later' }, resources };

    const list = await mcp.request({ method: 'skills/list', params: {} }, z.object({ skills: z.array(z.any()) }).loose());
    expect(list.skills).toEqual([entry]);
    const got = await mcp.request({ method: 'skills/get', params: { uri: 'skill://anypress-stores/SKILL.md' } }, z.object({ skill: z.any() }).loose());
    expect(got.skill).toEqual(entry);
    await expect(mcp.request({ method: 'skills/get', params: { uri: 'skill://nope/SKILL.md' } }, z.object({}).loose())).rejects.toMatchObject({ code: -32602 });

    const { contents } = await mcp.readResource({ uri: 'skill://anypress-stores/SKILL.md' });
    expect(contents[0]).toMatchObject({ mimeType: 'text/markdown', text: markdown.toString('utf8') });
    const listed = (await mcp.listResources()).resources.find((r) => r.uri === 'skill://anypress-stores/SKILL.md');
    expect(listed).toMatchObject({ name: 'anypress-stores', mimeType: 'text/markdown', description: loadSkills()[0]!.frontmatter.description });

    // The skill names only tools the server has.
    const names = new Set((await mcp.listTools()).tools.map((tool) => tool.name));
    const named = [...markdown.toString('utf8').matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!);
    const tools = named.filter((name) => /^(show|get|create|update|store|manage|mail|site|page|header|add)_/.test(name));
    expect(tools.length).toBeGreaterThan(10);
    for (const name of tools) expect(names, name).toContain(name);
  });

  it('deletes a store', async () => {
    await call(mcp, 'get_stores', { action: 'wait', externalId: 'mcp-1', timeoutSeconds: 15 });
    expect(await call(mcp, 'store_status', { action: 'delete', externalId: 'mcp-1' })).toMatchObject({ isError: false, text: 'Done.' });
  });
});

describe('the container image', () => {
  it('ships the skills the MCP server reads', () => {
    // Without them every MCP session fails to start in production (loadSkills can't find the folder).
    expect(readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')).toMatch(/^COPY mcp\/skills \.\/mcp\/skills$/m);
  });
});

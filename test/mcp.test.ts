// Drives the MCP server (mcp/) through real MCP clients over the API's /mcp endpoint (src/mcp.ts):
// a 2026-07-28 client and a 2025-era one, against the app with the fake provisioner.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storesViewHtml } from '../mcp/src/view.ts';
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

  it('lists its tools with read-only and destructive hints', async () => {
    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('list_stores')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('delete_store')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('create_store')?.inputSchema.required).toEqual(['name']);
  });

  it('creates a store and waits until it is Done', async () => {
    const created = await call(mcp, 'create_store', { name: 'MCP store', externalId: 'mcp-1' });
    expect(created.data).toMatchObject({ externalId: 'mcp-1' });

    const waited = await call(mcp, 'wait_for_store', { externalId: 'mcp-1', timeoutSeconds: 15 });
    expect(waited.data).toMatchObject({ done: true, store: { externalId: 'mcp-1', statusCode: StatusCode.Done } });
    expect((await call(mcp, 'list_stores')).data.map((s: { externalId: string }) => s.externalId)).toContain('mcp-1');
    expect((await call(mcp, 'get_store', { externalId: 'nope' })).data).toBeNull();
  });

  it('manages domains', async () => {
    expect((await call(mcp, 'check_domain_availability', { domain: 'shop.mcp-example.com' })).data).toMatchObject({ available: true });
    await call(mcp, 'add_store_domain', { externalId: 'mcp-1', domainName: 'shop.mcp-example.com' });
    const domains = (await call(mcp, 'list_store_domains', { externalId: 'mcp-1' })).data;
    expect(domains.map((d: { domainName: string }) => d.domainName)).toContain('shop.mcp-example.com');
    await call(mcp, 'wait_for_store', { externalId: 'mcp-1', timeoutSeconds: 15 });
    expect((await call(mcp, 'remove_store_domain', { externalId: 'mcp-1', domainName: 'shop.mcp-example.com' })).isError).toBe(false);
  });

  it('suspends, backs up and resumes a store', async () => {
    await call(mcp, 'wait_for_store', { externalId: 'mcp-1', timeoutSeconds: 15 });
    expect((await call(mcp, 'suspend_store', { externalId: 'mcp-1', takeBackup: false })).data).toMatchObject({ externalId: 'mcp-1' });
    const { backupId } = (await call(mcp, 'create_store_backup', { externalId: 'mcp-1' })).data;
    const backups = (await call(mcp, 'list_store_backups', { externalId: 'mcp-1' })).data;
    expect(backups.map((b: { id: string }) => b.id)).toContain(backupId);
    expect((await call(mcp, 'resume_store', { externalId: 'mcp-1' })).data).toMatchObject({ externalId: 'mcp-1' });
  });

  it('turns API errors and bad refs into tool errors', async () => {
    const bad = await call(mcp, 'create_store', { name: 'dupe', externalId: 'has space' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^The API refused createTenant \(HTTP 400\): /);

    expect(await call(mcp, 'get_store')).toMatchObject({ isError: true, text: 'Give the store’s externalId or tenantId.' });
    expect(await call(mcp, 'get_store', { externalId: 'a', tenantId: 'b' })).toMatchObject({ isError: true });
  });

  it('offers only read tools at /mcp/read-only', async () => {
    const readOnly = await connect('/mcp/read-only');
    const names = (await readOnly.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_stores');
    expect(names).toContain('wait_for_store');
    expect(names).not.toContain('create_store');
    expect(names).not.toContain('delete_store');
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
    expect(html).not.toContain('/*MCP_APPS_BUNDLE*/');
    expect(html).toContain('globalThis.McpApps={');
    expect(html).toMatch(/globalThis\.McpApps=\{[^}]*\bApp:/);
  });

  it('deletes a store', async () => {
    await call(mcp, 'wait_for_store', { externalId: 'mcp-1', timeoutSeconds: 15 });
    expect(await call(mcp, 'delete_store', { externalId: 'mcp-1' })).toMatchObject({ isError: false, text: 'Done.' });
  });
});

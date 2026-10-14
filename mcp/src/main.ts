#!/usr/bin/env node
// Runs the WaaS MCP server over stdio, configured from the environment. For HTTP, the API serves
// the same tools at /mcp (src/mcp.ts).
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WaasClient } from 'waas-provisioning-sdk';
import { createWaasMcpServer } from './server.js';

const { WAAS_API_URL, WAAS_API_KEY, WAAS_API_SECRET, WAAS_MCP_READ_ONLY } = process.env;
if (!WAAS_API_URL || !WAAS_API_KEY || !WAAS_API_SECRET) {
  console.error('Set WAAS_API_URL, WAAS_API_KEY and WAAS_API_SECRET (optionally WAAS_MCP_READ_ONLY=1).');
  process.exit(1);
}

const client = new WaasClient({ baseUrl: WAAS_API_URL, apiKey: WAAS_API_KEY, apiSecret: WAAS_API_SECRET });
const readOnly = ['1', 'true', 'yes'].includes((WAAS_MCP_READ_ONLY ?? '').toLowerCase());
serveStdio(() => createWaasMcpServer(client, { readOnly }), { onerror: (error) => console.error(error) });

// The AnyPress logo, so AI apps and browsers show it for this server: MCP connectors in Claude and
// ChatGPT pick up /favicon.ico and the icons in the MCP server info (mcp/src/server.ts).
import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import type { AppEnv } from './app.ts';

const asset = (file: string) => readFileSync(new URL(`./assets/${file}`, import.meta.url));
const ICONS = {
  '/favicon.ico': ['favicon.png', 'image/png'],
  '/favicon.png': ['favicon.png', 'image/png'],
  '/icon.png': ['icon.png', 'image/png'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
} as const;

/** The icons to list in the MCP server info, at this server's public address. */
export const mcpIcons = (base: string) => [
  { src: `${base}/icon.png`, mimeType: 'image/png', sizes: ['512x512'] },
  { src: `${base}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
];

export function iconRoutes(app: Hono<AppEnv>) {
  for (const [path, [file, type]] of Object.entries(ICONS)) {
    const body = asset(file);
    app.get(path, (c) => c.body(body, 200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' }));
  }
}

// What an MCP connection may do, by area: a read scope to look and a write scope to change things.
// Every tool belongs to one area (server.ts), and a tool whose scope isn't granted isn't offered.
// The API's OAuth (src/oauth.ts) grants these; Basic auth and the local stdio server get them all.

/** The areas, in the order people see them. */
export const AREAS = ['stores', 'backups', 'domains', 'email', 'versions', 'webhooks', 'site'] as const;
export type Area = (typeof AREAS)[number];
export type Access = 'read' | 'write';

/** In plain words, for approve pages. */
export const AREA_LABELS: Record<Area, { name: string; read: string; write: string }> = {
  stores: { name: 'Stores', read: 'See your stores and their status', write: 'Create, change, suspend, resume, move and delete stores' },
  backups: { name: 'Backups', read: 'See backups', write: 'Take backups and restore stores from them' },
  domains: { name: 'Domains', read: 'See domains and check addresses', write: 'Add, remove and change domains' },
  email: { name: 'Email', read: 'See the sending domain', write: 'Set or remove the sending domain' },
  versions: { name: 'Versions', read: 'See versions, snapshots and templates', write: 'Create, delete and choose the production version' },
  webhooks: { name: 'Webhooks', read: 'See webhook endpoints and their deliveries', write: 'Add, change, test and remove webhook endpoints' },
  site: { name: 'Website pages and design', read: 'See pages, menus and styles', write: 'Edit pages, menus, header, footer, styles and images' },
};

export const scopeOf = (area: Area, access: Access) => `${area}:${access}`;

export const READ_SCOPES: readonly string[] = AREAS.map((area) => scopeOf(area, 'read'));
export const WRITE_SCOPES: readonly string[] = AREAS.map((area) => scopeOf(area, 'write'));
/** Every scope, read and write per area. */
export const ALL_SCOPES: readonly string[] = AREAS.flatMap((area) => [scopeOf(area, 'read'), scopeOf(area, 'write')]);

/** Whether a string is one of our scopes. */
export const isScope = (value: string) => ALL_SCOPES.includes(value);

/** A space-separated scope string as a list: known scopes only, once each, in ALL_SCOPES order. */
export function parseScopes(value: string | readonly string[] | null | undefined): string[] {
  const given = new Set(typeof value === 'string' ? value.split(/\s+/) : (value ?? []));
  return ALL_SCOPES.filter((scope) => given.has(scope));
}

/**
 * The scopes a grant made before scopes were per area really means. Then there were two:
 * stores:read (look at everything) and stores:write (change everything).
 */
export function expandLegacyScopes(value: string | readonly string[]): string[] {
  const given = new Set(typeof value === 'string' ? value.split(/\s+/) : value);
  const out = new Set<string>();
  if (given.has('stores:read')) READ_SCOPES.forEach((s) => out.add(s));
  if (given.has('stores:write')) WRITE_SCOPES.forEach((s) => out.add(s));
  return ALL_SCOPES.filter((scope) => out.has(scope));
}

/** Changing an area means looking at it too: each write scope brings its read scope. */
export function withReads(scopes: readonly string[]): string[] {
  const out = new Set(scopes);
  for (const area of AREAS) if (out.has(scopeOf(area, 'write'))) out.add(scopeOf(area, 'read'));
  return ALL_SCOPES.filter((scope) => out.has(scope));
}

/** Drops every write scope. */
export const readsOnly = (scopes: readonly string[]) => scopes.filter((scope) => scope.endsWith(':read'));

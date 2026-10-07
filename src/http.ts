import type { Context } from 'hono';
import { badRequest } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);

/**
 * Reads a JSON body. An empty body and `[]` both count as `{}`: the storefront plugin sends
 * `[]` for an empty PUT body.
 */
export async function readJson(c: Context): Promise<unknown> {
  const text = (await c.req.text()).trim();
  if (text === '') return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest('The request body is not valid JSON');
  }
  if (Array.isArray(body) && body.length === 0) return {};
  return body;
}

/** An optional query parameter that must be a UUID when present. */
export function uuidQuery(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  if (!isUuid(value)) throw badRequest(`${name} must be a UUID`);
  return value;
}

export function requiredUuidQuery(c: Context, name: string): string {
  const value = uuidQuery(c, name);
  if (!value) throw badRequest(`${name} is required`);
  return value;
}

export function booleanQuery(c: Context, name: string): boolean | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  throw badRequest(`${name} must be true or false`);
}

/** Drops keys whose value is null or undefined, so optional fields are absent rather than null. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)) as T;
}

import { isIP } from 'node:net';

/**
 * Wrong API keys per caller address. Each wrong key costs a scrypt hash, so an address that keeps
 * guessing is turned away before the hash: at most MAX_FAILURES in WINDOW_MS. Kept in memory, which
 * is enough for one API process; a restart starts the count over.
 */
const MAX_FAILURES = 20;
const WINDOW_MS = 10 * 60_000;
const MAX_TRACKED = 10_000;
const failures = new Map<string, { count: number; resetAt: number }>();

/** The caller's address as Cloudflare saw it (the API answers only Cloudflare); none for calls from inside the server. */
export function callerAddress(header: string | undefined): string | null {
  const ip = header?.trim() ?? '';
  return isIP(ip) ? ip : null;
}

/** Whether this address has had too many wrong keys lately. */
export function tooManyWrongKeys(ip: string | null, now = Date.now()): boolean {
  if (!ip) return false;
  const entry = failures.get(ip);
  return !!entry && entry.resetAt > now && entry.count >= MAX_FAILURES;
}

/** Counts a wrong key from this address. */
export function recordWrongKey(ip: string | null, now = Date.now()): void {
  if (!ip) return;
  const entry = failures.get(ip);
  if (entry && entry.resetAt > now) {
    entry.count++;
    return;
  }
  if (failures.size >= MAX_TRACKED) {
    for (const [key, value] of failures) if (value.resetAt <= now) failures.delete(key);
    if (failures.size >= MAX_TRACKED) failures.delete(failures.keys().next().value!);
  }
  failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
}

export const WRONG_KEY_RETRY_SECONDS = WINDOW_MS / 1000;

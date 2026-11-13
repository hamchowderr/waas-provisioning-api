import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** The header Better Auth reads the caller's address from (src/auth.ts). Only this API sets it. */
export const CLIENT_IP_HEADER = 'x-anypress-client-ip';
/** The dashboard's proof that it set the address: HMAC-SHA256 of the address, keyed with ADMIN_TOKEN. */
const SIGNATURE_HEADER = 'x-anypress-client-ip-signature';

/** What the dashboard sends with an address it vouches for. */
export function signClientIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

function sameHex(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Sets the address sign-in limits are counted by. Sign-in passed through the dashboard comes from
 * Vercel, so the dashboard sends the browser's address signed with ADMIN_TOKEN; anything else comes
 * through Cloudflare (the API answers nobody else), which puts the caller in cf-connecting-ip.
 * Whatever the caller sent in these headers is dropped first.
 */
export function setClientIp(headers: Headers, adminToken: string | undefined): void {
  const vouched = headers.get(CLIENT_IP_HEADER)?.trim() ?? '';
  const signature = headers.get(SIGNATURE_HEADER) ?? '';
  headers.delete(CLIENT_IP_HEADER);
  headers.delete(SIGNATURE_HEADER);
  const signed = !!adminToken && isIP(vouched) > 0 && sameHex(signature, signClientIp(vouched, adminToken));
  const cloudflare = headers.get('cf-connecting-ip')?.trim() ?? '';
  const ip = signed ? vouched : cloudflare;
  if (isIP(ip)) headers.set(CLIENT_IP_HEADER, ip);
}

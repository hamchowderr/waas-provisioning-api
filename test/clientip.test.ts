import { expect, it as test } from 'vitest';
import { CLIENT_IP_HEADER, setClientIp, signClientIp } from '../src/clientip.ts';

const SECRET = 'admin-token';

function resolve(sent: Record<string, string>, secret: string | undefined = SECRET): string | null {
  const headers = new Headers(sent);
  setClientIp(headers, secret);
  expect(headers.get('x-anypress-client-ip-signature')).toBe(null);
  return headers.get(CLIENT_IP_HEADER);
}

test('a direct caller is counted by the address Cloudflare saw', () => {
  expect(resolve({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 172.70.1.1' })).toBe('203.0.113.7');
});

test("the dashboard's signed address wins over Cloudflare's (which is Vercel's)", () => {
  const ip = '2001:db8::5';
  expect(resolve({ 'cf-connecting-ip': '76.76.21.1', [CLIENT_IP_HEADER]: ip, 'x-anypress-client-ip-signature': signClientIp(ip, SECRET) })).toBe(ip);
});

test('an unsigned or wrongly signed address is ignored', () => {
  expect(resolve({ 'cf-connecting-ip': '203.0.113.7', [CLIENT_IP_HEADER]: '192.0.2.9' })).toBe('203.0.113.7');
  expect(resolve({ 'cf-connecting-ip': '203.0.113.7', [CLIENT_IP_HEADER]: '192.0.2.9', 'x-anypress-client-ip-signature': signClientIp('192.0.2.9', 'other') })).toBe('203.0.113.7');
  expect(resolve({ [CLIENT_IP_HEADER]: '192.0.2.9', 'x-anypress-client-ip-signature': signClientIp('192.0.2.9', SECRET) }, '')).toBe(null);
});

test('no usable address leaves the header unset', () => {
  expect(resolve({ 'cf-connecting-ip': 'not-an-ip' })).toBe(null);
  expect(resolve({})).toBe(null);
});

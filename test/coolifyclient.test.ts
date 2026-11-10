// The Coolify API client (src/provisioner/coolify/client.ts): Coolify's per-minute rate limit (HTTP 429).
import { describe, expect, it } from 'vitest';
import { CoolifyClient } from '../src/provisioner/coolify/client.ts';

/** A Coolify that answers with these responses in turn, recording each request and wait. */
function fakeCoolify(answers: Response[]) {
  const calls: string[] = [];
  const waits: number[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)}`);
    return answers.shift() ?? Response.json({ message: 'unexpected' }, { status: 500 });
  }) as typeof fetch;
  const client = new CoolifyClient('https://coolify.example', 'token', fetchImpl, async (ms) => {
    waits.push(ms);
  });
  return { client, calls, waits };
}
const limited = (retryAfter?: string) => new Response('{"message":"Too Many Attempts."}', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

describe('CoolifyClient', () => {
  it('waits out a 429 (Retry-After, else a growing pause) and sends the request again', async () => {
    const { client, calls, waits } = fakeCoolify([limited('7'), limited(), Response.json({ uuid: 's1' })]);
    expect(await client.request('PATCH', '/services/s1', { description: 'x' })).toEqual({ uuid: 's1' });
    expect(calls).toEqual(['PATCH https://coolify.example/api/v1/services/s1', 'PATCH https://coolify.example/api/v1/services/s1', 'PATCH https://coolify.example/api/v1/services/s1']);
    expect(waits).toEqual([7_000, 10_000]);
  });

  it('gives up after a few tries, with Coolify’s answer', async () => {
    const { client, calls } = fakeCoolify([limited(), limited(), limited(), limited(), limited()]);
    await expect(client.request('GET', '/services/s1')).rejects.toThrow('Coolify GET /services/s1: HTTP 429 Too Many Attempts.');
    expect(calls).toHaveLength(5);
  });

  it('does not retry other errors', async () => {
    const { client, calls } = fakeCoolify([Response.json({ message: 'Not found.' }, { status: 404 })]);
    await expect(client.request('GET', '/services/nope')).rejects.toThrow('HTTP 404 Not found.');
    expect(calls).toHaveLength(1);
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicFetch } from '../src/publicfetch.ts';

describe('publicFetch', () => {
  let server: Server;
  let port: number;
  let hits = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('refuses loopback and private IP literals without connecting', async () => {
    for (const url of [`http://127.0.0.1:${port}/x`, 'https://10.0.0.5/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://localhost/x']) {
      await expect(publicFetch(url)).rejects.toThrow(/private address/);
    }
    expect(hits).toBe(0);
  });

  it('refuses a name that resolves to a private address when it connects', async () => {
    await expect(publicFetch(`http://foo.localtest.me:${port}/x`)).rejects.toThrow();
    await expect(publicFetch(`http://127.0.0.1.nip.io:${port}/x`)).rejects.toThrow();
    expect(hits).toBe(0);
  });

  it('sends only GET requests over http or https', async () => {
    await expect(publicFetch('https://example.com/x', { method: 'POST' })).rejects.toThrow(/only sends GET/);
    await expect(publicFetch('file:///etc/passwd')).rejects.toThrow(/Unsupported protocol/);
  });
});

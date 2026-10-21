import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { guardedLookup, isPrivateAddress } from './webhooks.ts';

/** Bytes of a response body read at most; a longer body is cut off. */
const MAX_BODY = 256 * 1024;

/**
 * A GET-only `fetch` for URLs that come from outside (an OAuth client's metadata document, a DNS provider's
 * Domain Connect settings), so they can't reach this server's own network: refuses private, loopback and
 * link-local addresses, both as IP literals and as what a name resolves to at connect time. Never follows
 * redirects (a 3xx comes back as is, which callers treat as not ok).
 */
export const publicFetch: typeof fetch = (input, init) =>
  new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch (err) {
      return reject(err);
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return reject(new TypeError('publicFetch only sends GET requests'));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return reject(new TypeError(`Unsupported protocol ${url.protocol}`));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isPrivateAddress(host))) {
      return reject(new TypeError(`${host} is a private address`));
    }
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) return reject(signal.reason);
    const client = url.protocol === 'http:' ? http : https;
    const req = client.request(url, { method, headers: Object.fromEntries(new Headers(init?.headers).entries()), lookup: guardedLookup(false), signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size < MAX_BODY) chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const status = res.statusCode ?? 502;
        const body = status === 204 || status === 304 ? null : Buffer.concat(chunks).subarray(0, MAX_BODY);
        resolve(new Response(body, { status, statusText: res.statusMessage, headers }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });

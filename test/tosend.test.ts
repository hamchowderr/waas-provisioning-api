import { describe, expect, it } from 'vitest';
import { ToSendAdmin } from '../src/tosend.ts';

describe('ToSendAdmin', () => {
  function api(handler: (method: string, path: string, body: unknown) => [number, unknown]) {
    const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init.method!, path: u.pathname + u.search, auth: new Headers(init.headers).get('authorization'), body });
      const [status, json] = handler(init.method!, u.pathname, body);
      return new Response(JSON.stringify(json), { status });
    }) as typeof fetch;
    return { calls, admin: new ToSendAdmin('tsend_admin_test', 'anypress.io', 'https://api.tosend.test', fetchFn) };
  }

  it('mints a key restricted to the sending domain, looking the domain up once', async () => {
    let n = 0;
    const { calls, admin } = api((method, path) => {
      if (method === 'GET' && path === '/v2/domains') return [200, { data: [{ id: 7, domain_name: 'other.example' }, { id: 9, domain_name: 'AnyPress.io' }] }];
      if (method === 'POST' && path === '/v2/api-keys') return [201, { data: { id: 100 + ++n, api_key: `tsend_key_${n}` } }];
      return [404, {}];
    });
    expect(await admin.create('abc')).toEqual({ id: '101', key: 'tsend_key_1' });
    expect(await admin.create('def')).toEqual({ id: '102', key: 'tsend_key_2' });
    expect(calls.filter((c) => c.path.startsWith('/v2/domains'))).toHaveLength(1);
    expect(calls[1]).toMatchObject({ method: 'POST', auth: 'Bearer tsend_admin_test', body: { name: 'store-abc', domain: '9' } });
  });

  it('says plainly when the sending domain is missing, and treats an already-deleted key as deleted', async () => {
    const { admin } = api((method, path) => {
      if (path === '/v2/domains') return [200, { data: [] }];
      if (method === 'DELETE') return path.endsWith('/1') ? [404, { error: { message: 'Not found' } }] : [500, { message: 'boom' }];
      return [404, {}];
    });
    await expect(admin.create('abc')).rejects.toThrow(/no sending domain anypress.io/);
    await expect(admin.delete('1')).resolves.toBeUndefined();
    await expect(admin.delete('2')).rejects.toThrow(/HTTP 500 boom/);
  });

  // The shape toSend returns for GET /v2/domains/{id} (checked against the live API).
  const detail = (id: string, name: string, status: string) => ({
    data: {
      id,
      domain_name: name,
      verification_status: status,
      dns_records: {
        dkim: { type: 'TXT', name: 'tosend._domainkey', content: 'p=MIGf', TTL: 'auto', priority: '' },
        spf: [
          { type: 'MX', name: 'send', content: 'feedback-smtp.us-east-1.amazonses.com', TTL: 'auto', priority: '10' },
          { type: 'TXT', name: 'send', content: 'v=spf1 include:amazonses.com ~all', TTL: 'auto', priority: '' },
        ],
      },
    },
  });

  it('adds a sending domain and returns its DNS records as one list', async () => {
    const { calls, admin } = api((method, path) => {
      if (method === 'POST' && path === '/v2/domains') return [201, { data: { id: 'abc123', domain_name: 'shop.example' } }];
      if (method === 'GET' && path === '/v2/domains/abc123') return [200, detail('abc123', 'shop.example', 'draft')];
      return [404, {}];
    });
    expect(await admin.addDomain('shop.example')).toEqual({
      id: 'abc123',
      name: 'shop.example',
      status: 'draft',
      records: [
        { type: 'TXT', name: 'tosend._domainkey', host: 'tosend._domainkey.shop.example', value: 'p=MIGf', priority: null },
        { type: 'MX', name: 'send', host: 'send.shop.example', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
        { type: 'TXT', name: 'send', host: 'send.shop.example', value: 'v=spf1 include:amazonses.com ~all', priority: null },
      ],
    });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { name: 'shop.example' } });
  });

  it("reads back a domain this account already has, and refuses another account's", async () => {
    const { admin } = api((method, path) => {
      if (method === 'POST') return [409, { error: { message: 'Domain already exists' } }];
      if (method === 'GET' && path === '/v2/domains') return [200, { data: [{ id: 'abc123', domain_name: 'shop.example' }] }];
      if (method === 'GET' && path === '/v2/domains/abc123') return [200, detail('abc123', 'shop.example', 'verified')];
      return [404, {}];
    });
    expect((await admin.addDomain('shop.example')).status).toBe('verified');
    await expect(admin.addDomain('taken.example')).rejects.toThrow(/another toSend account/);
  });

  it('mints a key for a given domain without looking up the platform one, and treats a gone domain as deleted', async () => {
    const { calls, admin } = api((method, path) => {
      if (method === 'POST' && path === '/v2/api-keys') return [201, { data: { id: 5, api_key: 'tsend_k' } }];
      if (method === 'DELETE') return [404, {}];
      return [500, {}];
    });
    expect(await admin.create('abc', 'abc123')).toEqual({ id: '5', key: 'tsend_k' });
    expect(calls[0]).toMatchObject({ body: { name: 'store-abc', domain: 'abc123' } });
    await expect(admin.deleteDomain('abc123')).resolves.toBeUndefined();
  });

  it('counts emails with one search of one email per page, and says when toSend has none or limits it', async () => {
    let limited = false;
    const { calls, admin } = api((method, path) => {
      if (limited) return [429, { message: 'Too Many Requests' }];
      if (method === 'GET' && path === '/v2/emails') return [200, { data: [{ id: 'e1', status: 'sent', from: 'acme@anypress.io' }], total: 37, page: 1, per_page: 1 }];
      return [404, {}];
    });
    expect(await admin.countEmails({ search: 'acme@anypress.io', from: '2026-10-01T00:00:00.000Z' })).toBe(37);
    expect(await admin.countEmails({ search: 'acme@anypress.io', from: '2026-10-01T00:00:00.000Z', status: 'failed' })).toBe(37);
    const query = (i: number) => Object.fromEntries(new URL(`https://x${calls[i]!.path}`).searchParams);
    expect(query(0)).toEqual({ page: '1', per_page: '1', search: 'acme@anypress.io', from: '2026-10-01T00:00:00.000Z' });
    expect(query(1)).toMatchObject({ status: 'failed' });
    expect(calls[0]).toMatchObject({ method: 'GET', auth: 'Bearer tsend_admin_test' });

    limited = true;
    await expect(admin.countEmails({ search: 'a', from: '2026-10-01T00:00:00.000Z' })).rejects.toMatchObject({ status: 429 });
    const { admin: empty } = api(() => [200, { data: [] }]);
    await expect(empty.countEmails({ search: 'a', from: '2026-10-01T00:00:00.000Z' })).rejects.toThrow(/no email count/);
  });
});

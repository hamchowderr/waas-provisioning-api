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
});

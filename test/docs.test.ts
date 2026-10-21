// The public API reference (src/publicspec.ts): GET /openapi.json and the page at GET /docs.
import { describe, expect, it } from 'vitest';
import { createApp, type Deps } from '../src/app.ts';
import { createAjv } from '../src/openapi.ts';

// Neither route touches the database or the queue.
const app = createApp({ config: {} } as Deps);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spec: any = await (await app.request('/openapi.json')).json();
const text = JSON.stringify(spec);

describe('public API reference', () => {
  it('serves the spec without authentication', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    expect(spec.openapi).toBe('3.0.1');
    expect(spec.servers).toEqual([{ url: '/', description: 'This server' }]);
  });

  it('lists only operations this server answers', () => {
    const served = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const [path, item] of Object.entries<object>(spec.paths)) {
      for (const method of Object.keys(item).filter((k) => k !== 'parameters')) {
        expect(served).toContain(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`);
      }
    }
    expect(spec.paths['/v1/tenants'].post).toBeDefined();
    expect(spec.paths['/v1/tenants/mail-domain']).toBeDefined();
    expect(spec.paths['/v1/plugins/{slug}/update']).toBeDefined();
    // Partner calls built so far are listed; ones not built yet are not, and the admin API is not public.
    expect(spec.paths['/v1/subscriptions'].get).toBeDefined();
    expect(spec.paths['/v1/subscriptions'].post).toBeUndefined();
    expect(spec.paths['/v1/subscriptions/usage'].get).toBeDefined();
    expect(spec.paths['/v1/products'].post).toBeDefined();
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/admin'))).toBe(false);
  });

  it('resolves every component reference and drops unused components', () => {
    const refs = new Set([...text.matchAll(/"#\/components\/([^/"]+\/[^"]+)"/g)].map((m) => m[1]));
    for (const ref of refs) expect(spec.components).toHaveProperty(ref!.split('/'));
    for (const [kind, entries] of Object.entries<object>(spec.components)) {
      if (kind === 'securitySchemes') continue;
      for (const name of Object.keys(entries)) expect(refs).toContain(`${kind}/${name}`);
    }
  });

  it('gives every operation a tag the spec describes', () => {
    const tags = new Set(spec.tags.map((t: { name: string }) => t.name));
    for (const item of Object.values<Record<string, { tags?: string[] }>>(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (method !== 'parameters') expect(tags).toContain(op.tags?.[0]);
      }
    }
  });

  it('leaves out notes meant for the platform team', () => {
    expect(text.replaceAll('"x-displayName"', '')).not.toMatch(/"x-/);
    expect(text).not.toMatch(/Phase \d/);
    expect(text).not.toMatch(/\.php/);
    expect(text).not.toMatch(/Storefront plugin:\*\*/);
    expect(text).not.toMatch(/teardown|pstmn|postman mock|localhost|coolify/i);
    expect(text).not.toMatch(/\((?:waas|wpcs)-[a-z0-9]+\)/i);
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(text).not.toContain('](docs/');
  });

  it('gives examples that match their schemas', () => {
    const ajv = createAjv();
    ajv.addSchema({ components: spec.components }, 'public');
    let count = 0;
    for (const [path, item] of Object.entries<Record<string, any>>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (method === 'parameters') continue;
        const media = [
          ...Object.entries<any>(op.requestBody?.content ?? {}).map(([type, m]) => [`request ${type}`, m]),
          ...Object.entries<any>(op.responses ?? {}).flatMap(([status, r]) => Object.entries<any>(r.content ?? {}).map(([type, m]) => [`${status} ${type}`, m])),
        ];
        for (const [where, m] of media) {
          if (!m.examples) continue;
          const validate = ajv.compile(JSON.parse(JSON.stringify(m.schema).replaceAll('"#/components', '"public#/components')));
          for (const [name, example] of Object.entries<any>(m.examples)) {
            count++;
            expect(validate(example.value), `${method.toUpperCase()} ${path} ${where} example ${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
          }
        }
      }
    }
    expect(count).toBeGreaterThan(40);
  });

  it('gives every partner operation a worked example of its answer', () => {
    const partner = ['/v1/subscriptions', '/v1/subscriptions/usage', '/v1/products', '/v1/products/usage', '/v1/basesnapshots'];
    for (const path of partner) {
      for (const [method, op] of Object.entries<any>(spec.paths[path])) {
        if (method === 'parameters') continue;
        expect(op.responses['200'].content['application/json'].examples, `${method} ${path} 200`).toBeDefined();
        expect(op.responses['400']?.content['application/json'].examples, `${method} ${path} 400`).toBeDefined();
      }
    }
  });

  it('serves the reference page', async () => {
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain("url: './openapi.json'");
    expect(html).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+\//);
  });
});

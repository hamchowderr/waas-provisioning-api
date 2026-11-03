// The ANYPRESS_ constant names (migration 1764400000000_anypress-constant-names, src/constantnames.ts): stored
// constants under the old names move, and each site that had one gets its constants pushed once.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pushRenamedConstants } from '../src/constantnames.ts';
import { Status } from '../src/status.ts';
import { OWNER, setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;
const MIGRATION = readFileSync(new URL('../migrations/1764400000000_anypress-constant-names.sql', import.meta.url), 'utf8');

async function tenantStatus(externalId: string): Promise<number | undefined> {
  const [tenant] = (await (await t.call('GET', `/v1/tenants?externalId=${externalId}`)).json()) as { statusCode: number }[];
  return tenant?.statusCode;
}

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});
afterAll(async () => {
  await t.close();
});

describe('ANYPRESS_ constant names', () => {
  it('moves WAAS_ and WPCS_ names to ANYPRESS_, keeping a name already there', async () => {
    const fn = MIGRATION.match(/CREATE FUNCTION pg_temp\.anypress_constant_names[\s\S]*?\$\$;/)![0];
    const client = await t.pool.connect();
    try {
      await client.query(fn);
      const { rows } = await client.query<{ c: Record<string, unknown> }>('SELECT pg_temp.anypress_constant_names($1::jsonb) AS c', [
        JSON.stringify({
          WAAS_API_KEY: { value: 'k', isPrivate: true },
          WPCS_TENANT_ROLES: { value: 'old', isPrivate: false },
          WAAS_TENANT_ROLES: { value: 'newer', isPrivate: false },
          ANYPRESS_PUBLIC_KEY: { value: 'kept', isPrivate: false },
          WAAS_PUBLIC_KEY: { value: 'dropped', isPrivate: false },
          OTHER: { value: 'x', isPrivate: false },
        }),
      ]);
      expect(rows[0]!.c).toEqual({
        ANYPRESS_API_KEY: { value: 'k', isPrivate: true },
        ANYPRESS_TENANT_ROLES: { value: 'newer', isPrivate: false },
        ANYPRESS_PUBLIC_KEY: { value: 'kept', isPrivate: false },
        OTHER: { value: 'x', isPrivate: false },
      });
    } finally {
      client.release();
    }
  });

  it('pushes a listed site its whole set of constants once', async () => {
    const res = await t.call('POST', '/v1/tenants', {
      body: { ...OWNER, name: 'Renamed', phpConstants: { ANYPRESS_API_SECRET: { value: 'secret', isPrivate: true }, ANYPRESS_TENANT_ROLES: { value: '["website"]' } } },
    });
    const body = (await res.json()) as { id: string; externalId: string };
    await waitFor(async () => (await tenantStatus(body.externalId)) === Status.Done);
    // The store still has the constants under the old names.
    const store = t.provisioner.stores.get(body.id)!;
    store.phpConstants = { WAAS_API_SECRET: { value: 'secret', isPrivate: true } };
    await t.pool.query('INSERT INTO constant_renames (tenant_id) VALUES ($1)', [body.id]);

    expect(await pushRenamedConstants(t.boss, t.pool)).toBe(1);
    await waitFor(async () => store.phpConstants.ANYPRESS_API_SECRET?.value === 'secret' && (await tenantStatus(body.externalId)) === Status.Done);
    expect(store.phpConstants.ANYPRESS_TENANT_ROLES).toEqual({ value: '["website"]', isPrivate: false });
    expect(await pushRenamedConstants(t.boss, t.pool)).toBe(0);
  });
});

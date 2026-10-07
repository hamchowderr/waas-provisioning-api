import { describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.ts';
import { ensureStoreCrons } from '../src/maintenance.ts';
import { FakeProvisioner } from '../src/provisioner/fake.ts';

describe('ensureStoreCrons', () => {
  it('ensures every live store, and one failure does not stop the rest', async () => {
    const queries: unknown[][] = [];
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        queries.push(params);
        return { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
      },
    } as unknown as Pool;
    const provisioner = new FakeProvisioner();
    const seen: string[] = [];
    provisioner.ensureStoreCron = async ({ storeId }) => {
      seen.push(storeId);
      if (storeId === 'b') throw new Error('Coolify down');
      return storeId === 'a' ? 'created' : 'unchanged';
    };
    const logs: string[] = [];
    const errors: string[] = [];
    await ensureStoreCrons(pool, provisioner, { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) });
    expect(queries).toEqual([[1]]); // Status.Done only
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(logs).toEqual(['Store a: cron task created']);
    expect(errors).toEqual(['Store b: cron task not ensured: Coolify down']);
  });
});

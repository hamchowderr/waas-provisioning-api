import { describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.ts';
import { maintainStores } from '../src/maintenance.ts';
import { FakeProvisioner } from '../src/provisioner/fake.ts';

describe('maintainStores', () => {
  it('brings every live store up to date, and one failure does not stop the rest', async () => {
    const queries: unknown[][] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('tenant_mail_domains')) return { rows: [{ tenant_id: 'c', domain_name: 'shop.example', tosend_domain_id: 'd1' }] };
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
    const senders: unknown[] = [];
    provisioner.ensureStoreMail = async ({ storeId, sender }) => {
      senders.push(sender);
      return storeId === 'c' ? 'updated' : 'unchanged';
    };
    provisioner.ensureStoreSetup = async ({ storeId }) => (storeId === 'b' ? 'updated' : 'unchanged');
    const logs: string[] = [];
    const errors: string[] = [];
    await maintainStores(pool, provisioner, { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) });
    expect(queries).toEqual([[1]]); // Status.Done only
    expect(seen).toEqual(['a', 'b', 'c']);
    // A failed cron step still lets the store's mail step run.
    expect(logs).toEqual(['Store a: cron task created', 'Store b: store setup updated', 'Store c: mail settings updated']);
    expect(errors).toEqual(['Store b: cron task not ensured: Coolify down']);
    // A store with a verified sending domain keeps sending from it.
    expect(senders).toEqual([undefined, undefined, { domain: 'shop.example', domainId: 'd1' }]);
  });
});

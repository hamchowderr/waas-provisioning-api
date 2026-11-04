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
        if (sql.includes('tenant_domains')) return { rows: params[0] === 'a' ? [{ domain_name: 'acme.waas.example', is_main: true, is_base: false }] : [] };
        queries.push(params);
        return { rows: [{ id: 'a', size: 'small' }, { id: 'b', size: 'large' }, { id: 'c', size: 'small' }] };
      },
    } as unknown as Pool;
    const provisioner = new FakeProvisioner();
    const seen: string[] = [];
    provisioner.ensureStoreCron = async ({ storeId }) => {
      seen.push(storeId);
      if (storeId === 'b') throw new Error('Coolify down');
      return storeId === 'a' ? 'created' : 'unchanged';
    };
    const senders: Record<string, unknown> = {};
    provisioner.ensureStoreMail = async ({ storeId, sender, mailbox }) => {
      senders[storeId] = sender ?? mailbox;
      return storeId === 'c' ? 'updated' : 'unchanged';
    };
    const sizes: string[] = [];
    provisioner.ensureStoreSetup = async ({ storeId, size }) => {
      sizes.push(size);
      return storeId === 'b' ? 'updated' : 'unchanged';
    };
    const logs: string[] = [];
    const errors: string[] = [];
    await maintainStores(pool, provisioner, { storesDomain: 'stores.waas.example', platformDomain: 'waas.example' }, { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) });
    expect(queries).toEqual([[1]]); // Status.Done only
    // Stores run side by side, so only each store's own steps are in order.
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    // Each store is set up at the size it has on record.
    expect(sizes.sort()).toEqual(['large', 'small', 'small']);
    // A failed cron step still lets the store's mail step run.
    expect(logs.sort()).toEqual(['Store a: cron task created', 'Store b: store setup updated', 'Store c: mail settings updated']);
    expect(errors).toEqual(['Store b: cron task not ensured: Coolify down']);
    // A store with a verified sending domain keeps sending from it; the others from their mailbox at the platform's domain.
    expect(senders).toEqual({ a: 'acme', b: undefined, c: { domain: 'shop.example', domainId: 'd1' } });
  });

  it('works on three stores at a time, each store one step after another', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const pool = {
      query: async (sql: string) => (sql.includes('tenant_') ? { rows: [] } : { rows: ids.map((id) => ({ id, size: 'small' })) }),
    } as unknown as Pool;
    const provisioner = new FakeProvisioner();
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const slow = (what: string) => async ({ storeId }: { storeId: string }) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`${storeId} ${what}`);
      running--;
      return 'unchanged' as const;
    };
    provisioner.ensureStoreMail = slow('mail');
    provisioner.ensureStoreSetup = slow('setup');
    provisioner.ensureStoreCron = slow('cron');
    await maintainStores(pool, provisioner, { storesDomain: 'stores.waas.example', platformDomain: 'waas.example' }, { log: () => {}, error: () => {} });
    expect(most).toBe(3);
    for (const id of ids) expect(order.filter((o) => o.startsWith(`${id} `))).toEqual([`${id} mail`, `${id} setup`, `${id} cron`]);
    expect(order).toHaveLength(ids.length * 3);
  });
});

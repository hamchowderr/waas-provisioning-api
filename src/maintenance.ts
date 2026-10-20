import type { Pool } from './db.ts';
import { ensureStoreSender, type MailboxDomains } from './mailcount.ts';
import { storeSenders } from './maildomains.ts';
import type { Size } from './plans.ts';
import type { Provisioner, StoreSender } from './provisioner/provisioner.ts';
import { Status } from './status.ts';

/**
 * Brings every live store up to what new stores get: it sends email through the mail relay
 * (Provisioner.ensureStoreMail) from its own address (its verified domain, else its mailbox at the
 * platform's domain, src/mailcount.ts), the current compose file and agent files at the size it has on
 * record (Provisioner.ensureStoreSetup), and its scheduled jobs run on their own
 * (Provisioner.ensureStoreCron). Mail goes first: a store whose mail changes gets the current setup with
 * the same restart. Run on startup. One store or step failing does not stop the others; it is logged
 * and tried again on the next start.
 */
export async function maintainStores(pool: Pool, provisioner: Provisioner, domains: MailboxDomains, log: Pick<Console, 'log' | 'error'> = console): Promise<void> {
  let stores: { id: string; size: Size }[];
  let senders: Map<string, StoreSender>;
  try {
    stores = (await pool.query('SELECT id, size FROM tenants WHERE status = $1 ORDER BY date_created, id', [Status.Done])).rows;
    senders = await storeSenders(pool);
  } catch (err) {
    log.error(`Store maintenance skipped: ${(err as Error).message}`);
    return;
  }
  const steps = [
    { what: 'mail settings', run: (storeId: string) => ensureStoreSender(pool, provisioner, domains, storeId, senders.get(storeId)) },
    { what: 'store setup', run: (storeId: string, size: Size) => provisioner.ensureStoreSetup({ storeId, size }) },
    { what: 'cron task', run: (storeId: string) => provisioner.ensureStoreCron({ storeId }) },
  ];
  for (const { id: storeId, size } of stores) {
    for (const step of steps) {
      try {
        const result = await step.run(storeId, size);
        if (result !== 'unchanged') log.log(`Store ${storeId}: ${step.what} ${result}`);
      } catch (err) {
        log.error(`Store ${storeId}: ${step.what} not ensured: ${(err as Error).message}`);
      }
    }
  }
}

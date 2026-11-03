import type { PgBoss } from 'pg-boss';
import { withTransaction, type Pool } from './db.ts';
import { enqueue } from './queue.ts';
import { Status } from './status.ts';

/**
 * Pushes the constants of each store and storefront whose stored phpConstants moved to their ANYPRESS_ names
 * (migration 1764400000000_anypress-constant-names), once: a tenant.update with every constant name writes the whole
 * set to the site again. A deleted or failed site is only taken off the list.
 */
export async function pushRenamedConstants(boss: PgBoss, pool: Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; names: string[] | null; status: number }>(
      `DELETE FROM constant_renames r USING tenants t WHERE t.id = r.tenant_id
       RETURNING t.id, t.status, ARRAY(SELECT jsonb_object_keys(t.php_constants)) AS names`,
    );
    let queued = 0;
    for (const t of rows) {
      if (t.status === Status.Removing || t.status === Status.Failed || !t.names?.length) continue;
      await enqueue(boss, client, { type: 'tenant.update', tenantId: t.id, phpConstantNames: t.names });
      queued++;
    }
    return queued;
  });
}

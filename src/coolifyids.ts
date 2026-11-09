import type { Pool } from './db.ts';
import type { ServiceIdStore } from './provisioner/coolify/provisioner.ts';

/** The row that marks every existing Service saved once (src/provisioner/coolify/provisioner.ts, findService). */
const SEEDED = '';

/** Coolify Service uuids kept in the coolify_service_ids table. */
export function serviceIdStore(pool: Pool): ServiceIdStore {
  return {
    async get(key) {
      const { rows } = await pool.query<{ uuid: string | null }>('SELECT uuid FROM coolify_service_ids WHERE key = $1', [key]);
      return rows[0] ? rows[0].uuid : undefined;
    },
    async set(key, uuid) {
      await pool.query(
        `INSERT INTO coolify_service_ids (key, uuid) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET uuid = EXCLUDED.uuid, date_changed = now()`,
        [key, uuid],
      );
    },
    async delete(key) {
      await pool.query('DELETE FROM coolify_service_ids WHERE key = $1', [key]);
    },
    async isSeeded() {
      const { rows } = await pool.query('SELECT 1 FROM coolify_service_ids WHERE key = $1', [SEEDED]);
      return rows.length > 0;
    },
    async seed(entries) {
      const keys = [...entries.map(([k]) => k), SEEDED];
      const uuids = [...entries.map(([, u]) => u), 'seeded'];
      await pool.query(
        `INSERT INTO coolify_service_ids (key, uuid) SELECT * FROM unnest($1::text[], $2::text[])
         ON CONFLICT (key) DO UPDATE SET uuid = EXCLUDED.uuid, date_changed = now()`,
        [keys, uuids],
      );
    },
  };
}

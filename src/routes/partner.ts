import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { HttpError } from '../errors.ts';
import { uuidQuery } from '../http.ts';
import { Status, statusName } from '../status.ts';

/**
 * Calls only a partner key can make (docs/resellers.md): its reseller account, which the contract
 * calls a subscription, and the account's storefronts (products). Other callers get 403. These need
 * no productId; on every other /v1 route a partner key names the storefront with it (src/app.ts).
 */

/** Paths a partner key calls without a productId. */
export const PARTNER_ONLY = /^\/v1\/(subscriptions|products)(\/|$)/;

export function partnerRoutes(deps: Deps) {
  const { pool } = deps;
  const app = new Hono<AppEnv>();

  function reseller(c: Context<AppEnv>): string {
    const id = c.get('resellerId');
    if (!id) throw new HttpError(403, 'Only a partner key can call this');
    return id;
  }

  // The partner's own account, as a list of one (or none when the filters leave it out).
  app.get('/subscriptions', async (c) => {
    const { rows } = await pool.query(
      `SELECT id, name FROM resellers
        WHERE id = $1 AND ($2::uuid IS NULL OR id = $2) AND ($3::text IS NULL OR name = $3)`,
      [reseller(c), uuidQuery(c, 'subscriptionId') ?? null, c.req.query('name') ?? null],
    );
    return c.json(rows.map((r) => ({ id: r.id, name: r.name })));
  });

  // The account's storefronts. A storefront is ready as soon as it exists, so its status is Done.
  app.get('/products', async (c) => {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, r.id AS reseller_id, r.name AS reseller_name FROM products p JOIN resellers r ON r.id = p.reseller_id
        WHERE r.id = $1 AND ($2::uuid IS NULL OR r.id = $2) AND ($3::uuid IS NULL OR p.id = $3) AND ($4::text IS NULL OR p.name = $4)
        ORDER BY p.name, p.id`,
      [reseller(c), uuidQuery(c, 'subscriptionId') ?? null, uuidQuery(c, 'productId') ?? null, c.req.query('productName') ?? null],
    );
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        subscriptionId: r.reseller_id,
        subscriptionName: r.reseller_name,
        statusCode: Status.Done,
        statusName: statusName(Status.Done),
      })),
    );
  });

  return app;
}

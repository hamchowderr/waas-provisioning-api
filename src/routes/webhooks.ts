import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { badRequest } from '../errors.ts';
import { isUuid, readJson, scopedProduct, uuidQuery } from '../http.ts';
import { DEFAULT_WEBHOOK_CONFIG, toDelivery, toEndpoint, webhookService } from '../webhooks.ts';

/**
 * A storefront's own webhook endpoints (docs/webhooks.md, openapi/webhooks.yaml). Mounted at
 * /v1/webhooks with the product API's Basic auth. An endpoint belongs
 * to the key's product, so every key of that product sees it.
 */

function idParam(c: Context, name = 'id'): string {
  const id = c.req.param(name) ?? '';
  if (!isUuid(id)) throw badRequest(`${name} must be a UUID`);
  return id;
}

function page(c: Context) {
  const pageNumber = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize') ?? 50) || 50));
  return { page: pageNumber, pageSize, offset: (pageNumber - 1) * pageSize };
}

export function webhookServiceFor({ pool, boss, secrets, config }: Deps) {
  return webhookService(pool, boss, secrets, config.webhooks ?? DEFAULT_WEBHOOK_CONFIG);
}

export function webhookRoutes(deps: Deps) {
  const service = webhookServiceFor(deps);
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => c.json(await service.list(c.get('productId'))));
  app.post('/', async (c) => c.json(await service.create(c.get('productId'), ((await readJson(c)) ?? {}) as object, c.get('apiKeyId') ?? null), 201));

  // Before /:id, which would otherwise take "deliveries" as an id.
  app.post('/deliveries/:id/retry', async (c) => c.json(await service.redeliver(c.get('productId'), idParam(c))));

  app.get('/:id', async (c) => {
    return c.json(toEndpoint(await service.get(c.get('productId'), idParam(c))));
  });
  app.put('/:id', async (c) => c.json(await service.update(c.get('productId'), idParam(c), ((await readJson(c)) ?? {}) as object)));
  app.delete('/:id', async (c) => c.json(await service.remove(c.get('productId'), idParam(c))));
  app.post('/:id/rotate-secret', async (c) => c.json(await service.rotateSecret(c.get('productId'), idParam(c))));
  app.post('/:id/test', async (c) => c.json(await service.test(c.get('productId'), idParam(c))));

  app.get('/:id/deliveries', async (c) => {
    const productId = c.get('productId');
    const endpointId = idParam(c);
    await service.get(productId, endpointId);
    const { page: pageNumber, pageSize, offset } = page(c);
    const { rows, total } = await service.deliveries(
      productId,
      { endpointId, status: c.req.query('status') || undefined, tenantId: uuidQuery(c, 'tenantId') },
      pageSize,
      offset,
    );
    return c.json({ items: rows.map(toDelivery), total, page: pageNumber, pageSize });
  });

  return app;
}

/**
 * The same for the admin API (mounted at /admin/webhooks behind the admin token): every
 * product's endpoints, with how their deliveries have gone, for the dashboard. At /account/webhooks
 * a signed-in customer gets the same, for their own product only.
 */
export function adminWebhookRoutes(deps: Deps) {
  const { pool } = deps;
  const service = webhookServiceFor(deps);
  const app = new Hono();

  app.get('/', async (c) => {
    const productId = scopedProduct(c) ?? uuidQuery(c, 'productId') ?? null;
    const { rows } = await pool.query(
      `SELECT w.*, p.name AS product_name,
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = w.id AND d.date_created > now() - interval '24 hours') AS sent_24h,
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = w.id AND d.date_created > now() - interval '24 hours' AND d.status = 'failed') AS failed_24h,
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = w.id AND d.status = 'pending') AS pending,
              (SELECT max(d.last_attempt_at) FROM webhook_deliveries d WHERE d.endpoint_id = w.id) AS last_attempt_at
         FROM webhook_endpoints w JOIN products p ON p.id = w.product_id
        WHERE ($1::uuid IS NULL OR w.product_id = $1) ORDER BY p.name, w.date_created`,
      [productId],
    );
    return c.json(
      rows.map((r) => ({
        ...toEndpoint(r),
        productId: r.product_id,
        productName: r.product_name,
        apiKeyId: r.api_key_id,
        last24Hours: { sent: r.sent_24h, failed: r.failed_24h },
        pending: r.pending,
        lastAttemptAt: r.last_attempt_at ? r.last_attempt_at.toISOString() : null,
      })),
    );
  });

  app.post('/', async (c) => {
    const body = ((await readJson(c)) ?? {}) as Record<string, unknown>;
    const scope = scopedProduct(c);
    if (scope) body.productId ??= scope;
    if (typeof body.productId !== 'string' || !isUuid(body.productId)) throw badRequest('productId is required');
    const { rowCount } = await pool.query('SELECT 1 FROM products WHERE id = $1 AND ($2::uuid IS NULL OR id = $2)', [body.productId, scope]);
    if (!rowCount) throw badRequest(`Product ${body.productId} not found`);
    return c.json(await service.create(body.productId, body, null), 201);
  });

  app.get('/deliveries', async (c) => {
    const { page: pageNumber, pageSize, offset } = page(c);
    const { rows, total } = await service.deliveries(
      scopedProduct(c) ?? uuidQuery(c, 'productId') ?? null,
      { endpointId: uuidQuery(c, 'endpointId'), status: c.req.query('status') || undefined, tenantId: uuidQuery(c, 'tenantId') },
      pageSize,
      offset,
    );
    return c.json({
      items: rows.map((r) => ({ ...toDelivery(r), url: r.url, productId: r.product_id, productName: r.product_name, tenantName: r.tenant_name ?? null })),
      total,
      page: pageNumber,
      pageSize,
    });
  });
  app.post('/deliveries/:id/retry', async (c) => c.json(await service.redeliver(scopedProduct(c), idParam(c))));

  app.put('/:id', async (c) => c.json(await service.update(scopedProduct(c), idParam(c), ((await readJson(c)) ?? {}) as object)));
  app.delete('/:id', async (c) => c.json(await service.remove(scopedProduct(c), idParam(c))));
  app.post('/:id/rotate-secret', async (c) => c.json(await service.rotateSecret(scopedProduct(c), idParam(c))));
  app.post('/:id/test', async (c) => c.json(await service.test(scopedProduct(c), idParam(c))));

  return app;
}

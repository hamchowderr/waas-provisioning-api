import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { readJson } from '../http.ts';
import { addApiKey, listApiKeys, parseGraceHours, parseLabel, revokeApiKey, rotateApiKey } from '../keys.ts';

/**
 * Self-service API keys (openapi/api-keys.yaml): a storefront lists, creates, rotates and revokes
 * its own keys, signed in with one of them. Not part of the WPCS contract. Responses that carry a
 * secret are never cached, and the request log never records bodies.
 */
export function keyRoutes(deps: Deps) {
  const { pool } = deps;
  const app = new Hono<AppEnv>();

  const noStore = (c: Context) => c.header('Cache-Control', 'no-store');

  app.get('/', async (c) => {
    const current = c.get('apiKeyId');
    const keys = await listApiKeys(pool, c.get('productId'));
    return c.json(keys.map((k) => ({ ...k, isCurrent: k.id === current })));
  });

  app.post('/', async (c) => {
    const body = ((await readJson(c)) ?? {}) as { label?: unknown };
    const key = await addApiKey(pool, c.get('productId'), parseLabel(body.label));
    noStore(c);
    return c.json(key, 201);
  });

  app.post('/:id/rotate', async (c) => {
    const body = ((await readJson(c)) ?? {}) as { graceHours?: unknown };
    const result = await rotateApiKey(pool, c.get('productId'), c.req.param('id'), parseGraceHours(body.graceHours));
    noStore(c);
    return c.json(result, 201);
  });

  app.delete('/:id', async (c) => c.json(await revokeApiKey(pool, c.get('productId'), c.req.param('id'), { keepOne: true })));

  return app;
}

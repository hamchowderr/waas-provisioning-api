import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePlatformProducts } from '../src/platformproducts.ts';
import { setup, type TestContext } from './helpers.ts';

describe('platform products', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(() => ctx.close());

  it('saves the products a setting names, and uses them once the setting is gone', async () => {
    const { rows } = await ctx.pool.query<{ id: string }>("INSERT INTO products (name) VALUES ('Store template') RETURNING id");
    const template = rows[0]!.id;

    const first = { storefrontProductId: ctx.productId, storeTemplateProductId: template };
    await resolvePlatformProducts(ctx.pool, first);
    expect(first).toEqual({ storefrontProductId: ctx.productId, storeTemplateProductId: template });

    const later: { storefrontProductId?: string; storeTemplateProductId?: string } = {};
    await resolvePlatformProducts(ctx.pool, later);
    expect(later).toEqual({ storefrontProductId: ctx.productId, storeTemplateProductId: template });

    // A setting still wins, and becomes the saved choice.
    const changed = { storefrontProductId: template };
    await resolvePlatformProducts(ctx.pool, changed);
    const after: { storefrontProductId?: string } = {};
    await resolvePlatformProducts(ctx.pool, after);
    expect(after.storefrontProductId).toBe(template);
  });

  it('saves nothing for an id that is not a product, and leaves the setting as it is', async () => {
    const config = { storeTemplateProductId: '00000000-0000-4000-8000-000000000000' };
    await resolvePlatformProducts(ctx.pool, config);
    expect(config.storeTemplateProductId).toBe('00000000-0000-4000-8000-000000000000');
  });
});

// Coolify Service uuids kept in Postgres (src/coolifyids.ts) for the Coolify provisioner's lookups.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serviceIdStore } from '../src/coolifyids.ts';
import { setup, type TestContext } from './helpers.ts';

let t: TestContext;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => t?.close());

describe('serviceIdStore', () => {
  it('saves, reads, seeds and forgets uuids', async () => {
    const ids = serviceIdStore(t.pool);
    await t.pool.query('DELETE FROM coolify_service_ids');
    expect(await ids.get('3/store-a')).toBeUndefined();
    expect(await ids.isSeeded()).toBe(false);
    await ids.set('3/store-a', null);
    expect(await ids.get('3/store-a')).toBeNull();
    await ids.set('3/store-a', 'uuid-a');
    expect(await ids.get('3/store-a')).toBe('uuid-a');
    await ids.seed([['3/store-a', 'uuid-a2'], ['4/version-b', 'uuid-b']]);
    expect(await ids.isSeeded()).toBe(true);
    expect(await ids.get('3/store-a')).toBe('uuid-a2');
    expect(await ids.get('4/version-b')).toBe('uuid-b');
    await ids.delete('4/version-b');
    expect(await ids.get('4/version-b')).toBeUndefined();
    await ids.seed([]);
    expect(await ids.isSeeded()).toBe(true);
  });
});

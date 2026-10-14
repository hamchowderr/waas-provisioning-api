// Runs the PHP SDK (sdk/php/) against the real app over HTTP, so a route change the client doesn't follow fails here.
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApiKey } from '../src/keys.ts';
import { Status } from '../src/status.ts';
import { setup, waitFor, type TestContext } from './helpers.ts';

let t: TestContext;
let server: ServerType;
let baseUrl: string;

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  server = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await t.close();
});

it('PHP SDK works against the API', async () => {
  const { key, secret } = await createApiKey(t.pool, t.productId);
  const result = await promisify(execFile)('php', ['sdk/php/tests/live.php', baseUrl, key, secret], { timeout: 60_000 }).catch(
    (error: { stdout: string; stderr: string }) => error,
  );
  expect(result.stderr, result.stdout).toBe('');
  expect(result.stdout).toContain('ok - deleteTenant');
});

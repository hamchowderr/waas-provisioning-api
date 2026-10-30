import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHealth } from '../src/health.ts';
import { describeJob, withFailureAlerts } from '../src/jobalerts.ts';
import type { JobData, JobHandlers } from '../src/queue.ts';
import { setup, waitFor, type TestContext, OWNER } from './helpers.ts';
import { Status } from '../src/status.ts';

let t: TestContext;
let tenantId: string;

beforeAll(async () => {
  t = await setup();
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as any[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
  tenantId = ((await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name: 'Acme' } })).json()) as { id: string }).id;
  await t.pool.query('UPDATE tenant_domains SET is_main = false WHERE tenant_id = $1', [tenantId]);
  await t.pool.query("INSERT INTO tenant_domains (tenant_id, domain_name, is_main) VALUES ($1, 'acme.anypress.site', true)", [tenantId]);
}, 60_000);

afterAll(() => t?.close());

function recorder() {
  const sent: { to: string; subject: string; text: string }[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push({ to: body.to[0].email, subject: body.subject, text: body.text });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { sent, fetchFn };
}

const mail = { key: 'test-key', from: 'no-reply@anypress.example', brand: 'AnyPress' };

describe('failed job alerts', () => {
  it('describes the job in words', async () => {
    expect(await describeJob(t.pool, { type: 'tenant.create', tenantId })).toBe('Build the store Acme (acme.anypress.site)');
    expect(await describeJob(t.pool, { type: 'tenant.suspend', tenantId: crypto.randomUUID() })).toMatch(/^Suspend the store [0-9a-f-]{36}$/);
  });

  it('emails each admin after recording the failure, with a link to the failed jobs', async () => {
    const recorded: string[] = [];
    const base = { fail: async (d: JobData) => void recorded.push(d.type) } as unknown as JobHandlers;
    const { sent, fetchFn } = recorder();
    const handlers = withFailureAlerts(base, t.pool, { mail, to: ['a@example.com', 'b@example.com'], dashboardUrl: 'https://app.example/' }, fetchFn);
    await handlers.fail({ type: 'tenant.create', tenantId }, new Error('Coolify said no'), { id: 'job-1', attempts: 4 });
    expect(recorded).toEqual(['tenant.create']);
    expect(sent.map((s) => s.to)).toEqual(['a@example.com', 'b@example.com']);
    expect(sent[0]!.subject).toBe('Failed: Build the store Acme (acme.anypress.site)');
    expect(sent[0]!.text).toContain('after 4 tries');
    expect(sent[0]!.text).toContain('Coolify said no');
    expect(sent[0]!.text).toContain('https://app.example/jobs?state=failed');
  });

  it('keeps the job outcome when the email fails, and does nothing without recipients', async () => {
    let failed = 0;
    const base = { fail: async () => void failed++ } as unknown as JobHandlers;
    const broken = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await withFailureAlerts(base, t.pool, { mail, to: ['a@example.com'] }, broken).fail({ type: 'tenant.create', tenantId }, new Error('x'), { id: 'j', attempts: 1 });
    expect(failed).toBe(1);
    expect(withFailureAlerts(base, t.pool, { mail, to: [] })).toBe(base);
    expect(withFailureAlerts(base, t.pool, { to: ['a@example.com'] })).toBe(base);
  });

  it('counts the last day of open failures in /health without failing it', async () => {
    expect((await checkHealth(t.pool, t.boss)).jobs).toEqual({ ok: true, failedLastDay: 0 });
    await t.pool.query(
      "INSERT INTO job_failures (job_id, job_type, job_data, tenant_id, error_message, attempts) VALUES ($1, 'tenant.create', $2, $3, 'boom', 4)",
      [crypto.randomUUID(), { type: 'tenant.create', tenantId }, tenantId],
    );
    await t.pool.query(
      "INSERT INTO job_failures (job_id, job_type, job_data, tenant_id, error_message, attempts, failed_at) VALUES ($1, 'tenant.create', $2, $3, 'old', 4, now() - interval '2 days')",
      [crypto.randomUUID(), { type: 'tenant.create', tenantId }, tenantId],
    );
    const health = await checkHealth(t.pool, t.boss);
    expect(health.ok).toBe(true);
    expect(health.jobs).toEqual({ ok: false, failedLastDay: 1 });
    const res = await t.call('GET', '/health', { auth: null });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('"jobs":{"ok":false,"failedLastDay":1}');
    await t.pool.query("UPDATE job_failures SET status = 'retried'");
    expect((await checkHealth(t.pool, t.boss)).jobs.ok).toBe(true);
  });
});

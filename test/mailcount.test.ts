// The platform's count of each store's email: each store's own sender address, every address it
// used, and the hourly count on toSend that tells the store when its count changed.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { countStoreMail, mailboxLabel, storeMailbox } from '../src/mailcount.ts';
import { createAjv } from '../src/openapi.ts';
import { Status } from '../src/status.ts';
import { dnsSafeLabel } from '../src/tenants.ts';
import { ToSendError, type EmailCountQuery, type MailCounter } from '../src/tosend.ts';
import { setup, TEST_ADMIN_TOKEN, waitFor, type TestContext, OWNER } from './helpers.ts';

const domains = { storesDomain: 'stores.anypress.site', platformDomain: 'anypress.site' };

describe('mailboxLabel', () => {
  it('names the mailbox after a main domain under the platform, else after the base domain', () => {
    expect(mailboxLabel('volume-test-two.anypress.site', 't-64e9c63d.stores.anypress.site', domains)).toBe('volume-test-two');
    expect(mailboxLabel('t-64e9c63d.stores.anypress.site', 't-64e9c63d.stores.anypress.site', domains)).toBe('t-64e9c63d');
    expect(mailboxLabel('acme.stores.anypress.site', 't-64e9c63d.stores.anypress.site', domains)).toBe('acme');
    // A domain of the owner's own, or one deeper under the platform, is not a name the platform gave out.
    expect(mailboxLabel('shop.example.com', 't-64e9c63d.stores.anypress.site', domains)).toBe('t-64e9c63d');
    expect(mailboxLabel('a.b.anypress.site', 't-64e9c63d.stores.anypress.site', domains)).toBe('t-64e9c63d');
    expect(mailboxLabel('acme.anypress.site', 't-1234abcd-s.stores.anypress.site', { storesDomain: 'stores.anypress.site' })).toBe('t-1234abcd-s');
    expect(mailboxLabel(null, null, domains)).toBeUndefined();
  });

  it("never takes a reserved mailbox or a name that isn't one", () => {
    for (const reserved of ['no-reply', 'noreply', 'support', 'admin', 'billing', 'postmaster', 'abuse', 'hostmaster', 'webmaster', 'shop', 'app', 'mail', 'info', 'hello']) {
      expect(mailboxLabel(`${reserved}.anypress.site`, 't-64e9c63d.stores.anypress.site', domains)).toBe('t-64e9c63d');
    }
    expect(mailboxLabel('Acme.anypress.site', 't-64e9c63d.stores.anypress.site', domains)).toBe('t-64e9c63d');
    expect(mailboxLabel('a_b.anypress.site', 't-64e9c63d.stores.anypress.site', domains)).toBe('t-64e9c63d');
    expect(mailboxLabel('-x.anypress.site', 't-64e9c63d.stores.anypress.site', domains)).toBe('t-64e9c63d');
  });
});

/** toSend's email search over `messages`: a case-insensitive substring of the sender or subject, since `from`. */
class FakeCounter implements MailCounter {
  messages: { from: string; subject?: string; status?: string; at?: Date }[] = [];
  queries: EmailCountQuery[] = [];
  /** Answers 429 once this many searches have been made. */
  limit = Infinity;
  async countEmails(query: EmailCountQuery) {
    if (this.queries.length >= this.limit) throw new ToSendError('toSend GET /v2/emails: HTTP 429 Too Many Requests', 429);
    this.queries.push(query);
    const search = query.search.toLowerCase();
    return this.messages.filter(
      (m) =>
        (m.from.toLowerCase().includes(search) || (m.subject ?? '').toLowerCase().includes(search)) &&
        (!query.status || (m.status ?? 'sent') === query.status) &&
        (m.at ?? new Date()) >= new Date(query.from),
    ).length;
  }
}

let t: TestContext;
const quiet = { log: () => undefined, error: () => undefined };
const now = new Date();
const month = now.toISOString().slice(0, 7);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminSpec: any = parse(readFileSync(new URL('../openapi/admin/admin-api.yaml', import.meta.url), 'utf8'));
const ajv = createAjv();
ajv.addSchema({ components: adminSpec.components }, 'admin');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function admin(method: string, path: string, body?: unknown): Promise<any> {
  const res = await t.call(method, path, { auth: `Bearer ${TEST_ADMIN_TOKEN}`, body });
  const parsed = await res.json();
  expect(res.status, `${method} ${path}: ${JSON.stringify(parsed)}`).toBe(200);
  return parsed;
}

async function createTenant(name: string) {
  const tenant = (await (await t.call('POST', '/v1/tenants', { body: { ...OWNER, name } })).json()) as { id: string; externalId: string };
  await waitFor(async () => ((await (await t.call('GET', `/v1/tenants?externalId=${tenant.externalId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  return tenant.id;
}

/** The store's base domain's first label, as POST /v1/tenants names it. */
const baseLabel = (tenantId: string) => dnsSafeLabel(`t-${tenantId.slice(0, 8)}`, 's');

const senders = async (tenantId: string) =>
  (await t.pool.query('SELECT address, last_used IS NULL AS in_use FROM tenant_mail_senders WHERE tenant_id = $1 ORDER BY first_used, address', [tenantId])).rows;

beforeAll(async () => {
  t = await setup();
  t.provisioner.platformMailFrom = 'no-reply@waas.example';
  const res = await t.call('POST', '/v1/versions', { body: { name: 'v1', phpVersion: '8.3', wordPressVersion: '6.8', useCustomUpload: true } });
  const versionId = ((await res.json()) as { id: string }).id;
  await waitFor(async () => ((await (await t.call('GET', `/v1/versions?versionId=${versionId}`)).json()) as { statusCode: number }[])[0]?.statusCode === Status.Done);
  await t.call('PUT', '/v1/versions/production', { body: { versionId } });
});
afterAll(async () => {
  await t.close();
});

describe("a store's own sender address", () => {
  it('gives a new store its mailbox, follows its main domain when it changes, and remembers every address', async () => {
    const id = await createTenant('Acme');
    const base = baseLabel(id);
    expect(t.provisioner.stores.get(id)!.mailFrom).toBe(`${base}@waas.example`);
    expect(await senders(id)).toEqual([{ address: `${base}@waas.example`, in_use: true }]);

    await admin('PUT', `/admin/tenants/${id}/domains/main`, { domainName: 'acme.waas.example' });
    await waitFor(async () => t.provisioner.stores.get(id)!.mainDomain === 'acme.waas.example' && (await senders(id)).length === 2);
    expect(t.provisioner.stores.get(id)!.mailFrom).toBe('acme@waas.example');
    expect(await senders(id)).toEqual([
      { address: `${base}@waas.example`, in_use: false },
      { address: 'acme@waas.example', in_use: true },
    ]);
    // An owner's own domain as the address: back to the base domain's mailbox, which is in use again.
    await admin('PUT', `/admin/tenants/${id}/domains/main`, { domainName: 'acme-shop.example.com' });
    await waitFor(async () => t.provisioner.stores.get(id)!.mailFrom === `${base}@waas.example`);
    expect(await senders(id)).toEqual([
      { address: `${base}@waas.example`, in_use: true },
      { address: 'acme@waas.example', in_use: false },
    ]);
  });

  it("never gives a store an address another store has sent from, or the platform's own", async () => {
    const first = await createTenant('First');
    const second = await createTenant('Second');
    await t.pool.query("INSERT INTO tenant_mail_senders (tenant_id, address, last_used) VALUES ($1, 'bigshop@waas.example', now() - interval '1 year')", [first]);
    const setMain = async (tenantId: string, domain: string) => {
      await t.pool.query('UPDATE tenant_domains SET is_main = false WHERE tenant_id = $1', [tenantId]);
      await t.pool.query('INSERT INTO tenant_domains (tenant_id, domain_name, is_main) VALUES ($1, $2, true)', [tenantId, domain]);
    };
    await setMain(second, 'bigshop.waas.example');
    expect(await storeMailbox(t.pool, t.provisioner, t.deps.config, second)).toBe(baseLabel(second));
    await setMain(first, 'firstshop.waas.example');
    expect(await storeMailbox(t.pool, t.provisioner, t.deps.config, first)).toBe('firstshop');

    t.provisioner.platformMailFrom = 'store@waas.example';
    await setMain(first, 'store.waas.example');
    expect(await storeMailbox(t.pool, t.provisioner, t.deps.config, first)).toBe(baseLabel(first));
    t.provisioner.platformMailFrom = 'no-reply@waas.example';
  });
});

describe('the hourly count', () => {
  let acme: string;
  let bigacme: string;
  let reply: string;
  let counter: FakeCounter;
  const pushes: { storeId: string; month: string; sent: number }[] = [];
  const usage = async () =>
    Object.fromEntries((await t.pool.query('SELECT tenant_id, sent FROM tenant_mail_usage WHERE month = $1', [month])).rows.map((r) => [r.tenant_id, r.sent]));

  beforeAll(async () => {
    await t.pool.query('DELETE FROM tenants');
    acme = await createTenant('Acme Count');
    bigacme = await createTenant('Big Acme');
    reply = await createTenant('Reply');
    // Each store's addresses this month: acme's earlier one (no longer in use) too.
    await t.pool.query('DELETE FROM tenant_mail_senders');
    await t.pool.query(
      `INSERT INTO tenant_mail_senders (tenant_id, address, last_used) VALUES
         ($1, 'acme@waas.example', NULL), ($1, 'acme-old@waas.example', now()),
         ($1, 'acme-older@waas.example', now() - interval '3 months'),
         ($2, 'bigacme@waas.example', NULL), ($3, 'reply@waas.example', NULL)`,
      [acme, bigacme, reply],
    );
    const original = t.provisioner.setMailCount.bind(t.provisioner);
    t.provisioner.setMailCount = async (input) => {
      pushes.push(input);
      return original(input);
    };
  });
  beforeEach(() => {
    counter = new FakeCounter();
    counter.messages = [
      ...Array.from({ length: 3 }, () => ({ from: 'acme@waas.example' })),
      { from: 'ACME-old@waas.example' },
      { from: 'acme-older@waas.example' },
      ...Array.from({ length: 5 }, () => ({ from: 'bigacme@waas.example' })),
      { from: 'bigacme@waas.example', status: 'failed' },
      { from: 'acme@waas.example', status: 'suppressed' },
      { from: 'acme@waas.example', status: 'spam' },
      { from: 'acme@waas.example', status: 'bounced' },
      { from: 'acme@waas.example', at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)) },
      // The platform's own address contains reply@: its mail is not that store's.
      ...Array.from({ length: 4 }, () => ({ from: 'no-reply@waas.example' })),
      { from: 'reply@waas.example' },
    ];
    pushes.length = 0;
  });

  it("counts each store's addresses this month, without longer addresses that contain them, and tells each store", async () => {
    expect(await countStoreMail(t.pool, counter, t.provisioner, { pauseMs: 0, log: quiet })).toEqual({ counted: 3, pushed: 3, stopped: false });
    // acme: 3 sent, 1 bounced (billed), its address from earlier this month; not suppressed, spam, last month's or bigacme's.
    expect(await usage()).toEqual({ [acme]: 5, [bigacme]: 5, [reply]: 1 });
    expect(pushes).toEqual(
      expect.arrayContaining([
        { storeId: acme, month, sent: 5 },
        { storeId: bigacme, month, sent: 5 },
        { storeId: reply, month, sent: 1 },
      ]),
    );
    expect(t.provisioner.stores.get(acme)!.mailCount).toEqual({ month, sent: 5 });
    // From the first of the month (UTC), and each address counted once.
    expect(new Set(counter.queries.map((q) => q.from))).toEqual(new Set([new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()]));
    expect(counter.queries.filter((q) => q.search === 'bigacme@waas.example' && !q.status)).toHaveLength(1);
    expect(counter.queries.some((q) => q.search === 'acme-older@waas.example')).toBe(false);

    const detail = await admin('GET', `/admin/tenants/${acme}`);
    expect(detail.emailUsage).toMatchObject({ month, sent: 5 });
    const validate = ajv.compile({ $ref: 'admin#/components/schemas/TenantDetail' });
    expect(validate(detail), ajv.errorsText(validate.errors)).toBe(true);
  });

  it('tells a store only when its count changed, and skips suspended stores', async () => {
    await countStoreMail(t.pool, counter, t.provisioner, { pauseMs: 0, log: quiet });
    expect(pushes).toEqual([]);

    counter.messages.push({ from: 'bigacme@waas.example' });
    await t.pool.query('UPDATE tenants SET is_suspended = true WHERE id = $1', [reply]);
    counter.messages.push({ from: 'reply@waas.example' });
    expect(await countStoreMail(t.pool, counter, t.provisioner, { pauseMs: 0, log: quiet })).toMatchObject({ counted: 2, pushed: 1 });
    // acme's count is unchanged: the new bigacme@ message is taken off its search.
    expect(pushes).toEqual([{ storeId: bigacme, month, sent: 6 }]);
    expect(await usage()).toEqual({ [acme]: 5, [bigacme]: 6, [reply]: 1 });
    await t.pool.query('UPDATE tenants SET is_suspended = false WHERE id = $1', [reply]);
  });

  it("stops at toSend's rate limit, keeps what it counted, and starts with the rest next time", async () => {
    await t.pool.query('UPDATE tenant_mail_usage SET checked_at = now() - interval \'1 hour\' WHERE tenant_id = $1', [bigacme]);
    counter.messages.push({ from: 'reply@waas.example' }, { from: 'bigacme@waas.example' }, { from: 'bigacme@waas.example' }, { from: 'acme@waas.example' });
    // bigacme (checked longest ago) first: its search and the three statuses, then the limit.
    counter.limit = 4;
    const log = { log: () => undefined, error: (m: string) => errors.push(m) };
    const errors: string[] = [];
    expect(await countStoreMail(t.pool, counter, t.provisioner, { pauseMs: 0, log })).toEqual({ counted: 1, pushed: 1, stopped: true });
    expect(errors[0]).toMatch(/rate limit reached after 1 of 3 stores/);
    expect(await usage()).toEqual({ [acme]: 5, [bigacme]: 7, [reply]: 1 });

    counter.queries = [];
    counter.limit = Infinity;
    pushes.length = 0;
    await countStoreMail(t.pool, counter, t.provisioner, { pauseMs: 0, log: quiet });
    // The stores the last run did not reach come first.
    expect(pushes.map((p) => p.storeId).slice(0, 2).sort()).toEqual([acme, reply].sort());
    expect(await usage()).toEqual({ [acme]: 6, [bigacme]: 7, [reply]: 2 });
  });

  it('paces its searches, and a store that could not be told is told on the next run', async () => {
    const pauses: number[] = [];
    counter.messages.push({ from: 'reply@waas.example' }, { from: 'reply@waas.example' });
    t.provisioner.failNext('setMailCount');
    const errors: string[] = [];
    await countStoreMail(t.pool, counter, t.provisioner, { sleep: async (ms) => void pauses.push(ms), log: { log: () => undefined, error: (m) => errors.push(m) } });
    expect(pauses.length).toBe(counter.queries.length - 1);
    expect(new Set(pauses)).toEqual(new Set([250]));
    // reply, checked longest ago, is told first.
    expect(errors).toEqual([expect.stringMatching(/email count 3 not sent to the store/)]);
    expect((await usage())[reply]).toBe(2);
    await countStoreMail(t.pool, counter, t.provisioner, { pauseMs: 0, log: quiet });
    expect((await usage())[reply]).toBe(3);
  });
});

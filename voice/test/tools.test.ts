// The receptionist's tools and instructions, against a fake AnyPress API: every store call goes to the called
// number's store with the caller's number from the call, and the call state follows what happened.
import { describe, expect, it } from 'vitest';
import { type Line, VoiceApi } from '../src/api.ts';
import { businessName, instructions } from '../src/prompt.ts';
import { createTools, newCallState } from '../src/tools.ts';

const NUMBER = '+12135550100';
const CALLER = '+15550102000';
const line: Line = {
  tenantId: 't1',
  name: 'rosa-test',
  domain: 'rosa.anypress.site',
  forwardTo: '+12135550199',
  usedMinutes: 3,
  limitMinutes: 100,
  minutesLeft: 97,
  business: { site: { businessName: 'Rosa Plumbing', timezone: 'America/Los_Angeles' }, about: { hours: 'Mon to Sat, 8 to 6', area: 'East LA' } },
};

function fakeApi() {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}'));
    calls.push({ url, body });
    const answer = body.path === '/phone/bookings' ? { booked: true, id: 7 } : body.path === '/phone/callers' ? { saved: true } : { services: [] };
    return new Response(JSON.stringify({ status: 200, body: answer }), { status: 200 });
  }) as unknown as typeof fetch;
  return { api: new VoiceApi('https://api.example.test', 'token', fetchImpl), calls };
}

const run = (tool: any, args: unknown) => tool.execute(args, {} as never);
const byName = (tools: any[], name: string) => tools.find((t) => t.name === name);

describe('the receptionist', () => {
  it('speaks as the business, with its facts', () => {
    expect(businessName(line)).toBe('Rosa Plumbing');
    const text = instructions(line, new Date('2026-11-05T17:00:00Z'), 'America/Los_Angeles');
    expect(text).toContain('phone receptionist for Rosa Plumbing');
    expect(text).toContain('Opening hours: Mon to Sat, 8 to 6');
    expect(text).not.toMatch(/anypress/i);
  });

  it('only takes messages once the month’s minutes are used', () => {
    const text = instructions({ ...line, minutesLeft: 0 }, new Date(), 'America/Los_Angeles');
    expect(text).toContain('can only take messages');
    const { api } = fakeApi();
    const tools = createTools({ api, number: NUMBER, caller: CALLER, timezone: 'UTC', canBook: false, state: newCallState(), transfer: async () => false });
    expect(tools.map((t) => t.name).sort()).toEqual(['put_through', 'save_caller']);
  });

  it('books for the called store with the caller’s number, then saves the caller', async () => {
    const { api, calls } = fakeApi();
    const state = newCallState();
    const tools = createTools({ api, number: NUMBER, caller: CALLER, timezone: 'America/Los_Angeles', canBook: true, state, transfer: async () => false });
    await run(byName(tools, 'book_time'), { serviceId: 3, start: '2026-11-06 09:00:00', name: 'Sam Lee', note: 'Sink leak' });
    expect(calls[0]!.url).toBe(`https://api.example.test/voice/lines/${encodeURIComponent(NUMBER)}/store`);
    expect(calls[0]!.body).toMatchObject({ method: 'POST', path: '/phone/bookings', body: { service: 3, phone: CALLER, timezone: 'America/Los_Angeles' } });
    expect(state.outcome).toBe('booked');
    await run(byName(tools, 'save_caller'), { name: 'Sam Lee', interested: 'Leak repair', summary: 'Booked a leak repair for Friday 9am.', tookMessage: false });
    expect(calls[1]!.body).toMatchObject({ path: '/phone/callers', body: { phone: CALLER, interested: 'Leak repair' } });
    expect(state).toMatchObject({ outcome: 'booked', saved: true, summary: 'Booked a leak repair for Friday 9am.' });
  });

  it('marks an urgent call and falls back to a message when it can’t put the caller through', async () => {
    const { api } = fakeApi();
    const state = newCallState();
    const tools = createTools({ api, number: NUMBER, caller: CALLER, timezone: 'UTC', canBook: true, state, transfer: async () => false });
    const res = await run(byName(tools, 'put_through'), { reason: 'Pipe burst, kitchen flooding' });
    expect(res.transferred).toBe(false);
    expect(state.urgent).toBe(true);
    await run(byName(tools, 'save_caller'), { summary: 'Burst pipe, wants a call back now.', tookMessage: true });
    expect(state.outcome).toBe('message');
  });
});

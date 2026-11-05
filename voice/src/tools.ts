// The receptionist's tools. Each one acts for the store behind the called number only: the number comes from the
// call itself (LiveKit's SIP attributes), never from the model.
import { llm } from '@livekit/agents';
import { z } from 'zod';
import type { Outcome, VoiceApi } from './api.ts';

/** What happened on this call so far, for the call log when it ends. */
export interface CallState {
  outcome: Outcome;
  urgent: boolean;
  summary: string;
  saved: boolean;
}

export const newCallState = (): CallState => ({ outcome: 'hung_up', urgent: false, summary: '', saved: false });

/** What the store said, cut to what a model needs to read back on the phone. */
const answer = (res: { status: number; body: any }) => (res.status >= 400 ? { error: res.body?.message ?? `The store answered ${res.status}` } : res.body);

export function createTools(options: {
  api: VoiceApi;
  /** The store's number that was called (E.164). */
  number: string;
  /** The caller's own number, from the call. */
  caller: string | null;
  timezone: string;
  canBook: boolean;
  state: CallState;
  /** Puts the caller through to the owner; false when there's no one to put them through to or it failed. */
  transfer: () => Promise<boolean>;
}) {
  const { api, number, caller, timezone, state } = options;
  const tools: llm.FunctionTool<any, any, any>[] = [];

  if (options.canBook) {
    tools.push(llm.tool({
      name: 'list_services',
      description: 'The kinds of visits or appointments the business takes bookings for, with how long each takes. Call before offering times.',
      execute: async () => answer(await api.store(number, 'GET', '/phone/services')),
    }));

    tools.push(llm.tool({
      name: 'open_times',
      description: 'Open start times for one service over the next days, in the business time zone. Offer the caller two or three of them.',
      parameters: z.object({
        serviceId: z.number().int().positive().describe('The id from list_services'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First day to look at, YYYY-MM-DD; default today'),
      }),
      execute: async ({ serviceId, from }) => answer(await api.store(number, 'GET', `/phone/services/${serviceId}/times`, { query: { timezone, ...(from ? { from } : {}) } })),
    }));

    tools.push(llm.tool({
      name: 'book_time',
      description: 'Books one open time for the caller. Only after they picked the time and you read it back. If the time was just taken, offer another.',
      parameters: z.object({
        serviceId: z.number().int().positive(),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/).describe('Exactly as open_times gave it'),
        name: z.string().min(1).describe('The caller’s name'),
        address: z.string().optional().describe('Where the visit is, if at their place'),
        note: z.string().optional().describe('What the job is about, in a few words'),
        email: z.string().optional().describe('Only if the caller offered it'),
        phone: z.string().optional().describe('Only if they want a different number than the one they are calling from'),
      }),
      execute: async (args) => {
        const phone = args.phone || caller;
        if (!phone) return { error: 'Ask the caller for the best phone number first.' };
        const res = answer(await api.store(number, 'POST', '/phone/bookings', { body: { service: args.serviceId, start: args.start, timezone, name: args.name, phone, email: args.email, address: args.address, note: args.note } }));
        if (res?.booked) state.outcome = 'booked';
        return res;
      },
    }));
  }

  tools.push(llm.tool({
    name: 'put_through',
    description: 'For urgent calls only: puts the caller through to someone at the business now. If it fails, take an urgent message instead.',
    parameters: z.object({ reason: z.string().describe('What the emergency is, in a few words') }),
    execute: async ({ reason }) => {
      state.urgent = true;
      state.summary ||= `Urgent: ${reason}`;
      if (await options.transfer()) {
        state.outcome = 'transferred';
        return { transferred: true };
      }
      return { transferred: false, next: 'Nobody can be put through right now. Take an urgent message, and say someone will call back as soon as possible.' };
    },
  }));

  tools.push(llm.tool({
    name: 'save_caller',
    description: 'Saves the caller for the business, once, just before goodbye: their details, what they asked about and a short summary.',
    parameters: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional().describe('Only if different from the number they are calling from'),
      interested: z.string().optional().describe('The service they asked about, in a few words'),
      urgent: z.boolean().optional(),
      summary: z.string().describe('One or two sentences: what they needed and what happens next'),
      tookMessage: z.boolean().describe('True if they left a message for someone to call back'),
    }),
    execute: async (args) => {
      if (args.urgent) state.urgent = true;
      state.summary = args.summary;
      if (state.outcome === 'hung_up') state.outcome = args.tookMessage ? 'message' : 'answered';
      const phone = args.phone || caller;
      if (!phone) return { saved: false, note: 'No phone number for the caller; that is fine, the summary is kept.' };
      const res = answer(await api.store(number, 'POST', '/phone/callers', { body: { name: args.name, email: args.email, phone, interested: args.interested, urgent: state.urgent, summary: args.summary } }));
      state.saved = !!res?.saved;
      return res;
    },
  }));

  return tools;
}

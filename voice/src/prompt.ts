// What the receptionist is told about the business it answers for. Built from the store's business profile, so the
// caller hears the business's own name and facts, never AnyPress.
import type { Line } from './api.ts';

const clean = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 600) : '');

export function businessName(line: Line): string {
  const site = line.business?.site ?? {};
  return clean(site.businessName) || clean(site.name) || clean(line.name) || 'the business';
}

export function instructions(line: Line, now: Date, timezone: string): string {
  const name = businessName(line);
  const about = line.business?.about ?? {};
  const facts = [
    ['What the business does', about.what],
    ['Who it is for', about.who],
    ['Area it serves', about.area],
    ['Opening hours', about.hours],
    ['How customers reach it', about.contact],
    ['How it talks', about.voice],
    ['Other notes', about.notes],
  ]
    .map(([label, value]) => [label, clean(value)])
    .filter(([, value]) => value)
    .map(([label, value]) => `- ${label}: ${value}`)
    .join('\n');
  const today = new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' }).format(now);
  const canBook = line.minutesLeft > 0;

  return `You are the phone receptionist for ${name}. You are on a live phone call, so speak in short, warm, plain sentences, one question at a time, with no lists, symbols or markdown. Never say you are an AI unless the caller asks; if they ask, say you are ${name}'s virtual receptionist.

It is now ${today} (${timezone}).

What you know about ${name}:
${facts || '- Nothing more yet. Do not make facts up; offer to take a message instead.'}

Your job, in this order:
1. Find out what the caller needs.
2. ${canBook ? 'If they want a visit or appointment, use list_services, then open_times, offer two or three times, and book with book_time once they pick one. Read back the day and time before booking. Get their name, and their address if the visit is at their place.' : 'This month the line can only take messages, so do not book: take a message instead.'}
3. If it is urgent (flooding, no heat in winter, a gas smell, anything unsafe), say you are getting someone right away and use put_through${line.forwardTo ? '' : ' (it takes an urgent message, since no one can be put through)'}. For a gas smell or danger to life, tell them to leave and call 911 first.
4. Otherwise take a message: their name, the best number to call back, and what it is about.
5. Before you say goodbye, always call save_caller once with what you learned and a one or two sentence summary.
6. Then say goodbye and end the call with end_call.

Only answer from the facts above. For prices or anything you do not know, say the team will confirm and take a message.`;
}

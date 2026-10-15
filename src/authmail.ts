/**
 * Sign-in email (docs/accounts.md): the one-time link from "Email me a sign-in link", and team
 * invitations, sent through
 * toSend's API (POST /v2/emails). By default it uses the stores' sending key and address
 * (STORE_SMTP_PASSWORD, STORE_MAIL_FROM), so no extra setup is needed where stores already send email.
 */
export interface AuthMail {
  /** A toSend API key that may send from `from`. */
  key: string;
  from: string;
  /** Shown as the sender and in the subject. */
  brand: string;
  apiUrl?: string;
}

export async function sendSignInLink(mail: AuthMail, to: string, url: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const text = `Use this link to sign in to ${mail.brand}:\n\n${url}\n\nIt works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.`;
  const html =
    `<p>Use this link to sign in to ${escape(mail.brand)}:</p>` +
    `<p><a href="${escape(url)}">Sign in to ${escape(mail.brand)}</a></p>` +
    `<p style="color:#666">It works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.</p>`;
  await send(mail, to, `Your ${mail.brand} sign-in link`, html, text, 'sign-in email', fetchFn);
}

export interface InvitationMail {
  /** Where they accept (the dashboard's /invite/<id>). */
  url: string;
  /** The storefront's team they join. */
  organization: string;
  /** Who invited them; null when the platform admin did. */
  inviter: string | null;
  days: number;
}

/** An invitation to join a storefront's team. They sign in with this address, then accept. */
export async function sendInvitation(mail: AuthMail, to: string, invite: InvitationMail, fetchFn: typeof fetch = fetch): Promise<void> {
  const who = invite.inviter ? `${invite.inviter} invited you` : "You've been invited";
  const lead = `${who} to join ${invite.organization} on ${mail.brand}.`;
  const how = `Open the link and sign in with this email address (${to}). The invitation lasts ${invite.days} days.`;
  const text = `${lead}\n\n${invite.url}\n\n${how} If you weren't expecting it, you can ignore this email.`;
  const html =
    `<p>${escape(lead)}</p>` +
    `<p><a href="${escape(invite.url)}">Join ${escape(invite.organization)}</a></p>` +
    `<p style="color:#666">${escape(how)} If you weren't expecting it, you can ignore this email.</p>`;
  await send(mail, to, `Join ${invite.organization} on ${mail.brand}`, html, text, 'invitation email', fetchFn);
}

async function send(mail: AuthMail, to: string, subject: string, html: string, text: string, what: string, fetchFn: typeof fetch) {
  const res = await fetchFn(`${(mail.apiUrl ?? 'https://api.tosend.com').replace(/\/$/, '')}/v2/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mail.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ from: { email: mail.from, name: mail.brand }, to: [{ email: to }], subject, html, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`toSend refused the ${what} (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

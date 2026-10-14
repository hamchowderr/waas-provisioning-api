/**
 * Sign-in email (docs/accounts.md): the one-time link from "Email me a sign-in link", sent through
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
  const res = await fetchFn(`${(mail.apiUrl ?? 'https://api.tosend.com').replace(/\/$/, '')}/v2/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mail.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ from: { email: mail.from, name: mail.brand }, to: [{ email: to }], subject: `Your ${mail.brand} sign-in link`, html, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`toSend refused the sign-in email (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

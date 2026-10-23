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
  /** Set when `brand` is a seller's (src/branding.ts, brandedMail): the platform's name, for a small "Powered by" line. */
  poweredBy?: string;
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
  // A storefront's team invited in its own name (brandedMail) isn't told the name twice.
  const where = invite.organization === mail.brand ? `the ${invite.organization} team` : `${invite.organization} on ${mail.brand}`;
  const lead = `${who} to join ${where}.`;
  const how = `Open the link and sign in with this email address (${to}). The invitation lasts ${invite.days} days.`;
  const text = `${lead}\n\n${invite.url}\n\n${how} If you weren't expecting it, you can ignore this email.`;
  const html =
    `<p>${escape(lead)}</p>` +
    `<p><a href="${escape(invite.url)}">Join ${escape(invite.organization)}</a></p>` +
    `<p style="color:#666">${escape(how)} If you weren't expecting it, you can ignore this email.</p>`;
  await send(mail, to, `Join ${where}`, html, text, 'invitation email', fetchFn);
}

/** What a seller application email needs to say. */
export interface ApplicationMail {
  name: string;
  business: string;
}

/** To the applicant: their application to sell arrived and is waiting for review. */
export async function sendApplicationReceived(mail: AuthMail, to: string, app: ApplicationMail, fetchFn: typeof fetch = fetch): Promise<void> {
  const lead = `Hi ${app.name}, thanks for applying to sell websites with ${mail.brand} as ${app.business}.`;
  const next = "We review every application by hand. When yours is approved, you'll get another email with a link to sign in.";
  await send(mail, to, `We got your ${mail.brand} application`, `<p>${escape(lead)}</p><p>${escape(next)}</p>`, `${lead}\n\n${next}`, 'application email', fetchFn);
}

/** To the platform admin: a new application is waiting on the dashboard at `url`. */
export async function sendApplicationNotice(mail: AuthMail, to: string, app: ApplicationMail & { email: string; url: string }, fetchFn: typeof fetch = fetch): Promise<void> {
  const lead = `${app.name} (${app.email}) applied to sell websites as ${app.business}.`;
  const html = `<p>${escape(lead)}</p><p><a href="${escape(app.url)}">Review the application</a></p>`;
  await send(mail, to, `New seller application: ${app.business}`, html, `${lead}\n\nReview it: ${app.url}`, 'application notice', fetchFn);
}

/** To the applicant: approved. They sign in at `url` (their owner invitation) with this address. */
export async function sendApplicationApproved(mail: AuthMail, to: string, app: ApplicationMail & { url: string; days: number; storefront: string | null }, fetchFn: typeof fetch = fetch): Promise<void> {
  const lead = `Hi ${app.name}, your application to sell websites with ${mail.brand} is approved.`;
  const how = `Open the link and sign in with this email address (${to}) to set up ${app.business}. The link lasts ${app.days} days.`;
  const storefront = app.storefront
    ? `We're also building your storefront at https://${app.storefront}. It's usually ready within a few minutes; sign in to it with "Lost your password?" on its login page.`
    : null;
  const html =
    `<p>${escape(lead)}</p><p><a href="${escape(app.url)}">Sign in to ${escape(mail.brand)}</a></p><p style="color:#666">${escape(how)}</p>` +
    (storefront ? `<p>${escape(storefront)}</p>` : '');
  const text = `${lead}\n\n${app.url}\n\n${how}${storefront ? `\n\n${storefront}` : ''}`;
  await send(mail, to, `Your ${mail.brand} application is approved`, html, text, 'approval email', fetchFn);
}

/** What a failed-job alert says (src/jobalerts.ts). */
export interface JobFailureMail {
  /** "Build the store Acme (acme.anypress.site)" and the like. */
  what: string;
  error: string;
  attempts: number;
  /** The dashboard's Jobs page, where it can be retried. Unset when sign-in is off. */
  url?: string;
}

/** To the platform admin: a store or version job failed its last retry. */
export async function sendJobFailureNotice(mail: AuthMail, to: string, job: JobFailureMail, fetchFn: typeof fetch = fetch): Promise<void> {
  const lead = `This failed after ${job.attempts} ${job.attempts === 1 ? 'try' : 'tries'}: ${job.what}.`;
  const next = job.url ? 'Retry it from the Jobs page once the cause is fixed.' : 'Retry it with POST /admin/jobs/{id}/retry once the cause is fixed.';
  const html =
    `<p>${escape(lead)}</p><p style="font-family:monospace;white-space:pre-wrap">${escape(job.error)}</p>` +
    (job.url ? `<p><a href="${escape(job.url)}">Open the Jobs page</a></p>` : '') +
    `<p style="color:#666">${escape(next)}</p>`;
  const text = `${lead}\n\n${job.error}\n\n${job.url ? `${job.url}\n\n` : ''}${next}`;
  await send(mail, to, `Failed: ${job.what}`, html, text, 'job failure notice', fetchFn);
}

/** To the platform admins: the nightly restore test (src/restoretests.ts) could not restore a store's backup. */
export async function sendRestoreTestFailed(mail: AuthMail, to: string, test: { store: string; backupAt: Date; error: string }, fetchFn: typeof fetch = fetch): Promise<void> {
  const lead = `Last night's restore test failed: the backup of ${test.store} from ${test.backupAt.toISOString().slice(0, 16).replace('T', ' ')} UTC could not be restored into a test copy.`;
  const next = 'The store itself is untouched and the test copy was deleted. The test runs again tomorrow night, on the store tested longest ago.';
  const html = `<p>${escape(lead)}</p><p style="font-family:monospace;white-space:pre-wrap">${escape(test.error)}</p><p style="color:#666">${escape(next)}</p>`;
  const text = `${lead}\n\n${test.error}\n\n${next}`;
  await send(mail, to, `Failed: restore test of ${test.store}`, html, text, 'restore test notice', fetchFn);
}

/** To the applicant: not approved. */
export async function sendApplicationDeclined(mail: AuthMail, to: string, app: ApplicationMail, fetchFn: typeof fetch = fetch): Promise<void> {
  const lead = `Hi ${app.name}, thanks for applying to sell websites with ${mail.brand} as ${app.business}.`;
  const body = "We can't offer you a seller account right now. If you have questions, contact us through our website.";
  await send(mail, to, `Your ${mail.brand} application`, `<p>${escape(lead)}</p><p>${escape(body)}</p>`, `${lead}\n\n${body}`, 'decline email', fetchFn);
}

async function send(mail: AuthMail, to: string, subject: string, html: string, text: string, what: string, fetchFn: typeof fetch) {
  if (mail.poweredBy) {
    html += `<p style="color:#999;font-size:12px">Powered by ${escape(mail.poweredBy)}</p>`;
    text += `\n\nPowered by ${mail.poweredBy}`;
  }
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

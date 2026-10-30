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
  /** Shown in the footer as the address to write to with questions. */
  supportEmail?: string;
  /** A logo image (https) shown above the message. */
  logoUrl?: string;
  /** The no-reply sender a seller's branded email uses, when `from` is the platform's own support address. */
  plainFrom?: string;
}

/** The platform's own address and logo when it runs under the default AnyPress name (src/auth.ts). */
export const ANYPRESS_MAIL = { supportEmail: 'support@anypress.io', logoUrl: 'https://anypress.io/logo-512.png' };

export async function sendSignInLink(mail: AuthMail, to: string, url: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const text = `Use this link to sign in to ${mail.brand}:\n\n${url}\n\nIt works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.`;
  const html = layout(mail, {
    title: `Sign in to ${mail.brand}`,
    lines: [`Use this button to sign in to ${mail.brand}.`],
    button: { label: `Sign in to ${mail.brand}`, url },
    note: "It works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.",
  });
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
  /** What the account they're joining is for, when the platform admin invites its first owner (welcomeText). */
  welcome?: string | null;
}

/**
 * The one paragraph that says what a new seller's or reseller's account does: in the approval email,
 * and in the invitation when the platform admin sets an account up by hand.
 */
export function welcomeText(reseller: boolean): string {
  return reseller
    ? 'Your reseller account runs several storefronts, each with its own brand and prices, from one sign-in. You get one bill each month for all your websites at your wholesale price, and partner keys for the API are on your reseller page.'
    : 'From your dashboard you can open your free storefront (the shop your customers buy from), set your own prices and see every website you sell.';
}

/** An invitation to join a storefront's team. They sign in with this address, then accept. */
export async function sendInvitation(mail: AuthMail, to: string, invite: InvitationMail, fetchFn: typeof fetch = fetch): Promise<void> {
  const who = invite.inviter ? `${invite.inviter} invited you` : "You've been invited";
  // A storefront's team invited in its own name (brandedMail) isn't told the name twice.
  const where = invite.organization === mail.brand ? `the ${invite.organization} team` : `${invite.organization} on ${mail.brand}`;
  const lead = `${who} to join ${where}.`;
  const how = `Open the link and sign in with this email address (${to}). The invitation lasts ${invite.days} days.`;
  const text = `${lead}\n\n${invite.url}\n\n${how} If you weren't expecting it, you can ignore this email.${invite.welcome ? `\n\n${invite.welcome}` : ''}`;
  const html = layout(mail, {
    title: `Join ${invite.organization}`,
    lines: invite.welcome ? [lead, invite.welcome] : [lead],
    button: { label: `Join ${invite.organization}`, url: invite.url },
    note: `${how} If you weren't expecting it, you can ignore this email.`,
  });
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
  await send(mail, to, `We got your ${mail.brand} application`, layout(mail, { title: 'Thanks for applying', lines: [lead, next] }), `${lead}\n\n${next}`, 'application email', fetchFn);
}

/** To the platform admin: a new application is waiting on the dashboard at `url`. */
export async function sendApplicationNotice(mail: AuthMail, to: string, app: ApplicationMail & { email: string; url: string }, fetchFn: typeof fetch = fetch): Promise<void> {
  const lead = `${app.name} (${app.email}) applied to sell websites as ${app.business}.`;
  const html = layout(mail, { title: 'New seller application', lines: [lead], button: { label: 'Review the application', url: app.url } });
  await send(mail, to, `New seller application: ${app.business}`, html, `${lead}\n\nReview it: ${app.url}`, 'application notice', fetchFn);
}

/**
 * To the applicant: approved. They sign in at `url` (their owner invitation) with this address. This is their one
 * welcome email at approval: the CRM's welcome series (src/crm.ts) starts days later, so it says what the account does.
 */
export async function sendApplicationApproved(
  mail: AuthMail,
  to: string,
  app: ApplicationMail & { url: string; days: number; storefront: string | null; reseller?: boolean },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const lead = `Hi ${app.name}, your application to sell websites with ${mail.brand} is approved.`;
  const how = `Open the link and sign in with this email address (${to}) to set up ${app.business}. The link lasts ${app.days} days.`;
  const what = welcomeText(app.reseller ?? false);
  const storefront = app.storefront
    ? `We're also building your storefront at https://${app.storefront}. It's usually ready within a few minutes; sign in to it with "Lost your password?" on its login page.`
    : null;
  const html = layout(mail, {
    title: "You're approved",
    lines: [lead, what],
    button: { label: `Sign in to ${mail.brand}`, url: app.url },
    note: storefront ? `${how}\n\n${storefront}` : how,
  });
  const text = `${lead}\n\n${what}\n\n${app.url}\n\n${how}${storefront ? `\n\n${storefront}` : ''}`;
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
  const html = layout(mail, {
    title: 'A job failed',
    lines: [lead],
    code: job.error,
    button: job.url ? { label: 'Open the Jobs page', url: job.url } : undefined,
    note: next,
  });
  const text = `${lead}\n\n${job.error}\n\n${job.url ? `${job.url}\n\n` : ''}${next}`;
  await send(mail, to, `Failed: ${job.what}`, html, text, 'job failure notice', fetchFn);
}

/** To the platform admins: the nightly restore test (src/restoretests.ts) could not restore a store's backup. */
export async function sendRestoreTestFailed(mail: AuthMail, to: string, test: { store: string; backupAt: Date; error: string }, fetchFn: typeof fetch = fetch): Promise<void> {
  const lead = `Last night's restore test failed: the backup of ${test.store} from ${test.backupAt.toISOString().slice(0, 16).replace('T', ' ')} UTC could not be restored into a test copy.`;
  const next = 'The store itself is untouched and the test copy was deleted. The test runs again tomorrow night, on the store tested longest ago.';
  const html = layout(mail, { title: 'Restore test failed', lines: [lead], code: test.error, note: next });
  const text = `${lead}\n\n${test.error}\n\n${next}`;
  await send(mail, to, `Failed: restore test of ${test.store}`, html, text, 'restore test notice', fetchFn);
}

/** To the applicant: not approved. */
export async function sendApplicationDeclined(mail: AuthMail, to: string, app: ApplicationMail, fetchFn: typeof fetch = fetch): Promise<void> {
  const lead = `Hi ${app.name}, thanks for applying to sell websites with ${mail.brand} as ${app.business}.`;
  const body = "We can't offer you a seller account right now. If you have questions, contact us through our website.";
  await send(mail, to, `Your ${mail.brand} application`, layout(mail, { title: 'About your application', lines: [lead, body] }), `${lead}\n\n${body}`, 'decline email', fetchFn);
}

/** What one email says, in reading order; layout() puts it in the shared look. */
interface Message {
  /** The headline at the top of the card. */
  title: string;
  lines: string[];
  /** Shown as plain monospace text, e.g. an error. */
  code?: string;
  /** The one thing to do, as a button. It is the email's first link, with the address written out under it. */
  button?: { label: string; url: string };
  /** Smaller grey text under the button; blank lines start a new paragraph. */
  note?: string;
}

const INK = '#141414';
const SOFT = '#5f5a55';
const LINE = '#e9e4de';
const PAPER = '#faf8f5';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/**
 * One look for every account email: the sender's logo and name, a card with a coloured top edge, a
 * headline, the message, one button (with its link written out for clients that block buttons) and a
 * footer with the support address. Tables and inline styles only, so it holds up in Outlook and Gmail.
 */
function layout(mail: AuthMail, m: Message): string {
  const name = `<span style="font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${INK}">${escape(mail.brand)}</span>`;
  const head = mail.logoUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:10px;vertical-align:middle"><img src="${escape(mail.logoUrl)}" width="36" height="36" alt="" style="display:block;border:0"></td><td style="vertical-align:middle">${name}</td></tr></table>`
    : name;
  const para = (t: string, style: string) => `<p style="margin:0 0 16px;${style}">${escape(t)}</p>`;
  const button = m.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 12px"><tr><td style="background:${INK};border-radius:8px"><a href="${escape(m.button.url)}" style="display:inline-block;padding:14px 24px;font-size:16px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none">${escape(m.button.label)}</a></td></tr></table>` +
      `<p style="margin:0 0 24px;font-size:13px;line-height:19px;color:${SOFT}">Or paste this link into your browser:<br><span style="color:${INK};word-break:break-all">${escape(m.button.url)}</span></p>`
    : '';
  const body =
    `<h1 style="margin:0 0 16px;font-size:24px;line-height:30px;font-weight:700;letter-spacing:-0.01em;color:${INK}">${escape(m.title)}</h1>` +
    m.lines.map((l) => para(l, `font-size:16px;line-height:25px;color:${INK}`)).join('') +
    (m.code ? `<pre style="margin:0 0 16px;padding:12px 14px;background:${PAPER};border:1px solid ${LINE};border-radius:6px;font-size:13px;line-height:19px;white-space:pre-wrap;word-break:break-word;color:${INK}">${escape(m.code)}</pre>` : '') +
    button +
    (m.note
      ? `<div style="border-top:1px solid ${LINE};padding-top:16px">${m.note.split('\n\n').map((n) => para(n, `font-size:14px;line-height:21px;color:${SOFT}`)).join('')}</div>`
      : '');
  const foot = [
    mail.supportEmail ? `Questions? Write to <a href="mailto:${escape(mail.supportEmail)}" style="color:${SOFT};text-decoration:underline">${escape(mail.supportEmail)}</a> or just reply to this email.` : '',
    mail.poweredBy ? `Powered by ${escape(mail.poweredBy)}` : '',
  ].filter(Boolean);
  return (
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>` +
    `<body style="margin:0;padding:0;background:${PAPER}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td align="center" style="padding:32px 12px;font-family:${FONT}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">` +
    `<tr><td style="padding:0 4px 20px">${head}</td></tr>` +
    `<tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;overflow:hidden">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td height="4" style="height:4px;line-height:4px;font-size:0;background:#ff7a2a;background-image:linear-gradient(90deg,#ffc75a,#ff7a2a,#ee2f5e,#d21fa4)">&nbsp;</td></tr>` +
    `<tr><td style="padding:32px 32px 16px">${body}</td></tr></table></td></tr>` +
    (foot.length ? `<tr><td style="padding:20px 4px 0;font-size:13px;line-height:20px;color:${SOFT}">${foot.join('<br>')}</td></tr>` : '') +
    `</table></td></tr></table></body></html>`
  );
}

async function send(mail: AuthMail, to: string, subject: string, html: string, text: string, what: string, fetchFn: typeof fetch) {
  if (mail.supportEmail) text += `\n\nQuestions? Write to ${mail.supportEmail} or just reply to this email.`;
  if (mail.poweredBy) text += `\n\nPowered by ${mail.poweredBy}`;
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

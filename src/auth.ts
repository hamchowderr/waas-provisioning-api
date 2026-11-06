import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { PostgresDialect } from 'kysely';
import { emailOTP, magicLink, organization } from 'better-auth/plugins';
import { ANYPRESS_MAIL, sendSignInLink, type AuthMail } from './authmail.ts';
import { brandedMail } from './branding.ts';
import { dashboardHostProduct } from './dashboarddomains.ts';
import type { Pool } from './db.ts';

/**
 * Sign-in for people (docs/accounts.md): Better Auth, with its tables in the `auth` schema of this
 * database. Each customer's organization belongs to one product, so its members see and manage
 * that product's stores from the dashboard, the way the product's API key does. Product API keys
 * (Basic auth on /v1) are unchanged and need none of this.
 *
 * The dashboard serves Better Auth's routes on its own origin (AUTH_URL, e.g. https://app.anypress.io,
 * proxying /api/auth/* here), so the session cookie belongs to the dashboard only. The dashboard's
 * server then passes that cookie on to /v1 and /account with `X-Session-Auth: 1`.
 */
export interface AuthConfig {
  /** Where people sign in: the dashboard's public origin, which proxies /api/auth/* to this API. */
  url: string;
  /** Signs session cookies. At least 32 characters (openssl rand -base64 32). */
  secret: string;
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
  /** Emailed sign-in links ("Email me a sign-in link"); on when a toSend key and sender are known. */
  mail?: AuthMail;
}

/** On when AUTH_URL and AUTH_SECRET are both set; off otherwise, and /api/auth answers 404. */
export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  const url = env.AUTH_URL?.trim().replace(/\/+$/, '');
  const secret = env.AUTH_SECRET?.trim();
  if (!url && !secret) return undefined;
  if (!url || !secret) throw new Error('AUTH_URL and AUTH_SECRET are needed together to turn on sign-in');
  if (!/^https?:\/\/[^/]+$/.test(url)) throw new Error('AUTH_URL must be an origin such as https://app.anypress.io');
  if (secret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)');
  const pair = (prefix: string) => {
    const clientId = env[`${prefix}_ID`]?.trim();
    const clientSecret = env[`${prefix}_SECRET`]?.trim();
    if (!clientId && !clientSecret) return undefined;
    // Half a pair leaves that button off rather than stopping the API, so emailed links still work.
    if (!clientId || !clientSecret) {
      console.warn(`${prefix}_ID and ${prefix}_SECRET are needed together; that sign-in is off until both are set`);
      return undefined;
    }
    return { clientId, clientSecret };
  };
  // Sign-in links go out like the stores' email unless AUTH_MAIL_KEY / AUTH_MAIL_FROM say otherwise.
  const mailKey = env.AUTH_MAIL_KEY?.trim() || env.STORE_SMTP_PASSWORD?.trim();
  const storeFrom = env.STORE_MAIL_FROM?.trim();
  const brand = env.AUTH_BRAND?.trim();
  // Under the default AnyPress name the footer and logo are AnyPress's; another name sets its own or goes without.
  const supportEmail = env.AUTH_SUPPORT_EMAIL?.trim() || (brand ? undefined : ANYPRESS_MAIL.supportEmail);
  // Account email comes from the support address when the stores' sending domain covers it, so a reply reaches someone.
  const domain = (address: string | undefined) => address?.split('@')[1]?.toLowerCase();
  const fromSupport = supportEmail && storeFrom && domain(supportEmail) === domain(storeFrom) ? supportEmail : storeFrom;
  const mailFrom = env.AUTH_MAIL_FROM?.trim() || fromSupport;
  const mail = mailKey && mailFrom
    ? {
        key: mailKey,
        from: mailFrom,
        brand: brand || 'AnyPress',
        apiUrl: env.TOSEND_API_URL?.trim() || undefined,
        supportEmail,
        logoUrl: env.AUTH_LOGO_URL?.trim() || (brand ? undefined : ANYPRESS_MAIL.logoUrl),
        plainFrom: storeFrom && storeFrom !== mailFrom ? storeFrom : undefined,
      }
    : undefined;
  return { url, secret, github: pair('AUTH_GITHUB'), google: pair('AUTH_GOOGLE'), mail };
}

/** Organization roles. A member may only look; an admin or owner may also make changes. */
export type OrgRole = 'owner' | 'admin' | 'member';
export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member'];

/** Minutes a sign-in link and its code work. */
export const SIGN_IN_MINUTES = 15;

/**
 * The dashboard's /login/confirm page for a Better Auth sign-in link: the same query, so the page's
 * button goes on to /api/auth/magic-link/verify. Opening the page uses nothing, so a mail scanner
 * that opens every link (INKY, Safe Links) leaves the link working for the person.
 */
export function confirmPage(verifyUrl: string): string {
  const url = new URL(verifyUrl);
  url.pathname = '/login/confirm';
  return url.toString();
}

/** Days an invitation can be accepted. */
export const INVITATION_DAYS = 7;

/**
 * Sign-in answers on the platform's dashboard address and on sellers' own ones (src/dashboarddomains.ts),
 * so links and redirects use the address the person is on. That address comes from the dashboard's
 * X-Forwarded-Host, which the API's /api/auth route has already checked (src/app.ts): it is AUTH_URL's
 * host or a live dashboard address, never what a caller made up.
 */
export function createAuth(pool: Pool, config: AuthConfig, extraPlugins: BetterAuthPlugin[] = []) {
  const protocol = new URL(config.url).protocol === 'http:' ? 'http' : 'https';
  const auth = betterAuth({
    baseURL: { allowedHosts: ['*'], fallback: config.url, protocol },
    trustedOrigins: (request) => {
      const host = request?.headers.get('x-forwarded-host');
      return [config.url, ...(host ? [`${protocol}://${host}`] : [])];
    },
    secret: config.secret,
    // Its own schema keeps Better Auth's tables apart from ours; migrations/…_accounts.sql creates them.
    database: { dialect: new PostgresDialect({ pool }), type: 'postgres', schemaName: 'auth', casing: 'snake' },
    telemetry: { enabled: false },
    // The email-code plugin is only for typing the sign-in email's code (POST /sign-in/email-otp).
    disabledPaths: [
      '/email-otp/send-verification-otp',
      '/email-otp/check-verification-otp',
      '/email-otp/verify-email',
      '/email-otp/request-password-reset',
      '/forget-password/email-otp',
      '/email-otp/reset-password',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
    ],
    advanced: { database: { generateId: 'uuid' }, trustedProxyHeaders: true },
    // githubLogin: the GitHub username, so the dashboard can tell its platform admins
    // (ALLOWED_GITHUB_LOGINS) from customers. Set from GitHub only, never from what the user sends.
    user: { additionalFields: { githubLogin: { type: 'string', required: false, input: false } } },
    socialProviders: {
      ...(config.github ? { github: { ...config.github, mapProfileToUser: (profile) => ({ githubLogin: profile.login }) } } : {}),
      ...(config.google ? { google: config.google } : {}),
    },
    plugins: [
      organization({
        // Organizations are made by the platform admin, one per product (PUT /admin/products/:id/organization).
        allowUserToCreateOrganization: false,
        // The organization is the product's; only the platform admin's product removal ends it.
        disableOrganizationDeletion: true,
        invitationExpiresIn: INVITATION_DAYS * 24 * 60 * 60,
        requireEmailVerificationOnInvitation: true,
        // Invitations are made and emailed by our own routes (src/accounts.ts), not Better Auth's.
        async sendInvitationEmail() {},
        schema: {
          // A product's organization, or a reseller's, whose members reach all its storefronts (docs/resellers.md).
          organization: {
            modelName: 'organization',
            additionalFields: {
              productId: { type: 'string', required: false, input: false },
              resellerId: { type: 'string', required: false, input: false },
            },
          },
        },
      }),
      ...(config.mail
        ? [
            magicLink({
              // Signing in by link proves the address, so it counts as verified (needed to accept invitations).
              expiresIn: SIGN_IN_MINUTES * 60,
              storeToken: 'hashed',
              // On a seller's own dashboard address, the email comes in the seller's look (src/branding.ts).
              sendMagicLink: async ({ email, url }) => {
                const host = new URL(url).host;
                const productId = host === new URL(config.url).host ? null : await dashboardHostProduct(pool, host);
                const mail = productId ? await brandedMail(pool, config.mail!, productId) : config.mail!;
                const to = email.toLowerCase();
                // The same email carries a code for the sign-in page (POST /sign-in/email-otp), for mail
                // systems that block or rewrite links.
                const code = await auth.api.createVerificationOTP({ body: { email: to, type: 'sign-in' } });
                await sendSignInLink(mail, to, confirmPage(url), code);
              },
            }),
            // Codes are only sent inside the sign-in email above: asking for a code alone isn't offered.
            emailOTP({
              expiresIn: SIGN_IN_MINUTES * 60,
              storeOTP: 'hashed',
              // Unused: its own sending routes are turned off (disabledPaths).
              async sendVerificationOTP() {},
            }),
          ]
        : []),
      ...extraPlugins,
    ],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

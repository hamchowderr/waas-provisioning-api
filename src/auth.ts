import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { PostgresDialect } from 'kysely';
import { emailOTP, magicLink, organization } from 'better-auth/plugins';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { ANYPRESS_MAIL, sendSignInLink, type AuthMail } from './authmail.ts';
import { platformBrandOf } from './brand.ts';
import { brandedMail } from './branding.ts';
import { dashboardHostProduct } from './dashboarddomains.ts';
import type { Pool } from './db.ts';
import { mcpSignInPlugins } from './oauthserver.ts';

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
  /** The name on the "Sign in to …" buttons and emails: AUTH_BRAND, else the platform's (src/brand.ts). */
  brand: string;
  /** Emailed sign-in links ("Email me a sign-in link"); on when a toSend key and sender are known. */
  mail?: AuthMail;
  /**
   * The API's own public origin (PUBLIC_URL). With it, AI apps sign in to the MCP server through
   * Better Auth's MCP plugin (src/oauthserver.ts); without it, that sign-in is off.
   */
  apiUrl?: string;
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
  // The name is AUTH_BRAND, else the platform's (src/brand.ts). The support address is support@<BRAND_DOMAIN>
  // unless set; AnyPress's logo and colours go only on AnyPress's own install under the AnyPress name.
  const platform = platformBrandOf(env);
  const brand = env.AUTH_BRAND?.trim() || platform.name;
  const anypress = platform.anypress && brand === 'AnyPress';
  const supportEmail = env.AUTH_SUPPORT_EMAIL?.trim() || (platform.domain ? `support@${platform.domain}` : undefined);
  // Account email comes from the support address when the stores' sending domain covers it, so a reply reaches someone.
  const domain = (address: string | undefined) => address?.split('@')[1]?.toLowerCase();
  const fromSupport = supportEmail && storeFrom && domain(supportEmail) === domain(storeFrom) ? supportEmail : storeFrom;
  const mailFrom = env.AUTH_MAIL_FROM?.trim() || fromSupport;
  const mail = mailKey && mailFrom
    ? {
        key: mailKey,
        from: mailFrom,
        brand,
        apiUrl: env.TOSEND_API_URL?.trim() || undefined,
        supportEmail,
        logoUrl: env.AUTH_LOGO_URL?.trim() || (anypress ? ANYPRESS_MAIL.logoUrl : undefined),
        colourStrip: anypress || undefined,
        plainFrom: storeFrom && storeFrom !== mailFrom ? storeFrom : undefined,
      }
    : undefined;
  const apiUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined;
  return { url, secret, brand, github: pair('AUTH_GITHUB'), google: pair('AUTH_GOOGLE'), mail, apiUrl };
}

/** Organization roles. A member may only look; an admin or owner may also make changes. */
export type OrgRole = 'owner' | 'admin' | 'member';
export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member'];

/** Minutes a sign-in link and its code work. */
const SIGN_IN_MINUTES = 15;

/**
 * The dashboard's /login/confirm page for a Better Auth sign-in link: the same query, so the page's
 * button goes on to /api/auth/magic-link/verify. Opening the page uses nothing, so a mail scanner
 * that opens every link (INKY, Safe Links) leaves the link working for the person.
 */
function confirmPage(verifyUrl: string): string {
  const url = new URL(verifyUrl);
  url.pathname = '/login/confirm';
  return url.toString();
}

/**
 * Whether `email` is on the team of the storefront `productId`: a member, or invited and not yet answered, of its own
 * organization or of its reseller's.
 */
async function onTeam(pool: Pool, productId: string, email: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM products p JOIN auth.organization o ON o."productId" = p.id OR (p.reseller_id IS NOT NULL AND o."resellerId" = p.reseller_id)
      WHERE p.id = $1 AND (
        EXISTS (SELECT 1 FROM auth.member m JOIN auth."user" u ON u.id = m."userId" WHERE m."organizationId" = o.id AND lower(u.email) = $2)
        OR EXISTS (SELECT 1 FROM auth.invitation i WHERE i."organizationId" = o.id AND lower(i.email) = $2 AND i.status = 'pending' AND i."expiresAt" > now()))
      LIMIT 1`,
    [productId, email],
  );
  return (rowCount ?? 0) > 0;
}

/** A sign-in link moved to the platform's own address, its callbackURL kept as a path on it. */
function onPlatform(link: string, platform: string): string {
  const moved = new URL(link);
  const own = new URL(platform);
  moved.protocol = own.protocol;
  moved.host = own.host;
  for (const name of ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL']) {
    const value = moved.searchParams.get(name);
    if (!value) continue;
    try {
      const target = new URL(value, platform);
      moved.searchParams.set(name, `${target.pathname}${target.search}`);
    } catch {
      moved.searchParams.set(name, '/');
    }
  }
  return moved.toString();
}

/** Days an invitation can be accepted. */
export const INVITATION_DAYS = 7;

/**
 * Sign-in answers on the platform's dashboard address and on sellers' own ones (src/dashboarddomains.ts),
 * so links and redirects use the address the person is on. That address comes from the dashboard's
 * X-Forwarded-Host, which the API's /api/auth route has already checked (src/app.ts): it is AUTH_URL's
 * host or a live dashboard address, never what a caller made up.
 */
export function createAuth(
  pool: Pool,
  config: AuthConfig,
  extraPlugins: BetterAuthPlugin[] = [],
  options: { clientMetadataFetch?: ClientMetadataResourceFetch } = {},
) {
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
    // The session is also kept in a signed cookie for 5 minutes, so the dashboard's calls (each one
    // checks the session) don't read the session table every time. Signing out clears the cookie;
    // a session ended elsewhere stops working within the 5 minutes.
    session: { cookieCache: { enabled: true, maxAge: 5 * 60, strategy: 'compact' } },
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
      // The JWT plugin signs AI apps' access tokens (src/oauthserver.ts); sessions don't become JWTs.
      '/token',
    ],
    advanced: { database: { generateId: 'uuid' }, trustedProxyHeaders: true },
    // githubLogin: the GitHub username, so the dashboard can tell its platform admins
    // (ALLOWED_GITHUB_LOGINS) from customers. Set from GitHub only, never from what the user sends.
    // storeTenantId: set only on the one user each store gets for "Sign in with your website" (src/oauthserver.ts).
    user: {
      additionalFields: {
        githubLogin: { type: 'string', required: false, input: false },
        storeTenantId: { type: 'string', required: false, input: false },
      },
    },
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
                const to = email.toLowerCase();
                const host = new URL(url).host;
                const sellerProduct = host === new URL(config.url).host ? null : await dashboardHostProduct(pool, host);
                // A seller's own address is a domain the seller controls: if its DNS ever pointed somewhere else, a link
                // on it would hand the sign-in to them. So only that storefront's own team gets a link there; anyone
                // else's link is on the platform's address, in the platform's look.
                const productId = sellerProduct && (await onTeam(pool, sellerProduct, to)) ? sellerProduct : null;
                if (sellerProduct && !productId) url = onPlatform(url, config.url);
                const mail = productId ? await brandedMail(pool, config.mail!, productId) : config.mail!;
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
      ...(config.apiUrl ? mcpSignInPlugins(pool, { apiUrl: config.apiUrl, clientMetadataFetch: options.clientMetadataFetch }) : []),
      ...extraPlugins,
    ],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Deletes sign-in rows that can no longer be used: expired sessions, links and codes, and AI apps'
 * expired tokens. Better Auth only skips them, so without this they pile up. A day's grace keeps
 * anything that just ran out for looking into a sign-in problem. Daily maintenance (src/jobs.ts).
 */
export async function purgeExpiredSignIns(pool: Pool): Promise<number> {
  let removed = 0;
  for (const table of ['session', 'verification', 'oauthAccessToken', 'oauthRefreshToken', 'oauthClientAssertion']) {
    const { rowCount } = await pool.query(`DELETE FROM auth."${table}" WHERE "expiresAt" < now() - interval '1 day'`);
    removed += rowCount ?? 0;
  }
  return removed;
}

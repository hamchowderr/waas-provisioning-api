import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { PostgresDialect } from 'kysely';
import { organization } from 'better-auth/plugins';
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
    if (!clientId || !clientSecret) throw new Error(`${prefix}_ID and ${prefix}_SECRET are needed together`);
    return { clientId, clientSecret };
  };
  return { url, secret, github: pair('AUTH_GITHUB'), google: pair('AUTH_GOOGLE') };
}

/** Organization roles. A member may only look; an admin or owner may also make changes. */
export type OrgRole = 'owner' | 'admin' | 'member';
export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member'];

/** Days an invitation can be accepted. */
export const INVITATION_DAYS = 7;

export function createAuth(pool: Pool, config: AuthConfig, extraPlugins: BetterAuthPlugin[] = []) {
  return betterAuth({
    baseURL: config.url,
    secret: config.secret,
    // Its own schema keeps Better Auth's tables apart from ours; migrations/…_accounts.sql creates them.
    database: { dialect: new PostgresDialect({ pool }), type: 'postgres', schemaName: 'auth', casing: 'snake' },
    telemetry: { enabled: false },
    advanced: { database: { generateId: 'uuid' } },
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
        // The dashboard shows the invitation link; emailing it is a later step (waas-api-0pq.3).
        async sendInvitationEmail() {},
        schema: {
          organization: { modelName: 'organization', additionalFields: { productId: { type: 'string', required: true, input: false } } },
        },
      }),
      ...extraPlugins,
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

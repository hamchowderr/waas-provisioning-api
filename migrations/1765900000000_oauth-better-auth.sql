-- Up Migration
-- AI apps sign in through Better Auth's MCP plugin (src/oauthserver.ts) instead of the API's own OAuth
-- code. These are the tables its schema generator writes for the JWT, OAuth provider and CIMD plugins
-- (Better Auth 1.7.18), in the `auth` schema like the rest of sign-in, plus three of ours. Tokens the
-- old code issued (oauth_tokens) keep working until they expire or are revoked (src/oauth.ts).
alter table "auth"."user" add column "storeTenantId" text;
create table "auth"."jwks" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text);
create table "auth"."oauthClient" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" uuid references "auth"."user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb);
create table "auth"."oauthResource" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);
create table "auth"."oauthClientResource" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "clientId" text not null references "auth"."oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "auth"."oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);
create table "auth"."oauthRefreshToken" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "token" text not null unique, "clientId" text not null references "auth"."oauthClient" ("clientId") on delete cascade, "sessionId" uuid references "auth"."session" ("id") on delete set null, "userId" uuid not null references "auth"."user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);
create table "auth"."oauthAccessToken" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "token" text not null unique, "clientId" text not null references "auth"."oauthClient" ("clientId") on delete cascade, "sessionId" uuid references "auth"."session" ("id") on delete set null, "userId" uuid references "auth"."user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" uuid references "auth"."oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);
create table "auth"."oauthConsent" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "clientId" text not null references "auth"."oauthClient" ("clientId") on delete cascade, "userId" uuid references "auth"."user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);
create table "auth"."oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null);
create index "oauthClient_userId_idx" on "auth"."oauthClient" ("userId");
create index "oauthClientResource_clientId_idx" on "auth"."oauthClientResource" ("clientId");
create index "oauthClientResource_resourceId_idx" on "auth"."oauthClientResource" ("resourceId");
create index "oauthRefreshToken_clientId_idx" on "auth"."oauthRefreshToken" ("clientId");
create index "oauthRefreshToken_sessionId_idx" on "auth"."oauthRefreshToken" ("sessionId");
create index "oauthRefreshToken_userId_idx" on "auth"."oauthRefreshToken" ("userId");
create index "oauthRefreshToken_authorizationCodeId_idx" on "auth"."oauthRefreshToken" ("authorizationCodeId");
create index "oauthAccessToken_clientId_idx" on "auth"."oauthAccessToken" ("clientId");
create index "oauthAccessToken_sessionId_idx" on "auth"."oauthAccessToken" ("sessionId");
create index "oauthAccessToken_userId_idx" on "auth"."oauthAccessToken" ("userId");
create index "oauthAccessToken_authorizationCodeId_idx" on "auth"."oauthAccessToken" ("authorizationCodeId");
create index "oauthAccessToken_refreshId_idx" on "auth"."oauthAccessToken" ("refreshId");
create index "oauthConsent_clientId_idx" on "auth"."oauthConsent" ("clientId");
create index "oauthConsent_userId_idx" on "auth"."oauthConsent" ("userId");
create unique index "oauthClientResource_clientId_resourceId_uidx" on "auth"."oauthClientResource" ("clientId", "resourceId");

-- storeTenantId: the one Better Auth user each store gets for "Sign in with your website".
CREATE UNIQUE INDEX "user_storeTenantId_uidx" ON auth."user" ("storeTenantId") WHERE "storeTenantId" IS NOT NULL;

-- The storefront (product:<id>, admin:<id>) or store (tenant:<id>) picked for a sign-in a session is
-- in the middle of; the plugin's consent takes it as its reference. Kept only while that sign-in runs.
CREATE TABLE oauth_connect_picks (
  session_id text PRIMARY KEY,
  reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "Sign in with your website" waiting for the store's wp-admin to answer: the plugin's signed request
-- and the store. Ten minutes, one use.
CREATE TABLE oauth_site_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_query text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_name text NOT NULL,
  write boolean NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Apps that registered with the old code keep their client ids (HighLevel's is in its app settings, and
-- connected apps keep theirs): each becomes a public client of the plugin with the same redirect URIs.
INSERT INTO auth."oauthClient" ("clientId", "name", "redirectUris", "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "applicationType", "requirePKCE", "disabled", "createdAt", "updatedAt")
SELECT c.id::text, COALESCE(c.client_name, 'An MCP client'), to_jsonb(c.redirect_uris), 'none', '["authorization_code", "refresh_token"]'::jsonb, '["code"]'::jsonb,
       CASE WHEN EXISTS (SELECT 1 FROM unnest(c.redirect_uris) u WHERE u NOT LIKE 'https://%') THEN 'native' ELSE 'web' END,
       true, false, c.created_at, c.created_at
  FROM oauth_clients c
ON CONFLICT ("clientId") DO NOTHING;

-- Down Migration
DROP TABLE oauth_site_requests;
DROP TABLE oauth_connect_picks;
DROP TABLE auth."oauthClientAssertion";
DROP TABLE auth."oauthConsent";
DROP TABLE auth."oauthAccessToken";
DROP TABLE auth."oauthRefreshToken";
DROP TABLE auth."oauthClientResource";
DROP TABLE auth."oauthResource";
DROP TABLE auth."oauthClient";
DROP TABLE auth."jwks";
ALTER TABLE auth."user" DROP COLUMN "storeTenantId";

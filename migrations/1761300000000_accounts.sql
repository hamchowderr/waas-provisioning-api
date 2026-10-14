-- Up Migration
-- Sign-in for people (src/auth.ts, docs/accounts.md). These are Better Auth 1.7's tables for its
-- core and organization plugin, as its schema generator writes them (camelCase columns), in their
-- own `auth` schema. Two changes of ours: each organization belongs to one product, and an
-- invitation's inviter may be empty, for invitations the platform admin sends.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth."user" ("id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL UNIQUE, "emailVerified" boolean NOT NULL, "image" text, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL);

CREATE TABLE auth."session" ("id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, "expiresAt" timestamptz NOT NULL, "token" text NOT NULL UNIQUE, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz NOT NULL, "ipAddress" text, "userAgent" text, "userId" uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE, "activeOrganizationId" text);

CREATE TABLE auth."account" ("id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL, "userId" uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz NOT NULL);

CREATE TABLE auth."verification" ("id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, "identifier" text NOT NULL, "value" text NOT NULL, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL);

-- productId: one organization per product; deleting the product deletes its organization.
CREATE TABLE auth."organization" ("id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, "name" text NOT NULL, "slug" text NOT NULL UNIQUE, "logo" text, "createdAt" timestamptz NOT NULL, "metadata" text, "productId" uuid NOT NULL UNIQUE REFERENCES public.products (id) ON DELETE CASCADE);

CREATE TABLE auth."member" ("id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, "organizationId" uuid NOT NULL REFERENCES auth."organization" ("id") ON DELETE CASCADE, "userId" uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE, "role" text NOT NULL, "createdAt" timestamptz NOT NULL);

-- inviterId is empty for invitations the platform admin sends (POST /admin/products/:id/invitations).
CREATE TABLE auth."invitation" ("id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, "organizationId" uuid NOT NULL REFERENCES auth."organization" ("id") ON DELETE CASCADE, "email" text NOT NULL, "role" text, "status" text NOT NULL, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "inviterId" uuid REFERENCES auth."user" ("id") ON DELETE CASCADE);

CREATE INDEX "session_userId_idx" ON auth."session" ("userId");
CREATE INDEX "account_userId_idx" ON auth."account" ("userId");
CREATE INDEX "verification_identifier_idx" ON auth."verification" ("identifier");
CREATE INDEX "member_organizationId_idx" ON auth."member" ("organizationId");
CREATE INDEX "member_userId_idx" ON auth."member" ("userId");
CREATE UNIQUE INDEX "member_organization_user" ON auth."member" ("organizationId", "userId");
CREATE INDEX "invitation_organizationId_idx" ON auth."invitation" ("organizationId");
CREATE INDEX "invitation_email_idx" ON auth."invitation" ("email");

-- Down Migration
DROP SCHEMA auth CASCADE;

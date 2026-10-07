export interface Config {
  databaseUrl: string;
  port: number;
  /** Parent domain of each store's base domain: t-<id8>.<storesDomain>. */
  storesDomain: string;
  /** Parent domain of each version's domain: <slug>.<versionsDomain>. */
  versionsDomain: string;
  /** 32 random bytes, base64. Encrypts the values stores need back in plain form (src/secrets.ts). */
  secretsKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const secretsKey = env.SECRETS_KEY;
  if (!secretsKey) throw new Error('SECRETS_KEY is required (32 random bytes, base64: openssl rand -base64 32)');
  return {
    databaseUrl,
    port: Number(env.PORT ?? 4111),
    storesDomain: env.STORES_DOMAIN ?? 'stores.waas.example',
    versionsDomain: env.VERSIONS_DOMAIN ?? 'versions.waas.example',
    secretsKey,
  };
}

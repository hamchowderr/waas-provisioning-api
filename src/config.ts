export interface Config {
  databaseUrl: string;
  port: number;
  /** Parent domain of each store's base domain: t-<id8>.<storesDomain>. */
  storesDomain: string;
  /** Parent domain of each version's domain: <slug>.<versionsDomain>. */
  versionsDomain: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    port: Number(env.PORT ?? 4111),
    storesDomain: env.STORES_DOMAIN ?? 'stores.waas.example',
    versionsDomain: env.VERSIONS_DOMAIN ?? 'versions.waas.example',
  };
}

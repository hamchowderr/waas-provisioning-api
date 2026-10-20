import { S3, type S3Config } from './provisioner/s3.ts';

/**
 * Releases of our WordPress plugins (waas-hw4). waas-plugins' release workflow builds each plugin,
 * signs it and uploads it to the releases bucket:
 *
 *   releases/<slug>/<version>/<slug>.zip
 *   releases/<slug>/<version>/manifest.json   (ReleaseManifest)
 *   releases/<slug>/channels/<channel>.json   (a copy of the manifest the channel points at)
 *
 * The API only reads the bucket. It never signs anything: the plugin checks the sha256 and the
 * ed25519 signature against the public keys built into it, so a bad manifest here can't make a
 * site install a package we didn't sign.
 */

export const PLUGIN_SLUGS = ['wpcs-waas-host', 'wpcs-waas-client', 'waas-payments', 'anypress-export'] as const;
export type PluginSlug = (typeof PLUGIN_SLUGS)[number];
export const isPluginSlug = (value: string): value is PluginSlug => (PLUGIN_SLUGS as readonly string[]).includes(value);

export const CHANNELS = ['stable', 'beta'] as const;
export type Channel = (typeof CHANNELS)[number];
export const isChannel = (value: string): value is Channel => (CHANNELS as readonly string[]).includes(value);

/** 1.2.3 or 1.2.3-beta.4: what the release workflow accepts in a tag. */
export const RELEASE_VERSION = /^\d+\.\d+\.\d+(-beta\.\d+)?$/;

export interface ReleaseManifest {
  slug: PluginSlug;
  version: string;
  /** Bucket key of the zip. */
  zip: string;
  sha256: string;
  /** base64 ed25519 signature of "waas-release-v1\n<slug>\n<version>\n<sha256>". */
  signature: string;
  requires?: string;
  requiresPhp?: string;
  tested?: string;
  releasedAt?: string;
  changelog?: string;
}

const optionalString = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);

/** Checks a manifest read from the bucket; null when it is malformed or isn't for this slug. */
export function parseManifest(raw: unknown, slug: PluginSlug, version?: string): ReleaseManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = raw as Record<string, any>;
  if (m.slug !== slug) return null;
  if (typeof m.version !== 'string' || !RELEASE_VERSION.test(m.version)) return null;
  if (version !== undefined && m.version !== version) return null;
  if (m.zip !== `releases/${slug}/${m.version}/${slug}.zip`) return null;
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return null;
  if (typeof m.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(m.signature)) return null;
  return {
    slug,
    version: m.version,
    zip: m.zip,
    sha256: m.sha256,
    signature: m.signature,
    requires: optionalString(m.requires, 16),
    requiresPhp: optionalString(m.requiresPhp, 16),
    tested: optionalString(m.tested, 16),
    releasedAt: optionalString(m.releasedAt, 40),
    changelog: optionalString(m.changelog, 20000),
  };
}

export interface ReleaseStore {
  /** The parsed JSON object at `key`, or null when there is none. */
  getJson(key: string): Promise<unknown | null>;
  /** A URL anyone can GET for `expiresIn` seconds. */
  presignGet(key: string, expiresIn: number): string;
}

export const channelKey = (slug: PluginSlug, channel: Channel) => `releases/${slug}/channels/${channel}.json`;
export const manifestKey = (slug: PluginSlug, version: string) => `releases/${slug}/${version}/manifest.json`;

/** The releases bucket on R2 (or any S3). Manifests are cached for a minute, so checks rarely reach the bucket. */
export class S3ReleaseStore implements ReleaseStore {
  private readonly s3: S3;
  private readonly cache = new Map<string, { at: number; value: unknown | null }>();

  constructor(
    config: S3Config,
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
  ) {
    this.s3 = new S3(config, fetchImpl);
  }

  async getJson(key: string): Promise<unknown | null> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const bytes = await this.s3.getIfExists(key);
    let value: unknown | null = null;
    if (bytes) {
      try {
        value = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        value = null;
      }
    }
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  presignGet(key: string, expiresIn: number): string {
    return this.s3.presign('GET', key, expiresIn);
  }
}

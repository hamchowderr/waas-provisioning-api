import { Hono } from 'hono';
import type { AppEnv, Deps } from '../app.ts';
import { HttpError, badRequest } from '../errors.ts';
import { compact } from '../http.ts';
import { channelKey, isChannel, isPluginSlug, manifestKey, parseManifest } from '../releases.ts';

/** How long a package URL works. The plugin asks again just before it downloads. */
export const PACKAGE_URL_TTL = 600;

const INSTALLED_VERSION = /^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/;
const PLATFORM_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

/** The site's URL as reported, kept to scheme, lowercase host, port and path. */
function siteQuery(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('site must be an http(s) URL');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || value.length > 255) throw badRequest('site must be an http(s) URL');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
}

const platform = (value: string | undefined) => (value && PLATFORM_VERSION.test(value) ? value : null);

/**
 * Update checks from our plugins (waas-hw4). Outside the WPCS contract; described in
 * openapi/plugin-updates.yaml. A storefront asks with its own API key and gets the release its
 * channel (or its pin) points at, with a short-lived package URL. Each check records the version
 * the site runs.
 */
export function pluginRoutes({ pool, releases }: Deps) {
  const app = new Hono<AppEnv>();

  app.get('/:slug/update', async (c) => {
    const slug = c.req.param('slug');
    if (!isPluginSlug(slug)) throw new HttpError(404, `Unknown plugin ${slug}`);
    const channel = c.req.query('channel') || 'stable';
    if (!isChannel(channel)) throw badRequest('channel must be stable or beta');
    const version = c.req.query('version') ?? '';
    if (!INSTALLED_VERSION.test(version) || version.length > 32) throw badRequest('version is required: the installed version, like 2.3.0');
    const site = siteQuery(c.req.query('site'));
    const productId = c.get('productId');

    await pool.query(
      `INSERT INTO plugin_installs (product_id, slug, site, version, channel, wp_version, php_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (product_id, slug, site) DO UPDATE
         SET version = EXCLUDED.version, channel = EXCLUDED.channel, wp_version = EXCLUDED.wp_version,
             php_version = EXCLUDED.php_version, last_seen = now()`,
      [productId, slug, site, version, channel, platform(c.req.query('wp')), platform(c.req.query('php'))],
    );

    if (!releases) throw new HttpError(503, 'Plugin updates are not configured');

    const pin = (await pool.query<{ version: string }>('SELECT version FROM plugin_pins WHERE product_id = $1 AND slug = $2', [productId, slug])).rows[0];
    let raw: unknown;
    try {
      raw = await releases.getJson(pin ? manifestKey(slug, pin.version) : channelKey(slug, channel));
    } catch (err) {
      console.error(`Reading the ${slug} release failed: ${(err as Error).message}`);
      throw new HttpError(503, 'The release store is unavailable');
    }
    const manifest = parseManifest(raw, slug, pin?.version);
    if (!manifest) {
      if (raw !== null) console.error(`The ${slug} ${pin ? `${pin.version} manifest` : `${channel} channel`} is malformed`);
      throw new HttpError(404, pin ? `Release ${pin.version} of ${slug} not found` : `No ${channel} release of ${slug}`);
    }

    return c.json(
      compact({
        slug,
        version: manifest.version,
        channel,
        pinned: Boolean(pin),
        package: releases.presignGet(manifest.zip, PACKAGE_URL_TTL),
        packageExpiresIn: PACKAGE_URL_TTL,
        sha256: manifest.sha256,
        signature: manifest.signature,
        requires: manifest.requires,
        requiresPhp: manifest.requiresPhp,
        tested: manifest.tested,
        releasedAt: manifest.releasedAt,
        changelog: manifest.changelog,
      }),
    );
  });

  return app;
}

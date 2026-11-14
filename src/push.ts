import webpush from 'web-push';
import type { Pool } from './db.ts';
import { badRequest } from './errors.ts';

/**
 * Phone and computer alerts for the bell's important notices (docs/notifications.md), with Web Push:
 * each device that turns alerts on in the dashboard saves its push subscription here, and the API
 * sends it the notice, signed with the VAPID keys (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY; unset, push
 * is off). A storefront's team gets that storefront's; platform admins get every one.
 */

/** The notices worth interrupting someone for. The rest stay in the bell. */
const PUSH_TYPES = new Set(['tenant.ready', 'tenant.failed', 'tenant.backup_failed', 'version.failed', 'application.received', 'restore_test.failed']);

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  /** The dashboard's address (AUTH_URL), for each alert's link. */
  dashboardUrl?: string;
}

export function loadPushConfig(env: Record<string, string | undefined>, dashboardUrl?: string): PushConfig | undefined {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey && !privateKey) return undefined;
  if (!publicKey || !privateKey) throw new Error('Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither');
  return { publicKey, privateKey, dashboardUrl };
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

type Send = (sub: PushSubscription, payload: string, config: PushConfig) => Promise<{ statusCode: number }>;

const defaultSend: Send = (sub, payload, config) =>
  webpush.sendNotification(sub, payload, {
    vapidDetails: { subject: 'mailto:support@anypress.io', publicKey: config.publicKey, privateKey: config.privateKey },
    TTL: 24 * 60 * 60,
    urgency: 'normal',
    timeout: 10_000,
  });

let current: { config: PushConfig; send: Send } | undefined;

/** Turns push on (main.ts), or off with undefined. Tests pass their own `send`. */
export function configurePush(config: PushConfig | undefined, send: Send = defaultSend): void {
  current = config ? { config, send } : undefined;
}

export function pushPublicKey(): string | null {
  return current?.config.publicKey ?? null;
}

/** Checks what the browser's PushManager gave the dashboard. */
export function parseSubscription(value: unknown): PushSubscription {
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = typeof v?.endpoint === 'string' ? v.endpoint : '';
  let url: URL | null;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || endpoint.length > 1000) throw badRequest('subscription.endpoint must be an https URL');
  const { p256dh, auth } = v?.keys ?? {};
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    throw badRequest('subscription.keys must have p256dh and auth');
  }
  return { endpoint, keys: { p256dh, auth } };
}

export async function savePushSubscription(pool: Pool, userId: string, admin: boolean, sub: PushSubscription): Promise<void> {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, admin) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4, admin = $5`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, admin],
  );
}

export async function removePushSubscription(pool: Pool, userId: string, endpoint: string): Promise<void> {
  await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

/** Where an alert opens, as the bell's rows do (the dashboard's lib/notifications.ts). */
function alertPath(n: { type: string; tenantId?: string | null; versionId?: string | null; applicationId?: string | null }): string {
  if (n.applicationId) return `/applications/${n.applicationId}`;
  if (n.type === 'restore_test.failed') return '/backups';
  if (n.tenantId && n.type !== 'tenant.deleted') return `/stores/${n.tenantId}`;
  if (n.versionId) return '/versions';
  return '/';
}

export interface PushNotice {
  id: string;
  type: string;
  title: string;
  productId: string | null;
  tenantId?: string | null;
  versionId?: string | null;
  applicationId?: string | null;
}

/**
 * Sends a notice to every device that should hear about it: platform admins' always, and for a
 * storefront's notice its team's (its own team and its reseller's). A gone subscription (404, 410)
 * is removed. Returns how many were sent. Never throws.
 */
export async function pushNotice(pool: Pool, notice: PushNotice): Promise<number> {
  if (!current || !PUSH_TYPES.has(notice.type)) return 0;
  const { config, send } = current;
  try {
    const { rows } = await pool.query<{ id: string; endpoint: string; p256dh: string; auth: string; product_name: string | null }>(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth, (SELECT name FROM products WHERE id = $1) AS product_name
         FROM push_subscriptions s
        WHERE s.admin
           OR ($1::uuid IS NOT NULL AND EXISTS (
                SELECT 1 FROM auth.member m JOIN auth.organization o ON o.id = m."organizationId"
                  JOIN products p ON p.id = o."productId" OR p.reseller_id = o."resellerId"
                 WHERE m."userId" = s.user_id AND p.id = $1))`,
      [notice.productId],
    );
    let sent = 0;
    for (const row of rows) {
      const url = new URL(alertPath(notice), config.dashboardUrl ?? 'https://app.anypress.io').toString();
      const payload = JSON.stringify({ id: notice.id, title: notice.title, body: row.product_name ?? 'AnyPress', url, tag: notice.type });
      try {
        await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, config);
        sent++;
        await pool.query('UPDATE push_subscriptions SET last_sent_at = now() WHERE id = $1', [row.id]);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
        else console.error(`push: alert ${notice.id} not sent: ${(err as Error).message}`);
      }
    }
    return sent;
  } catch (err) {
    console.error(`push: alert ${notice.id} not sent: ${(err as Error).message}`);
    return 0;
  }
}

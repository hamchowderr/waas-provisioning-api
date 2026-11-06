import { Hono, type Context } from 'hono';
import type { AppEnv } from './app.ts';
import type { Pool } from './db.ts';
import { badRequest } from './errors.ts';
import { isUuid, readJson, scopedProduct } from './http.ts';
import type { EventType } from './webhooks.ts';

/**
 * The dashboard's bell (docs/notifications.md): the store and version events worth a person's look,
 * kept for each storefront's team, plus platform ones (a new application, a failed restore test) for
 * the platform admin. Recorded beside the webhook events (src/webhooks.ts) whether or not the
 * storefront has endpoints. Each person has one "read up to" time, set when they open the bell.
 */

export type NotificationLevel = 'success' | 'error' | 'info';

/** The events that make a notification, and how each reads. Rollout moves and small updates don't. */
const TITLES: Partial<Record<EventType, { level: NotificationLevel; title: (name: string) => string }>> = {
  'tenant.ready': { level: 'success', title: (n) => `${n} is ready` },
  'tenant.live': { level: 'success', title: (n) => `${n} is live` },
  'tenant.restored': { level: 'success', title: (n) => `${n} was restored from a backup` },
  'tenant.rolled_back': { level: 'info', title: (n) => `${n} was rolled back` },
  'tenant.suspended': { level: 'info', title: (n) => `${n} was taken offline` },
  'tenant.resumed': { level: 'success', title: (n) => `${n} is back online` },
  'tenant.deleted': { level: 'info', title: (n) => `${n} was deleted` },
  'tenant.failed': { level: 'error', title: (n) => `A job on ${n} failed` },
  'tenant.backup_failed': { level: 'error', title: (n) => `A backup of ${n} failed` },
  'version.ready': { level: 'success', title: (n) => `Version ${n} is ready` },
  'version.failed': { level: 'error', title: (n) => `Version ${n} failed` },
};

const PLATFORM: Record<string, NotificationLevel> = {
  'application.received': 'info',
  'restore_test.failed': 'error',
};

export function levelOf(type: string): NotificationLevel {
  return TITLES[type as EventType]?.level ?? PLATFORM[type] ?? 'info';
}

/** Days notifications are kept. */
export const NOTIFICATION_DAYS = 30;

export interface NewNotification {
  productId: string | null;
  type: string;
  title: string;
  tenantId?: string | null;
  versionId?: string | null;
  applicationId?: string | null;
}

export async function recordNotification(pool: Pool, n: NewNotification): Promise<void> {
  await pool.query('INSERT INTO notifications (product_id, type, title, tenant_id, version_id, application_id) VALUES ($1, $2, $3, $4, $5, $6)', [
    n.productId,
    n.type,
    n.title.slice(0, 300),
    n.tenantId ?? null,
    n.versionId ?? null,
    n.applicationId ?? null,
  ]);
}

/** Records a store or version event when it is one people want to hear about. */
export async function notifyEvent(
  pool: Pool,
  productId: string,
  type: EventType,
  subject: { tenant?: { id?: string; name?: string | null; domainName?: string | null }; version?: { id?: string; name?: string | null } },
): Promise<void> {
  const entry = TITLES[type];
  if (!entry) return;
  const name = subject.tenant
    ? (subject.tenant.name || subject.tenant.domainName || 'A store')
    : (subject.version?.name || 'A version');
  await recordNotification(pool, {
    productId,
    type,
    title: entry.title(name),
    tenantId: subject.tenant?.id ?? null,
    versionId: subject.version?.id ?? null,
  });
}

export async function pruneNotifications(pool: Pool, days = NOTIFICATION_DAYS): Promise<number> {
  const { rowCount } = await pool.query('DELETE FROM notifications WHERE at < now() - make_interval(days => $1)', [days]);
  return rowCount ?? 0;
}

/**
 * Whose bell: a signed-in customer's own session, or for the platform admin (the admin token) the
 * person the dashboard names with `userId`.
 */
function reader(c: Context<AppEnv>, given: unknown): string {
  const own = c.get('userId') as string | undefined;
  if (scopedProduct(c) && own) return own;
  if (typeof given !== 'string' || !isUuid(given)) throw badRequest('userId must be a user id');
  return given;
}

/** GET /notifications and POST /notifications/read, mounted in adminRoutes (so on /admin and /account). */
export function notificationRoutes(pool: Pool) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const userId = reader(c, c.req.query('userId'));
    const raw = Number(c.req.query('limit') ?? 20);
    const limit = Number.isInteger(raw) ? Math.min(50, Math.max(1, raw)) : 20;
    // A customer sees their storefront's; the platform admin sees every storefront's and the platform's.
    const scope = scopedProduct(c);
    const { rows: reads } = await pool.query('SELECT read_until FROM notification_reads WHERE user_id = $1', [userId]);
    const readUntil: Date | null = reads[0]?.read_until ?? null;
    const [{ rows }, { rows: counts }] = await Promise.all([
      pool.query(
        `SELECT n.*, p.name AS product_name FROM notifications n LEFT JOIN products p ON p.id = n.product_id
          WHERE ($1::uuid IS NULL OR n.product_id = $1) ORDER BY n.at DESC, n.id LIMIT $2`,
        [scope, limit],
      ),
      pool.query(
        `SELECT count(*)::int AS n FROM notifications
          WHERE ($1::uuid IS NULL OR product_id = $1) AND ($2::timestamptz IS NULL OR at > $2)`,
        [scope, readUntil],
      ),
    ]);
    return c.json({
      unread: Math.min(99, counts[0].n as number),
      readUntil: readUntil ? readUntil.toISOString() : null,
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        level: levelOf(r.type),
        title: r.title,
        productId: r.product_id,
        productName: r.product_name ?? null,
        tenantId: r.tenant_id,
        versionId: r.version_id,
        applicationId: r.application_id,
        at: r.at.toISOString(),
        unread: !readUntil || r.at > readUntil,
      })),
    });
  });

  // Marks everything up to now as read. Allowed for members too: it changes only their own bell.
  app.post('/read', async (c) => {
    const body = (await readJson(c)) as { userId?: unknown };
    const userId = reader(c, body.userId);
    await pool.query(
      `INSERT INTO notification_reads (user_id, read_until) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET read_until = now()`,
      [userId],
    );
    return c.json({ readUntil: new Date().toISOString() });
  });

  return app;
}

import { randomBytes, randomUUID, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { withTransaction, type Client, type Pool } from './db.ts';
import { conflict, HttpError } from './errors.ts';

// Secrets are stored as scrypt hashes: "scrypt$N$r$p$<salt b64>$<hash b64>".
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

function scryptAsync(secret: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(secret, salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(secret, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Hashed once so an unknown key costs the same time as a wrong secret.
const dummyHash = hashSecret(randomUUID());

/**
 * Who a key belongs to: a product (storefront), given as its id, or a reseller, whose partner key
 * works on all its storefronts (docs/resellers.md).
 */
export type KeyOwner = string | { resellerId: string };

function owner(o: KeyOwner) {
  return typeof o === 'string'
    ? { column: 'product_id', table: 'products', id: o, noun: 'Product', what: 'A storefront' }
    : { column: 'reseller_id', table: 'resellers', id: o.resellerId, noun: 'Reseller', what: 'A reseller' };
}

/** Creates an API key for a product or reseller. The secret is returned once and only its hash is kept. */
export async function createApiKey(db: Pool | Client, keyOwner: KeyOwner, label?: string | null): Promise<{ key: string; secret: string }> {
  const secret = randomBytes(32).toString('base64url');
  const o = owner(keyOwner);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO api_keys (${o.column}, secret_hash, label) VALUES ($1, $2, $3) RETURNING id`,
    [o.id, await hashSecret(secret), label ?? null],
  );
  return { key: rows[0]!.id, secret };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who a working key belongs to: exactly one of the two is set. */
export interface KeyCaller {
  productId: string | null;
  resellerId: string | null;
}

/**
 * Returns the product the key belongs to, or null when the key or secret is wrong, or the key is
 * revoked. A partner key (a reseller's) is null here too: only /v1 accepts those (authenticateKey).
 */
export async function authenticate(pool: Pool, key: string, secret: string): Promise<string | null> {
  return (await authenticateKey(pool, key, secret))?.productId ?? null;
}

/**
 * Returns who the key belongs to, or null when the key or secret is wrong, or the key is revoked.
 * A rotated key whose revoked_at is still in the future keeps working until then.
 */
export async function authenticateKey(pool: Pool, key: string, secret: string): Promise<KeyCaller | null> {
  const { rows } = UUID.test(key)
    ? await pool.query<{ product_id: string | null; reseller_id: string | null; secret_hash: string }>(
        'SELECT product_id, reseller_id, secret_hash FROM api_keys WHERE id = $1 AND (revoked_at IS NULL OR revoked_at > now())',
        [key],
      )
    : { rows: [] };
  const row = rows[0];
  const ok = await verifySecret(secret, row?.secret_hash ?? (await dummyHash));
  if (!ok || !row) return null;
  // At most one write a minute per key, so busy keys don't write on every call.
  await pool
    .query("UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [key])
    .catch((err) => console.error('Could not record API key use', err));
  return { productId: row.product_id, resellerId: row.reseller_id };
}

// Self-service key management: the admin API (any product) and /v1/keys (the caller's own product)
// share these. A secret appears only in the response that creates it; nothing logs it.

/** The most keys a product (or reseller) may have that still work (active or rotated but not yet expired). */
export const MAX_LIVE_KEYS = 20;
/** The longest a rotated key may keep working: 30 days. */
export const MAX_GRACE_HOURS = 720;
const MAX_LABEL = 100;

export type KeyState = 'active' | 'expiring' | 'revoked';

export interface ApiKeyInfo {
  id: string;
  label: string | null;
  state: KeyState;
  dateCreated: string;
  lastUsedAt: string | null;
  /** When the key stops (stopped) working; null while active. In the future while expiring. */
  revokedAt: string | null;
}

export type NewApiKey = ApiKeyInfo & { secret: string };

const KEY_COLUMNS = `id, label, created_at, last_used_at, revoked_at,
  CASE WHEN revoked_at IS NULL THEN 'active' WHEN revoked_at > now() THEN 'expiring' ELSE 'revoked' END AS state`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toInfo = (r: any): ApiKeyInfo => ({
  id: r.id,
  label: r.label,
  state: r.state,
  dateCreated: new Date(r.created_at).toISOString(),
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
});

/** A key's label from a request body: optional, trimmed, at most 100 characters. */
export function parseLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'label must be a string');
  const label = value.trim();
  if (label.length > MAX_LABEL) throw new HttpError(400, `label can be at most ${MAX_LABEL} characters`);
  return label || null;
}

/** graceHours from a rotate request: whole hours, 0 to 720; 24 when absent. */
export function parseGraceHours(value: unknown): number {
  if (value === undefined || value === null) return 24;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_GRACE_HOURS) {
    throw new HttpError(400, `graceHours must be a whole number from 0 to ${MAX_GRACE_HOURS}`);
  }
  return value;
}

/**
 * A product's keys, newest first: every working key, and those revoked in the last 30 days so a
 * recent revocation can still be seen. Never secrets or hashes.
 */
export async function listApiKeys(pool: Pool, keyOwner: KeyOwner): Promise<ApiKeyInfo[]> {
  const o = owner(keyOwner);
  const { rows } = await pool.query(
    `SELECT ${KEY_COLUMNS} FROM api_keys
      WHERE ${o.column} = $1 AND (revoked_at IS NULL OR revoked_at > now() - interval '30 days')
      ORDER BY created_at DESC, id`,
    [o.id],
  );
  return rows.map(toInfo);
}

/** Locks the key's owner so concurrent key changes for it run one at a time. */
async function lockOwner(client: Client, keyOwner: KeyOwner): Promise<void> {
  const o = owner(keyOwner);
  const { rowCount } = await client.query(`SELECT 1 FROM ${o.table} WHERE id = $1 FOR UPDATE`, [o.id]);
  if (!rowCount) throw new HttpError(404, `${o.noun} ${o.id} not found`);
}

async function keyRow(client: Client, keyOwner: KeyOwner, keyId: string) {
  const o = owner(keyOwner);
  const { rows } = UUID.test(keyId)
    ? await client.query(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = $1 AND ${o.column} = $2`, [keyId, o.id])
    : { rows: [] };
  if (!rows[0]) throw new HttpError(404, `API key ${keyId} not found`);
  return rows[0];
}

async function insertKey(client: Client, keyOwner: KeyOwner, label: string | null): Promise<NewApiKey> {
  const o = owner(keyOwner);
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM api_keys WHERE ${o.column} = $1 AND (revoked_at IS NULL OR revoked_at > now())`,
    [o.id],
  );
  if (rows[0].n >= MAX_LIVE_KEYS) {
    throw conflict(`${o.what} can have at most ${MAX_LIVE_KEYS} working keys. Revoke one first.`);
  }
  const { key, secret } = await createApiKey(client, keyOwner, label);
  return { ...toInfo((await client.query(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = $1`, [key])).rows[0]), secret };
}

/** Creates a key. The secret is in the result only. */
export function addApiKey(pool: Pool, keyOwner: KeyOwner, label: string | null): Promise<NewApiKey> {
  return withTransaction(pool, async (client) => {
    await lockOwner(client, keyOwner);
    return insertKey(client, keyOwner, label);
  });
}

/**
 * Replaces an active key with a new one under the same label. The old key keeps working for
 * graceHours (0: it stops now), so whatever uses it can switch over first.
 */
export function rotateApiKey(pool: Pool, keyOwner: KeyOwner, keyId: string, graceHours: number): Promise<{ key: NewApiKey; replaced: ApiKeyInfo }> {
  return withTransaction(pool, async (client) => {
    await lockOwner(client, keyOwner);
    const old = await keyRow(client, keyOwner, keyId);
    if (old.state !== 'active') throw conflict('Only an active key can be rotated');
    const { rows } = await client.query(
      `UPDATE api_keys SET revoked_at = now() + make_interval(hours => $2::int) WHERE id = $1 RETURNING ${KEY_COLUMNS}`,
      [keyId, graceHours],
    );
    // Counted after the old key's update, so rotating with no grace works at the limit.
    const key = await insertKey(client, keyOwner, old.label);
    return { key, replaced: toInfo(rows[0]) };
  });
}

/**
 * Revokes a key now; an expiring key stops early. With keepOne (the product's own requests), the
 * last active key can't be revoked, so a storefront can't lock itself out.
 */
export function revokeApiKey(pool: Pool, keyOwner: KeyOwner, keyId: string, { keepOne = false } = {}): Promise<ApiKeyInfo> {
  return withTransaction(pool, async (client) => {
    await lockOwner(client, keyOwner);
    const key = await keyRow(client, keyOwner, keyId);
    if (key.state === 'revoked') return toInfo(key);
    if (keepOne && key.state === 'active') {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM api_keys WHERE ${owner(keyOwner).column} = $1 AND revoked_at IS NULL AND id <> $2`,
        [owner(keyOwner).id, keyId],
      );
      if (rows[0].n === 0) throw conflict('This is the last active key. Create or rotate to a new key before revoking it.');
    }
    const { rows } = await client.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 RETURNING ${KEY_COLUMNS}`, [keyId]);
    return toInfo(rows[0]);
  });
}
